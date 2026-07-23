#!/usr/bin/env node
/**
 * Fleet pg_cron heartbeat — the dead-man's switch for every product's scheduled jobs.
 *
 * The products' own watchdogs (e.g. ReplyFlow monitor-sync-health) detect and
 * auto-fix their domain problems — but a watchdog that STOPS RUNNING is
 * indistinguishable from health from the inside. This check asks each prod
 * Supabase project, from the outside: "did every active cron job actually run
 * (and succeed) recently?" — where "recently" is derived from the job's own
 * schedule (3× its interval, with floors), so only a PERSISTENTLY dead job
 * fires, never a single missed tick (alerting philosophy 2026-07-23:
 * auto-fix first, alert only what stays broken, transient = noise).
 *
 * Healing stays product-local by design — this layer only answers
 * "is anyone watching the watchers?". Nightly; a red run IS the alert
 * (send-heartbeat-alert.mjs mails the findings), so max one email/day.
 *
 * Known limitation: net.http_post-based crons count as 'succeeded' once the
 * HTTP call is dispatched, even if the edge function errors — function-level
 * failures are the product watchdogs' job, not this one.
 *
 * Uses the Supabase Management API query endpoint with per-product PATs
 * (same contract as check-drift.mjs). Read-only. Projects without pg_cron
 * (LaunchReady, Distribution-OS, BoatBuddy, Beize Jass, ScoutCopilot as of
 * 2026-07-23) are deliberately absent.
 */

import { writeFileSync } from 'node:fs'

const PRODUCTS = [
  { name: 'ReplyFlow',    patEnv: 'SUPABASE_TOKEN_REPLYFLOW',    ref: 'dqmhsdzldkxngwjrxois' },
  { name: 'BackOffice',   patEnv: 'SUPABASE_TOKEN_BACKOFFICE',   ref: 'xoecpzfsskalvjrtcbbl' },
  { name: 'SignalScore',  patEnv: 'SUPABASE_TOKEN_MUELLER',      ref: 'ogdpgufptemcgyszmjek' },
  { name: 'ChannelMover', patEnv: 'SUPABASE_TOKEN_CHANNELMOVER', ref: 'qswluvqunswggfmesdcs' },
  { name: 'Arivioo',      patEnv: 'SUPABASE_TOKEN_ARIVIOO',      ref: 'iooexkbuxmeryeuzpxau' },
  { name: 'Valrano',      patEnv: 'SUPABASE_TOKEN_VALRANO',      ref: 'mkdeftmubrkseyrrbzvp' },
]

// One row per active job: schedule + most recent success + most recent outcome.
// job_run_details is bounded to 35 days so the aggregate stays cheap even on
// */2-minute jobs; 35d still covers a monthly job's largest legitimate gap.
const HEARTBEAT_SQL = `
  select j.jobname, j.schedule,
    max(d.start_time) filter (where d.status = 'succeeded') as last_success,
    max(d.start_time) as last_run,
    (select d2.status || coalesce(': ' || left(d2.return_message, 200), '')
       from cron.job_run_details d2
      where d2.jobid = j.jobid order by d2.start_time desc limit 1) as last_result
  from cron.job j
  left join cron.job_run_details d
    on d.jobid = j.jobid and d.start_time > now() - interval '35 days'
  where j.active
  group by j.jobid, j.jobname, j.schedule
  order by j.jobname`

/** Max tolerated age of the last SUCCESSFUL run, derived from the cron schedule.
 *  3× the interval (with floors) = several consecutive misses, never one blip. */
function allowanceMs(schedule) {
  const parts = String(schedule).trim().split(/\s+/)
  if (parts.length !== 5) return 26 * 3600_000 // unrecognized → treat as daily
  const [min, hour, dom, , dow] = parts
  const every = (f) => { const m = /^\*\/(\d+)$/.exec(f); return m ? parseInt(m[1], 10) : null }
  const eMin = every(min)
  if (eMin) return Math.max(3 * eMin, 90) * 60_000          // */n min → ≥90 min
  const eHour = every(hour)
  if (eHour) return Math.max(3 * eHour, 12) * 3600_000      // every k hours
  if (hour === '*') return 3 * 3600_000                     // hourly at fixed minute
  if (dom !== '*') return 33 * 24 * 3600_000                // monthly
  if (dow !== '*') return 8 * 24 * 3600_000                 // weekly
  return 26 * 3600_000                                      // daily
}

function fmtAge(ms) {
  if (ms == null) return 'never'
  const h = ms / 3600_000
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`
}

/** Management API query with retries — api.supabase.com intermittently 502s
 *  (observed 2026-07-23); a transient gateway blip must not page anyone. */
async function query(ref, pat, sql) {
  let lastErr
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      if (res.ok && !text.startsWith('<')) return JSON.parse(text)
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`)
    } catch (e) {
      lastErr = e
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 5000))
  }
  throw lastErr
}

const findings = []
const now = Date.now()

for (const { name, patEnv, ref } of PRODUCTS) {
  console.log(`\n== ${name} (${ref})`)
  const pat = process.env[patEnv]
  if (!pat) {
    findings.push({ product: name, job: '(all)', schedule: '', problem: 'unverifiable', detail: `env ${patEnv} not set — heartbeats cannot be checked` })
    console.error(`  UNVERIFIABLE env ${patEnv} not set`)
    continue
  }
  let rows
  try {
    rows = await query(ref, pat, HEARTBEAT_SQL)
  } catch (e) {
    findings.push({ product: name, job: '(all)', schedule: '', problem: 'unverifiable', detail: `Management API query failed after retries: ${e.message}` })
    console.error(`  UNVERIFIABLE ${e.message}`)
    continue
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    // A cron-bearing product losing ALL its jobs would be a real incident, but a
    // legitimately emptied project shouldn't page forever — flag it as dead.
    findings.push({ product: name, job: '(all)', schedule: '', problem: 'dead', detail: 'no active cron jobs found — expected at least one (remove the product from check-cron-heartbeats.mjs if intentional)' })
    console.error('  DEAD no active cron jobs found')
    continue
  }
  for (const r of rows) {
    const allow = allowanceMs(r.schedule)
    const lastSuccess = r.last_success ? new Date(r.last_success).getTime() : null
    const age = lastSuccess ? now - lastSuccess : null
    if (lastSuccess && age <= allow) {
      console.log(`  OK   ${r.jobname} [${r.schedule}] last success ${fmtAge(age)} ago`)
    } else {
      findings.push({
        product: name,
        job: r.jobname,
        schedule: r.schedule,
        problem: 'dead',
        detail: `last success ${fmtAge(age)} ago (allowed ${fmtAge(allow)}); last run ${r.last_run ?? 'never'}; last result: ${r.last_result ?? 'none in 35d'}`,
      })
      console.error(`  DEAD ${r.jobname} [${r.schedule}] last success ${fmtAge(age)} ago > allowed ${fmtAge(allow)}`)
    }
  }
}

writeFileSync('heartbeat-findings.json', JSON.stringify(findings, null, 2))

if (findings.length > 0) {
  console.error(`\n${findings.length} heartbeat finding(s) — failing the run (the red run is the alert).`)
  process.exit(1)
}
console.log('\nAll fleet cron heartbeats healthy.')
