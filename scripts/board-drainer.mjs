/**
 * Board Drainer — autonomous incident EXECUTE-loop (root fix, 2026-08-15).
 *
 * Closes the one structural gap the fleet had: detect -> diagnose -> prescribe was strong, but the
 * EXECUTE step depended on a human (Roger) opening a session. production-monitor's autonomous stack
 * (auto-fix / agent-triage / deploy-triage) is live but each only sees its own GitHub-Actions slice;
 * NONE reads the aggregated Monitoring Board. This runner does: it reads `monitoring_incidents`
 * (BO Supabase), works the owner=Claude items an autonomous dev session may safely fix, escalates the
 * rest, and writes the result back — so the board drains to zero without Roger in the loop.
 *
 * Reuses the existing primitives (agent-triage.mjs's headless-Claude dispatch, Tier-B policy,
 * allowedTools allowlist, dedup-state, local-first, upsert_incident writer) — nothing rebuilt.
 *
 * SAFETY POSTURE (Roger-approved boundary, 2026-08-15):
 *   AUTONOMOUS  : monitor/spec/CI/config/pipeline fixes incl. prod deploy of THOSE classes;
 *                 closing verified false-reds; STAGING deploy of product-code fixes.
 *   ESCALATE    : destructive DB/DDL, secrets/keys, payments, customer comms, PROD promotion of
 *                 product code, business decisions, low-confidence diagnoses, Roger's OAuth hands.
 *
 * DEFAULTS SAFE: dry-run unless BOARD_DRAINER_LIVE=1, and self-skips entirely unless
 *   BOARD_DRAINER_ENABLED=1. Stage-6 go-live APPROVED 2026-08-18: the scheduled task now registers
 *   both ENABLED and LIVE (see scripts/setup-board-drainer-task.ps1). Global kill switch:
 *   BOARD_DRAINER_DISABLED=1.
 *
 * Env knobs:
 *   BOARD_DRAINER_ENABLED=1   on-switch (else self-skip loudly, exit 0)
 *   BOARD_DRAINER_DISABLED=1  kill switch (overrides ENABLED)
 *   BOARD_DRAINER_LIVE=1      actually dispatch + write back (else DRY-RUN: classify + print only)
 *   BOARD_DRAINER_FIXTURE=<path>  classify incidents from a local JSON array instead of the live board
 *                                 (offline classifier validation; never writes back)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { pathToFileURL } from 'url'

// ── config ──────────────────────────────────────────────────────────────────────────────
const BO_REF = 'xoecpzfsskalvjrtcbbl'
const BO_BASE = `https://${BO_REF}.supabase.co`
const BO_CREDS = 'C:\\Business\\Internal Projects\\BackOffice\\docs\\Credentials.txt'
const STATE_DIR = process.env.BOARD_DRAINER_HOME || 'C:\\Business\\_board-drainer'
const STATE = join(STATE_DIR, 'state.json')
const LOG = join(STATE_DIR, 'drainer.log')
const VERDICT_PATH = join(STATE_DIR, 'drainer-verdict.json')
const SEND_EMAIL = 'C:\\Users\\roger_rwjnmnz\\.claude\\scripts\\send_report_email.py'

// Blast-radius cap, still a hard ceiling, but no longer the ONLY control.
const MAX_PER_RUN = Number(process.env.BOARD_DRAINER_MAX_PER_RUN || 3)

// Severity threshold (Roger's call 2026-08-20, replacing a bare hardcoded 3 whose reasoning
// nobody could reconstruct). Autonomy is now a POLICY you dial, the way PostHog's
// P0/P1+/P2+/P3+/All selector works, rather than a magic number.
//   'critical'  only critical
//   'warning'   critical + warning   <- default
//   'info'      everything
// Items below the threshold are still CLASSIFIED and logged every run, they are simply not
// dispatched, so lowering the dial never silently loses them.
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 }
const THRESHOLD = (process.env.BOARD_DRAINER_THRESHOLD || 'warning').toLowerCase()
const THRESHOLD_RANK = SEVERITY_RANK[THRESHOLD] ?? SEVERITY_RANK.warning

/** True when an incident is at or above the configured severity threshold.
 *  An UNKNOWN/absent severity is treated as ABOVE the bar, never below: a row we cannot
 *  grade is a row we must not silently skip. */
export function meetsThreshold(inc, thresholdRank = THRESHOLD_RANK) {
  const rank = SEVERITY_RANK[String(inc?.severity || '').toLowerCase()]
  if (rank === undefined) return true
  return rank >= thresholdRank
}
const MAX_ATTEMPTS = 3         // dedup-stuck: after N failed attempts on a key, escalate as "auto-fix stuck"
const MODEL = 'claude-opus-4-8'
const MAX_TURNS = 40
const AGENT_TIMEOUT_MS = 12 * 60 * 1000
const NON_BROWSER_UA = 'board-drainer/1.0'   // sb_secret keys are 403'd under a browser UA (Mozilla/*)

const LIVE = process.env.BOARD_DRAINER_LIVE === '1'
const FIXTURE = process.env.BOARD_DRAINER_FIXTURE || null

// ── logging ─────────────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch { /* noop */ }
}
function loadState() { try { return JSON.parse(readFileSync(STATE, 'utf-8')) } catch { return { attempts: {} } } }
function saveState(s) { try { writeFileSync(STATE, JSON.stringify(s, null, 2)) } catch { /* noop */ } }

// ── BO secret (read from Credentials.txt at runtime — never inlined, never in env registration) ──
function readBoSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  const txt = readFileSync(BO_CREDS, 'utf-8')
  const m = txt.match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

// ── board I/O (PostgREST; non-browser UA is mandatory) ───────────────────────────────────
async function readBoard(secret) {
  const url = `${BO_BASE}/rest/v1/monitoring_incidents`
    + `?select=source,key,title,severity,status,root_cause,who_must_act,opened_at`
    + `&status=in.(open,blocked,investigating)&order=opened_at.asc`
  const res = await fetch(url, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
  })
  if (!res.ok) throw new Error(`board read HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// One-shot retry on a TRANSPORT error (fetch() throwing, e.g. `TypeError: fetch failed`) — NOT on an
// HTTP status (those are handled by !res.ok below and are real server rejections, never retried).
// Root cause (incident board-drainer-upsert-fetch-failed, 2026-08-19): readBoard() opens an undici
// keep-alive socket, then dispatchAgent()'s execFileSync blocks the event loop 6-8 min; the edge
// closes the idle socket but undici cannot reap it while the loop is blocked, so the first POST reuses
// a dead socket and throws. The retry gets a fresh connection (the dead socket is evicted once its
// error handler finally runs). Safe: upsert_incident is idempotent (keyed by source+key) and a
// transport throw means the server never received the request — a retry cannot double-write.
async function fetchWithTransportRetry(url, init) {
  try {
    return await fetch(url, init)
  } catch (e) {
    log(`  transport error on write-back (${(e?.message || e).toString().split('\n')[0]}) — one-shot retry on a fresh connection`)
    await new Promise((r) => setTimeout(r, 500))   // let undici evict the dead pooled socket first
    return fetch(url, init)
  }
}

/** monitoring_incidents.source CHECK allows ONLY
 *  healthchecks | sentry | production-monitor | cron | silent-failure.
 *  A scout-derived item carries source='scout-ux', which the constraint REJECTS with a 400,
 *  and upsertIncident throws on a non-ok response. Incident
 *  production-monitor:e9c8e44:scout-ux-source-violates-incident-check-constraint (2026-08-20)
 *  traced the consequence: the throw escapes the per-item loop, main() aborts BEFORE
 *  markScoutReport(), worked_at is never set, readScoutQueue() filters on worked_at is null,
 *  so the SAME report re-dispatches an Opus agent on every tick forever, and because
 *  saveState() is also past the throw the MAX_ATTEMPTS guard never trips either. The
 *  blast-radius guard failed OPEN.
 *
 *  The right fix is not to widen the constraint. A scout report is not an incident and must
 *  never become one: reports are free, alarms are not. Scout items write ONLY to
 *  scout_reports. This guard makes that structural rather than a convention. */
export function isScoutDerived(inc) {
  return Boolean(inc && (inc.scoutReportId || inc.source === 'scout-ux'))
}

async function upsertIncident(secret, payload) {
  const res = await fetchWithTransportRetry(`${BO_BASE}/rest/v1/rpc/upsert_incident`, {
    method: 'POST',
    headers: {
      apikey: secret, Authorization: `Bearer ${secret}`,
      'User-Agent': NON_BROWSER_UA, 'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`upsert_incident HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.text()
}

/**
 * PHASE 4 (Roger's call 2026-08-20: "staging, then stop").
 *
 * A scout report is NOT an incident and never becomes one. It lives in its own table because
 * reports are free and alarms are not. What Phase 4 adds is narrow: a report a HUMAN has
 * marked `real` becomes eligible for the same fix agent, through the SAME unchanged boundary.
 * Nothing about the autonomy limits moves. Product-code fixes still stop at staging and
 * escalate the prod promotion to Roger, exactly as they do for every other incident today.
 *
 * The gate is the human mark. A scout report nobody judged is never worked, no matter how
 * many users it hit or how confident the narrative sounds.
 */
async function readScoutQueue(secret) {
  const url = `${BO_BASE}/rest/v1/scout_reports`
    + `?select=id,product,function_name,operation,message_pattern,occurrences,distinct_users,authenticated,sample_evidence,narrative,state_reason`
    + `&state=eq.real&worked_at=is.null&order=distinct_users.desc,occurrences.desc`
  const res = await fetch(url, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': NON_BROWSER_UA },
  })
  if (!res.ok) throw new Error(`scout queue read HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/** Shape a scout report so the EXISTING classifier and agent path can consume it unchanged.
 *  Severity is derived, never invented: a failure that hit a signed-in person is `warning`,
 *  an anonymous pattern a human still judged real is `info`. Neither is ever `critical`,
 *  because a UX finding is by definition not an outage. */
export function scoutReportToIncident(r) {
  return {
    source: 'scout-ux',
    key: `${r.product}:${r.function_name}:${String(r.message_pattern).slice(0, 60)}`,
    title: `[UX] ${r.product} ${r.function_name}: ${r.message_pattern}`,
    severity: r.authenticated ? 'warning' : 'info',
    status: 'open',
    root_cause: [
      r.narrative || '',
      `${r.occurrences} occurrence(s), ${r.distinct_users} distinct user(s), authenticated=${Boolean(r.authenticated)}.`,
      r.state_reason ? `Roger marked this real: ${r.state_reason}` : '',
      `Evidence: ${JSON.stringify(r.sample_evidence || {})}`,
    ].filter(Boolean).join(' '),
    who_must_act: 'Claude - fix the user-facing failure, staging deploy only',
    scoutReportId: r.id,
  }
}

/** Close the loop on a worked report. Marking it `fixed` here is what arms the Measured
 *  re-check (ux-scout.mjs measurePass), so the receipt can eventually say the PROBLEM
 *  STOPPED rather than only that a change was made. */
async function markScoutReport(secret, id, patch) {
  const res = await fetch(`${BO_BASE}/rest/v1/scout_reports?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: secret, Authorization: `Bearer ${secret}`,
      'User-Agent': NON_BROWSER_UA, 'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  })
  if (!res.ok) log(`  scout_reports patch failed for ${String(id).slice(0, 8)}: HTTP ${res.status}`)
}

// ── classifier: owner + hard-escalate gate (the nuanced fix decision is the agent's, under policy) ──
// A HARD-ESCALATE class is never dispatched to the agent — it needs Roger's hands or a forbidden verb.
const HUMAN_HANDS = /\b(oauth|re-?auth|reconnect|reconnect|google account|log ?in|sign ?in|vendor|support ticket|business decision|pricing|refund|new secret|new credential|new api key|rotate|payment|invoice|pay\b|charge|bank|stripe dashboard)\b/i
const DESTRUCTIVE_DB = /\b(delete|drop|truncate|purge|destroy|remove (?:the )?(?:row|record|connection|table)|ddl|migration to (?:prod|production))\b/i
// EXPECTED business state, not an incident: a vendor plan/subscription lapsed (e.g. Smartlead
// "HTTP 401 Plan expired"). These get upserted as status=expected (visible but muted on the board,
// not counted as open) instead of sitting in Open Incidents forever. Checked BEFORE HUMAN_HANDS —
// a lapsed plan is noted, not escalated.
const EXPECTED_BUSINESS = /\b(plan expired|plan (?:lapsed|cancelled|canceled|cancellation)|subscription (?:expired|lapsed|inactive|cancelled|canceled)|payment required|upgrade required|billing suspended|account (?:suspended|paused))\b/i

// Every open incident is RE-VERIFIED against the live source each run — this is the root fix for the
// class that bit us (a self-healed false-red that sat blocked because the email-driven Closer never
// re-visited it). Claude-owned, safely-fixable items get FIX mode (full tools). Everything else
// (owner=Roger, or a destructive/human-hands class) gets VERIFY mode: read-only, can ONLY close-if-green
// (auto-close a self-healed row, any owner) or leave it escalated. VERIFY never performs a fix.
function classify(inc) {
  const text = `${inc.who_must_act || ''} || ${inc.root_cause || ''} || ${inc.title || ''}`
  const who = (inc.who_must_act || '').trim().toLowerCase()

  // Expected business state wins over every other class — it is noted, never worked or escalated.
  if (EXPECTED_BUSINESS.test(text)) {
    return { owner: 'none', mode: 'note', reason: 'expected business state (vendor plan/subscription lapsed) — noted, no action' }
  }

  const ownerRoger = /^roger\b/i.test(who)
  const humanHands = HUMAN_HANDS.test(text)
  const destructive = DESTRUCTIVE_DB.test(text)
  const hardEscalate = ownerRoger || humanHands || destructive

  const reason = ownerRoger ? 'owner=Roger (verify/close-if-green, else escalate)'
    : humanHands ? 'human-hands class (verify-only)'
    : destructive ? 'destructive-DB class (verify-only)'
    : 'owner=Claude, fixable'

  return { owner: hardEscalate ? 'roger' : 'claude', mode: hardEscalate ? 'verify' : 'fix', reason }
}

// ── Tier-B agent policy (the boundary is enforced here + in allowedTools) ─────────────────
const SYSTEM_POLICY = `You are the Board Drainer remediation agent for a fleet of production SaaS apps (ReplyFlow, ChannelMover, SignalScore, ScoutCopilot, Predivo, BackOffice, Valrano, BoatBuddy, etc.). You are handed ONE open incident from the cockpit Monitoring Board. Diagnose it against the LIVE system and remediate it WITHIN STRICT policy, then write a verdict. You run headless with real write access; act conservatively and deterministically. Global rules in ~/.claude/CLAUDE.md apply (verify before claiming; full deploy pipeline; never guess).

STEP 1 — DIAGNOSE from the live system, never from the incident text alone. Read the relevant repo under C:/Business/Internal Projects/<project>/, check recent git log, query the live DB/API/site, inspect the failing CI run. The incident's root_cause is a LEAD.

STEP 2 — CLASSIFY and take ONLY the permitted action:
  A. MONITOR/SPEC/CI/CONFIG/PIPELINE fix (stale test assertion, broken CI step, missing committed file, stale threshold, gitignored-path crash, a recurring false-red = a monitor bug): FIX it in the owning repo, commit (message prefixed "[board-drainer] "), push, and DEPLOY IT (incl. production for these low-blast-radius classes). Verify green after.
  B. PRODUCT-CODE behavior fix (the app itself is genuinely wrong): fix it and deploy to STAGING only. Then ESCALATE the production promotion — do NOT promote product code to prod. (For staging-first projects prod promotion is 'gh workflow run deploy.yml -f confirm=deploy' — you must NEVER run that form for a product repo; that is Roger's gate.)
  C. FALSE-RED / SELF-HEALED (the source is GREEN now): confirm green with a real receipt (repro / live check / observed green run), then CLOSE it. NEVER close on a shallow "looks fine".
  D. LOW-CONFIDENCE / AMBIGUOUS root cause, OR the fix needs a destructive DB op / secret / payment / customer email / a business decision / Roger's OAuth hands: DO NOT act. ESCALATE with a written root-cause hypothesis and the exact one-line action for Roger.

HARD RULES (never violate):
- NEVER a destructive DB/DDL op (delete/drop/update prod rows, migrations to prod). Escalate instead.
- NEVER rotate/set a secret or key; NEVER a payment; NEVER email/message a customer or third party.
- NEVER promote PRODUCT code to production (staging is the ceiling for product fixes). Monitor/infra classes may deploy to prod.
- Bound your work; do not loop. If unsure between two classes, prefer the more conservative (escalate).

PROD EDGE-FUNCTION DEPLOYS (the ONLY permitted path — guarded, Roger-approved 2026-08-20): if the fix requires deploying a Supabase edge function to PROD, you MUST use the guard, never the supabase CLI directly:
  node scripts/prod-deploy-guard.mjs --project <ref> --function <name> --repo <abs repo path> --probe-url <url> [--probe-expect <substring>] [--probe-header "Name: value"] [--note "<what+why>"]
The guard enforces: hard-coded allowlist (ReplyFlow monitor-sync-health; BackOffice monitoring-board + health-monitor — anything else is REFUSED), 2 real deploys/day cap, clean+in-sync repo, green CI, then a mandatory post-deploy probe with auto-rollback. Export SUPABASE_ACCESS_TOKEN (from that repo's docs/Credentials.txt) before calling it; run --dry-run first if unsure. Closing rule: an incident needing a prod deploy may only be closed status=fixed when the guard exits 0 AND its probe evidence is your receipt. Exit 2 = rolled back -> escalate, do NOT close. Exit 1 = refused/error -> do NOT deploy; if the function is not allowlisted, escalate to Roger instead.

FINAL ACTION (required): use the Write tool to write ${VERDICT_PATH.replace(/\\/g, '/')} as JSON:
{"class":"A-INFRA|B-PRODUCT-STAGED|C-CLOSED|D-ESCALATE","status":"fixed|self-healed|blocked|investigating","action":"what you did (commit sha / PR url / deploy run / none)","receipt":"the concrete verification that proves it (repro output / live check / green run id) — REQUIRED to set status=fixed/self-healed","who_must_act":"Roger - <one-line> (only if status=blocked, else null)","diagnosis":"1-3 sentences"}`

function buildUserPrompt(inc) {
  return [
    'Remediate this Monitoring Board incident per policy. Diagnose from the live system first.\n',
    `- source: ${inc.source}`,
    `- key: ${inc.key}`,
    `- title: ${inc.title}`,
    `- severity: ${inc.severity}`,
    `- status: ${inc.status}`,
    `- opened_at: ${inc.opened_at}`,
    `- prescribed action (a LEAD): ${inc.who_must_act || '(none)'}`,
    `- root_cause (a LEAD): ${inc.root_cause || '(none)'}`,
  ].join('\n')
}

// Read-only investigation + Write(verdict). Live mode adds edit/commit/push/PR/deploy verbs.
// NOTE: no destructive DB / secret / payment verb is ever in this list; those classes escalate.
const READ_ONLY = [
  'Read', 'Grep', 'Glob', 'Write',
  'Bash(gh api:*)', 'Bash(gh run view:*)', 'Bash(gh run list:*)', 'Bash(gh pr list:*)',
  'Bash(curl:*)', 'Bash(cat:*)', 'Bash(ls:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git status:*)',
]
const WRITE = [
  'Edit', 'Bash(git:*)', 'Bash(gh pr:*)', 'Bash(gh workflow run:*)', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(npx:*)',
]

function dispatchAgent(inc, mode) {
  try { if (existsSync(VERDICT_PATH)) rmSync(VERDICT_PATH) } catch { /* noop */ }
  // FIX mode + LIVE gets write/deploy verbs; VERIFY mode is read-only (can only close-if-green or escalate).
  const canWrite = LIVE && mode === 'fix'
  const allowedTools = (canWrite ? [...READ_ONLY, ...WRITE] : READ_ONLY).join(',')
  const VERIFY_NOTE = '\n\n🔎 VERIFY-ONLY mode: you may ONLY (C) confirm the source is GREEN now and CLOSE it (status=self-healed, with a real receipt), or (D) ESCALATE (status=blocked, who_must_act for Roger). You may NOT fix, edit, deploy, or open PRs — you have no write tools.'
  const DRY_NOTE = '\n\n⚠️ DRY RUN: investigate READ-ONLY. Do NOT edit/commit/push/deploy/open PRs. Write ONLY the verdict file, and in "action" describe what you WOULD do, prefixed "[DRY-RUN would] ".'
  let policy = SYSTEM_POLICY
  if (mode === 'verify') policy += VERIFY_NOTE
  if (!LIVE) policy += DRY_NOTE
  const CLAUDE_BIN = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const args = [
    '-p', buildUserPrompt(inc),
    '--append-system-prompt', policy,
    '--allowedTools', allowedTools,
    '--max-turns', String(MAX_TURNS),
    '--model', MODEL,
    '--output-format', 'json',
  ]
  try {
    execFileSync(CLAUDE_BIN, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Board Drainer', GIT_AUTHOR_EMAIL: 'noreply@predivo.ch', GIT_COMMITTER_NAME: 'Board Drainer', GIT_COMMITTER_EMAIL: 'noreply@predivo.ch' },
    })
  } catch (e) {
    log(`  agent errored/timed out: ${(e.message || '').split('\n')[0]}`)
  }
  if (existsSync(VERDICT_PATH)) {
    try { return JSON.parse(readFileSync(VERDICT_PATH, 'utf-8')) } catch { /* malformed */ }
  }
  return null
}

// ── write-back: turn the agent verdict into a board state transition ──────────────────────
function verdictToUpsert(inc, verdict) {
  // Guard: fixed/self-healed REQUIRES a receipt — never close on a shallow verdict.
  let status = verdict.status
  if ((status === 'fixed' || status === 'self-healed') && !(verdict.receipt || '').trim()) {
    status = 'investigating'   // no receipt -> refuse to close; leave visible with progress
  }
  const sev = status === 'blocked' ? (inc.severity || 'warning') : 'warning'
  return {
    p_source: inc.source,
    p_key: inc.key,
    p_title: inc.title,
    p_severity: sev,
    p_status: status,
    p_root_cause: `[board-drainer ${new Date().toISOString().slice(0, 16)}] ${verdict.diagnosis || ''} | ${verdict.action || ''}${verdict.receipt ? ' | receipt: ' + verdict.receipt : ''}`.slice(0, 2000),
    p_who_must_act: status === 'blocked' ? (verdict.who_must_act || inc.who_must_act || null) : null,
    p_evidence: { by: 'board-drainer', class: verdict.class, action: verdict.action, receipt: verdict.receipt || null },
  }
}

/** Pure form of the stuck-escalation ownership decision, exported for tests.
 *  Strips any previous stuck prefix (so it can never compound) and keeps the original owner
 *  unless the remaining action genuinely needs Roger's hands. */
export function stuckWhoMustAct(whoMustAct) {
  const priorAction = String(whoMustAct || 'investigate manually')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*board-drainer could not resolve after \d+ tries;\s*/gi, '')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*auto-fix stuck[^;]*;\s*/gi, '')
    .replace(/^(?:Roger|Claude)\s*[-:]\s*/i, '')   // strip the owner prefix; it is re-added below, so it must not double up
    .trim()
  const owner = HUMAN_HANDS.test(priorAction) ? 'Roger' : 'Claude'
  return { owner, priorAction, value: `${owner} - ${priorAction}` }
}

// ── main ────────────────────────────────────────────────────────────────────────────────
async function main() {
  // gates
  if (process.env.BOARD_DRAINER_DISABLED === '1') { log('KILL SWITCH set (BOARD_DRAINER_DISABLED=1) — exiting.'); return }
  if (process.env.BOARD_DRAINER_ENABLED !== '1') {
    log('⏭️  SKIP: BOARD_DRAINER_ENABLED != 1 (wired-but-off until Roger enables it).')
    return
  }
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
  const state = loadState()
  state.attempts = state.attempts || {}
  log(`Board Drainer start — mode=${LIVE ? 'LIVE' : 'DRY-RUN'}${FIXTURE ? ' [FIXTURE]' : ''}`)

  // 1. read the work-list
  let secret = null, incidents = []
  if (FIXTURE) {
    incidents = JSON.parse(readFileSync(FIXTURE, 'utf-8'))
    log(`FIXTURE: ${incidents.length} synthetic incident(s) loaded from ${FIXTURE}`)
  } else {
    secret = readBoSecret()
    incidents = await readBoard(secret)
    // Phase 4: human-approved scout reports join the same work-list, through the same
    // classifier and the same unchanged autonomy boundary.
    try {
      const scout = await readScoutQueue(secret)
      if (scout.length) {
        log(`  scout queue: ${scout.length} report(s) marked real by Roger, awaiting a fix`)
        incidents = incidents.concat(scout.map(scoutReportToIncident))
      }
    } catch (e) {
      log(`  scout queue unavailable (${String(e).slice(0, 120)}); continuing with the board only`)
    }
  }
  log(`board: ${incidents.length} open/blocked/investigating incident(s)`)
  if (incidents.length === 0) { log('nothing to drain — board is clean.'); return }

  // 2. classify all (every open incident is re-verified), then work up to the per-run cap
  const routed = incidents.map((inc) => ({ inc, cls: classify(inc) }))
  for (const { inc, cls } of routed) {
    log(`  • [${cls.owner}/${cls.mode.toUpperCase()}] ${inc.source}/${inc.key} (${cls.reason}) :: ${inc.title}`)
  }
  const eligible = routed.filter(({ inc }) => meetsThreshold(inc))
  const belowBar = routed.length - eligible.length
  if (belowBar) log(`  severity threshold '${THRESHOLD}': ${belowBar} item(s) below the bar, classified and logged above but not dispatched.`)
  const toWork = eligible.slice(0, MAX_PER_RUN)
  if (eligible.length > MAX_PER_RUN) log(`  blast-radius cap: ${eligible.length} eligible, taking ${MAX_PER_RUN} this run.`)

  // In DRY-RUN or FIXTURE we stop here: classification only, nothing dispatched or written.
  if (!LIVE || FIXTURE) {
    const fixes = toWork.filter((r) => r.cls.mode === 'fix').length
    const notes = toWork.filter((r) => r.cls.mode === 'note').length
    log(`DRY-RUN: would FIX ${fixes}, VERIFY ${toWork.length - fixes - notes}, NOTE-as-expected ${notes}. No agent run, no write-back.`)
    saveState(state)
    return
  }

  // 3. LIVE: dispatch + write back, with dedup-stuck escalation.
  //
  // Each item is isolated. Previously a single throw anywhere in here (e.g. a rejected
  // upsert) propagated out of main(), skipping every REMAINING item, skipping saveState()
  // so the attempt counter never advanced, and skipping the scout write-back so the same
  // report re-dispatched forever. The blast-radius guard failed OPEN. One bad item must cost
  // exactly one item.
  for (const { inc, cls } of toWork) {
    try {  
      if (cls.mode === 'note') {
        // Expected business state: no agent dispatch, no fix — note it on the board as `expected`.
        log(`  ${inc.key}: expected business state — upserting status=expected (noted, no action).`)
        if (isScoutDerived(inc)) { log('    (scout-derived: recorded on the report, never on the incidents board)'); continue }
        await upsertIncident(secret, {
          p_source: inc.source, p_key: inc.key, p_title: inc.title, p_severity: 'info', p_status: 'expected',
          p_root_cause: `[board-drainer] ${inc.root_cause || inc.title} — vendor plan expired — noted, no action`.slice(0, 2000),
          p_who_must_act: null,
          p_evidence: { by: 'board-drainer', class: 'EXPECTED', note: 'vendor plan expired — noted, no action' },
        })
        delete state.attempts[inc.key]
        saveState(state)
        continue
      }
      const attempts = (state.attempts[inc.key] || 0) + 1
      if (attempts > MAX_ATTEMPTS) {
        // STUCK. Two bugs used to live in this block (incident
        // board-drainer-stuck-escalates-to-roger, filed 2026-08-20 by the monitor and verified
        // by hand before this fix):
        //
        // 1. It hardcoded `Roger - ...` on EVERY stuck item, including pure code/spec/CI fixes
        //    the drainer merely could not APPLY. That is precisely the graveyard Roger's
        //    2026-08-12 rule forbids: a code fix must never end up sitting on him. Ownership
        //    now SURVIVES: only an action that genuinely needs his hands (HUMAN_HANDS: OAuth,
        //    payment, vendor, new secret, business decision) is re-owned to Roger. Everything
        //    else stays Claude's, with "auto-fix stuck" recorded as the reason rather than as a
        //    change of owner.
        // 2. It CONCATENATED onto the previous who_must_act, so the prefix compounded on every
        //    stuck pass and buried the real action behind repeated boilerplate. The underlying
        //    action is now extracted and REPLACED, so it can never grow.
        const { owner: stuckOwner, priorAction, value: stuckWho } = stuckWhoMustAct(inc.who_must_act)
        const needsRogersHands = stuckOwner === 'Roger'
        log(`  ${inc.key}: ${attempts - 1} prior failed attempts — escalating as auto-fix-stuck (owner ${stuckOwner}).`)
        if (isScoutDerived(inc)) {
          await markScoutReport(secret, inc.scoutReportId, { state: 'real', state_reason: `auto-fix stuck after ${attempts - 1} attempts: ${priorAction}`.slice(0, 500), worked_at: new Date().toISOString() })
          state.attempts[inc.key] = attempts
          saveState(state)
          continue
        }
        await upsertIncident(secret, {
          p_source: inc.source, p_key: inc.key, p_title: inc.title, p_severity: 'critical', p_status: 'blocked',
          p_root_cause: `[board-drainer] auto-fix STUCK after ${attempts - 1} attempts — the action below still stands, it just could not be applied automatically.`,
          p_who_must_act: stuckWho,
          p_evidence: { by: 'board-drainer', stuck: true, attempts: attempts - 1, stuckOwner, needsRogersHands },
        })
        continue
      }
      log(`  dispatching agent [${cls.mode}] for ${inc.source}/${inc.key} (attempt ${attempts})...`)
      const verdict = dispatchAgent(inc, cls.mode)
      if (!verdict) {
        state.attempts[inc.key] = attempts
        log(`  no verdict for ${inc.key} — recorded attempt ${attempts}.`)
        saveState(state)
        continue
      }
      const payload = verdictToUpsert(inc, verdict)
      // Scout-derived items never reach the incidents board (see isScoutDerived above).
      if (!isScoutDerived(inc)) await upsertIncident(secret, payload)
      log(`  ${inc.key}: verdict=${verdict.class} -> board status=${payload.p_status}${payload.p_status === 'blocked' ? ' (escalated)' : ''}`)
      // Phase 4: close the loop back on the scout report this came from.
      // `fixed` here ARMS the Measured re-check (ux-scout.mjs measurePass): 7 days later the
      // scout re-runs that exact signal and records gone/reduced/unchanged/worse. Note that
      // `fixed` on a product-code change means "fixed and deployed to STAGING"; the prod
      // promotion is escalated to Roger, unchanged from every other incident.
      if (inc.scoutReportId) {
        const done = payload.p_status === 'fixed' || payload.p_status === 'self-healed'
        await markScoutReport(secret, inc.scoutReportId, done
          ? { state: 'fixed', state_reason: `board-drainer: ${verdict.action || verdict.class}`.slice(0, 500),
              worked_at: new Date().toISOString(),
              measure_after: new Date(Date.now() + 7 * 86400_000).toISOString() }
          : { state_reason: `board-drainer could not close it: ${verdict.diagnosis || verdict.class}`.slice(0, 500),
              worked_at: new Date().toISOString() })
        log(`    scout report ${String(inc.scoutReportId).slice(0, 8)} -> ${done ? 'fixed, Measured re-check armed for 7 days' : 'left open, reason recorded'}`)
      }
      // clear the attempt counter only when we reached a terminal, non-stuck state
      if (payload.p_status === 'fixed' || payload.p_status === 'self-healed') delete state.attempts[inc.key]
      else state.attempts[inc.key] = attempts
      saveState(state)
      } catch (e) {
      // Record the attempt so a repeatedly-failing item still reaches MAX_ATTEMPTS and gets
      // escalated, rather than retrying unbounded.
      state.attempts[inc.key] = (state.attempts[inc.key] || 0) + 1
      saveState(state)
      log(`  ${inc.key}: ERRORED mid-work (${String(e).slice(0, 160)}) — attempt recorded, continuing with the next item.`)
    }
  }
  log('Board Drainer done.')
}

// Pure fns exported for unit tests (test/board-drainer.test.mjs). Importing must NOT run main().
export { classify, verdictToUpsert }

// ── ALARM (birth-cert): a run that ERRORS emails Roger's watched inbox immediately. The
// "silently stopped running" case is covered by proxy — the sibling local runners on this same
// box (agenttriage-localrunner, needs-roger-closer) have healthchecks dead-man's-switches, so if
// the machine dies they go dark and page Roger, which includes this drainer. Optional HC ping if
// BOARD_DRAINER_HC is ever set (a check freed up / account upgraded).
function alertFailure(msg) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    const body = join(STATE_DIR, '_drainer_fail.txt')
    writeFileSync(body, `Board Drainer run FAILED at ${new Date().toISOString()}\n\n${msg}\n\nLog: ${LOG}`)
    execFileSync('python', [SEND_EMAIL, '[ALERT] Board Drainer run failed', body], { timeout: 60_000, stdio: 'ignore' })
  } catch { /* already logged; do not throw from the alarm path */ }
  const hc = process.env.BOARD_DRAINER_HC
  if (hc) fetch(`${hc}/fail`).catch(() => {})
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(
    () => { const hc = process.env.BOARD_DRAINER_HC; if (hc) fetch(hc).catch(() => {}) },
    (e) => { console.error(e); alertFailure(e?.stack || e?.message || String(e)); process.exitCode = 1 },
  )
}
