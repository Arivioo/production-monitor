#!/usr/bin/env node
/**
 * scout-triage.mjs: the human half of the scout loop.
 *
 * The scout files reports. This is where a person judges them, and the judgement is the
 * thing that makes the loop learn. A pattern marked not-real/known/fixed with a REASON is
 * never re-surfaced (ux-scout.mjs readDismissed), so the noise filter lives in data instead
 * of in a hardcoded array like replyflow's monitor-email-integrity AI_NOISE, which was
 * calibrated once on 2026-07-29 and has been going quietly stale ever since.
 *
 * Marking something `fixed` also arms the Measured step: measure_after is set, and the next
 * weekly scout run re-checks whether that exact signal actually stopped. That is the
 * difference between a receipt saying "the change was made" and one saying "the problem
 * stopped".
 *
 * Usage:
 *   node scripts/scout-triage.mjs                             # list open reports
 *   node scripts/scout-triage.mjs --all                       # include already-judged ones
 *   node scripts/scout-triage.mjs show <id-prefix>            # full evidence for one report
 *   node scripts/scout-triage.mjs mark <id-prefix> <state> "<reason>"
 *
 *   <state> = real | not-real | known | fixed | new
 *     real      this is genuinely broken for a user. Only `real` is eligible for the
 *               autonomy phase, and that phase still needs its own approval.
 *     not-real  a probe, a test, or expected behaviour. Never surfaced again.
 *     known     already understood and accepted. Never surfaced again.
 *     fixed     a change shipped. Arms the Measured re-check in 7 days.
 *     new       undo a judgement and put it back in the queue.
 *
 * A reason is REQUIRED for every state except `new`. A dismissal without a reason teaches
 * the scout nothing and is exactly how a filter rots.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECTS_ROOT = process.env.UX_SCOUT_PROJECTS_ROOT || 'C:\\Business\\Internal Projects'
const BO_CREDS = join(PROJECTS_ROOT, 'BackOffice', 'docs', 'Credentials.txt')
const BO_REF = 'xoecpzfsskalvjrtcbbl' // BackOffice PROD (docs/Credentials.txt:18)
const BO_BASE = `https://${BO_REF}.supabase.co`
const UA = 'scout-triage'
const MEASURE_DAYS = 7

const STATES = ['real', 'not-real', 'known', 'fixed', 'new']

function boSecret() {
  if (process.env.BOARD_SUPABASE_SECRET) return process.env.BOARD_SUPABASE_SECRET.trim()
  const m = readFileSync(BO_CREDS, 'utf-8').match(/sb_secret_[A-Za-z0-9_]+/)
  if (!m) throw new Error(`no sb_secret_ key found in ${BO_CREDS}`)
  return m[0]
}

async function api(path, init = {}) {
  const secret = boSecret()
  const res = await fetch(`${BO_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: secret, Authorization: `Bearer ${secret}`, 'User-Agent': UA,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
  return body.trim() ? JSON.parse(body) : []
}

const STATE_MARK = { new: ' ', real: '!', 'not-real': 'x', known: '-', fixed: 'v' }

async function list(all) {
  const filter = all ? '' : '&state=eq.new'
  // Order by product FIRST: the listing prints a product header when the value changes, so
  // any other primary sort makes the same product appear under two headers.
  const rows = await api(`scout_reports?select=*&order=product.asc,authenticated.desc,occurrences.desc${filter}`)
  if (!rows.length) {
    console.log(all ? 'No reports at all.' : 'No open reports. (Use --all to see judged ones.)')
    return
  }
  let lastProduct = null
  for (const r of rows) {
    if (r.product !== lastProduct) { console.log(`\n${r.product}`); lastProduct = r.product }
    const who = r.authenticated ? `USER x${r.distinct_users}` : 'probe   '
    console.log(
      `  [${STATE_MARK[r.state] ?? '?'}] ${r.id.slice(0, 8)}  ${who}  ${String(r.occurrences).padStart(5)}x  ` +
      `${r.function_name}: ${r.message_pattern.slice(0, 70)}`
    )
    if (r.state !== 'new') console.log(`        ${r.state}${r.state_reason ? `: ${r.state_reason}` : ' (NO REASON GIVEN)'}`)
    if (r.measured_result) console.log(`        measured ${r.measured_at?.slice(0, 10)}: ${r.measured_result}`)
  }
  const users = rows.filter((r) => r.authenticated).length
  console.log(`\n${rows.length} report(s), ${users} of them hit a signed-in user.`)
  console.log('Legend: [!] real  [x] not-real  [-] known  [v] fixed  [ ] unjudged')
}

/** Resolve a short id prefix to exactly one report.
 *  PostgREST cannot LIKE a uuid column ("operator does not exist: uuid ~~ unknown"), so the
 *  prefix is matched client-side over the id list rather than pushed into the query. */
async function byPrefix(prefix, select = '*') {
  if (!prefix) throw new Error('an id prefix is required (the 8 characters shown in the listing)')
  const rows = await api(`scout_reports?select=${select}`)
  const hits = rows.filter((r) => r.id.startsWith(prefix))
  if (!hits.length) throw new Error(`no report id starts with "${prefix}"`)
  if (hits.length > 1) throw new Error(`"${prefix}" matches ${hits.length} reports; use a longer prefix`)
  return hits[0]
}

async function show(prefix) {
  console.log(JSON.stringify(await byPrefix(prefix), null, 2))
}

async function mark(prefix, state, reason) {
  if (!STATES.includes(state)) throw new Error(`state must be one of: ${STATES.join(' | ')}`)
  if (state !== 'new' && !reason) {
    // Enforced, not advisory. A dismissal with no reason is indistinguishable from a
    // mistake six weeks later, and it is precisely what turns a filter into rot.
    throw new Error(`a reason is required when marking "${state}" (that reason is what teaches the scout)`)
  }
  const target = await byPrefix(prefix, 'id,product,function_name,message_pattern')

  const patch = { state, state_reason: reason || null }
  if (state === 'fixed') {
    // Arm the Measured re-check. Nothing else in the fleet does this: our receipts prove a
    // change was made, never that the problem stopped.
    patch.measure_after = new Date(Date.now() + MEASURE_DAYS * 86400_000).toISOString()
    patch.measured_at = null
    patch.measured_result = null
  }
  await api(`scout_reports?id=eq.${target.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  })
  console.log(`${target.id.slice(0, 8)} -> ${state}${reason ? `: ${reason}` : ''}`)
  if (state === 'fixed') console.log(`  Measured re-check armed for ${MEASURE_DAYS} days from now.`)
  if (state === 'not-real' || state === 'known') console.log('  The scout will not surface this pattern again.')
}

const [cmd, ...rest] = process.argv.slice(2)
const run = async () => {
  if (!cmd || cmd === '--all') return list(cmd === '--all')
  if (cmd === 'show') return show(rest[0])
  if (cmd === 'mark') return mark(rest[0], rest[1], rest.slice(2).join(' '))
  throw new Error(`unknown command "${cmd}". Run with no arguments to list, or see the header for usage.`)
}
run().catch((e) => { console.error(String(e.message || e)); process.exit(1) })
