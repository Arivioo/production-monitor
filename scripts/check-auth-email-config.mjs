#!/usr/bin/env node
/**
 * Auth-email config guard.
 *
 * Why this exists: Supabase auth emails are gated by GoTrue's `rate_limit_email_sent`,
 * which DEFAULTS to 2/hour and resets to 2 on (a) project migration to a new ref and
 * (b) partial Management-API PATCHes. Worse, Supabase HARD-CAPS it at 2 unless the
 * project has custom SMTP configured OR a send-email hook enabled. This silently
 * breaks signup/OTP/password-reset for real users and has recurred ≥5 times across
 * projects. Nothing verified it — so it was only ever caught by a human hitting the
 * wall. This guard GETs every project's /config/auth and fails (and emails) if any
 * project is at risk.
 *
 * A project is AT RISK when:
 *   - rate_limit_email_sent <= 2, OR
 *   - neither custom SMTP (smtp_host) nor the send-email hook is configured
 *     (which means it uses Supabase's built-in mailer, hard-capped at 2/hr).
 *
 * Tokens are read from env (one Management-API token per Supabase account):
 *   SUPABASE_TOKEN_MUELLER, _REPLYFLOW, _ARIVIOO, _CHANNELMOVER, _API,
 *   _LAUNCHREADY, _BELEGPILOT, _SIGNALFORGEAI, _DISTRIBUTIONOS, _SCOUTCOPILOT,
 *   _BACKOFFICE, _BOATBUDDY
 * Missing tokens are reported (never silently skipped).
 *
 * Optional email alert: set ALERT_SMTP_HOST, ALERT_SMTP_PORT, ALERT_SMTP_USER,
 * ALERT_SMTP_PASS, ALERT_TO. Exit code is 1 when any project is at risk (or a
 * token is missing), so a scheduled CI run goes red even without email.
 */

const MIN_RATE_LIMIT = 10 // documented minimum (reference_supabase_project_setup.md)

// account env-var suffix -> [{ ref, name }]
const ACCOUNTS = {
  MUELLER: [
    { ref: 'ogdpgufptemcgyszmjek', name: 'SignalScore' },
    { ref: 'blfnyxwcriyxvsaubiqb', name: 'SignalScore Staging' },
  ],
  REPLYFLOW: [
    { ref: 'dqmhsdzldkxngwjrxois', name: 'ReplyFlow' },
    { ref: 'cuvqzwvyovxvvvuddtjd', name: 'ReplyFlow Staging' },
  ],
  ARIVIOO: [{ ref: 'iooexkbuxmeryeuzpxau', name: 'Arivioo' }],
  CHANNELMOVER: [{ ref: 'qswluvqunswggfmesdcs', name: 'ChannelMover' }],
  API: [
    { ref: 'pjsxzjjhlwjqpkvsopuj', name: 'APIs' },
    { ref: 'dkxdlovwzsxnepoteebk', name: 'Beize Jass Tour' },
  ],
  LAUNCHREADY: [{ ref: 'hcfeoescybfngjsphekq', name: 'ShipSolo' }],
  BELEGPILOT: [{ ref: 'lybpfwzpoiutuqggbixg', name: 'BelegPilot' }],
  SIGNALFORGEAI: [{ ref: 'xioqgsybkhjijkciinmu', name: 'SignalForgeAI' }],
  DISTRIBUTIONOS: [
    { ref: 'jxjpbmkgmuunpayqgbsx', name: 'DistributionOS' },
    { ref: 'mkdeftmubrkseyrrbzvp', name: 'Valrano' },
    { ref: 'vfwpcgdkrwqhdivfzmrg', name: 'Valrano Staging' },
  ],
  SCOUTCOPILOT: [{ ref: 'rlcsuqwqzoqjykdiqjye', name: 'ScoutCopilot' }],
  BACKOFFICE: [
    { ref: 'xoecpzfsskalvjrtcbbl', name: 'BackOffice' },
    { ref: 'vvgqkwiqauafcflshsec', name: 'BackOffice Staging' },
  ],
  BOATBUDDY: [
    { ref: 'xzythvxmuxmczuiophwp', name: 'BoatBuddy' },
    { ref: 'svpewgbwousyheohlrtt', name: 'BoatBuddy Staging' },
  ],
}

async function getAuthConfig(ref, token) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function evaluate(cfg) {
  const rate = cfg.rate_limit_email_sent
  const hasCustomDelivery = Boolean(cfg.smtp_host) || cfg.hook_send_email_enabled === true
  const reasons = []
  if (typeof rate !== 'number' || rate < MIN_RATE_LIMIT) reasons.push(`rate_limit_email_sent=${rate} (< ${MIN_RATE_LIMIT})`)
  if (!hasCustomDelivery) reasons.push('no custom SMTP and no send-email hook (built-in mailer → hard-capped at 2/hr)')
  return reasons
}

async function main() {
  const violations = []
  const missingTokens = []
  const rows = []

  for (const [acct, projects] of Object.entries(ACCOUNTS)) {
    const token = process.env[`SUPABASE_TOKEN_${acct}`]
    if (!token) {
      for (const p of projects) missingTokens.push(`${p.name} (account ${acct})`)
      continue
    }
    for (const p of projects) {
      try {
        const cfg = await getAuthConfig(p.ref, token)
        const reasons = evaluate(cfg)
        rows.push({ name: p.name, rate: cfg.rate_limit_email_sent, smtp: cfg.smtp_host || 'null', hook: cfg.hook_send_email_enabled, ok: reasons.length === 0 })
        if (reasons.length) violations.push({ project: p.name, testName: 'auth-email config', error: reasons.join('; ') })
      } catch (err) {
        rows.push({ name: p.name, rate: '?', smtp: '?', hook: '?', ok: false })
        violations.push({ project: p.name, testName: 'auth-email config', error: `lookup failed: ${err.message}` })
      }
    }
  }

  // Report
  console.log('PROJECT'.padEnd(22), 'RATE'.padEnd(5), 'SMTP'.padEnd(22), 'HOOK'.padEnd(6), 'STATUS')
  for (const r of rows) {
    console.log(String(r.name).padEnd(22), String(r.rate).padEnd(5), String(r.smtp).padEnd(22), String(r.hook).padEnd(6), r.ok ? 'OK' : '*** AT RISK ***')
  }
  if (missingTokens.length) {
    console.log('\nUNAUDITED (missing SUPABASE_TOKEN_* secret):')
    for (const m of missingTokens) console.log('  -', m)
  }

  // Optional email alert (self-contained; red CI run is the primary alert)
  if (violations.length && process.env.ALERT_SMTP_HOST) {
    try {
      const nodemailer = await import('nodemailer')
      const t = nodemailer.createTransport({
        host: process.env.ALERT_SMTP_HOST,
        port: Number(process.env.ALERT_SMTP_PORT || 465),
        secure: true,
        auth: { user: process.env.ALERT_SMTP_USER, pass: process.env.ALERT_SMTP_PASS },
      })
      const list = violations.map((v) => `<li><b>${v.project}</b>: ${v.error}</li>`).join('')
      await t.sendMail({
        from: `Auth Config Guard <${process.env.ALERT_SMTP_USER}>`,
        to: process.env.ALERT_TO,
        subject: `[ALERT] ${violations.length} Supabase project(s) with at-risk auth-email config`,
        html: `<p>${violations.length} project(s) at risk of the 2/hour auth-email cap:</p><ul>${list}</ul><p>Fix: configure custom SMTP (or send-email hook) + set rate_limit_email_sent &ge; ${MIN_RATE_LIMIT} via the Management API.</p>`,
      })
    } catch (e) {
      console.error('alert email failed:', e.message)
    }
  }

  if (violations.length || missingTokens.length) {
    console.error(`\nFAIL: ${violations.length} project(s) at risk, ${missingTokens.length} unaudited.`)
    process.exit(1)
  }
  console.log('\nAll audited projects OK.')
}

main()
