/**
 * Unit tests for board-drainer's pure decision logic:
 *  - classify(): owner routing + hard-escalate gate (destructive/human classes never dispatch)
 *  - verdictToUpsert(): the receipt-guard (never close without a verified receipt)
 * Run: node test/board-drainer.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { classify, verdictToUpsert, meetsThreshold, scoutReportToIncident, stuckWhoMustAct } from '../scripts/board-drainer.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

// ── classify (every incident is dispatched; mode = fix | verify) ────────────────
t('owner=Roger -> VERIFY-only (read-only: close-if-green or escalate)', () => {
  const c = classify({ who_must_act: 'Roger - Google OAuth re-auth', root_cause: '', title: '' })
  assert.equal(c.mode, 'verify'); assert.equal(c.owner, 'roger')
})
t('owner=Claude, plain infra fix -> FIX mode', () => {
  const c = classify({ who_must_act: 'Claude: fix stale spec assertion', root_cause: 'test drift', title: '' })
  assert.equal(c.mode, 'fix'); assert.equal(c.owner, 'claude')
})
t('Claude-owned but SECRET rotation -> VERIFY-only (hard-escalate class)', () => {
  const c = classify({ who_must_act: 'Claude - rotate the Supabase service key', root_cause: 'legacy key disabled', title: '' })
  assert.equal(c.mode, 'verify'); assert.equal(c.owner, 'roger')
})
t('Claude-owned but DESTRUCTIVE delete -> VERIFY-only', () => {
  const c = classify({ who_must_act: 'Claude - delete the stale connection row', root_cause: '', title: '' })
  assert.equal(c.mode, 'verify')
})
t('Claude-owned but PAYMENT -> VERIFY-only', () => {
  const c = classify({ who_must_act: 'Claude - issue a refund via Stripe dashboard', root_cause: '', title: '' })
  assert.equal(c.mode, 'verify')
})
t('unowned/unknown -> FIX mode (never park on Roger)', () => {
  const c = classify({ who_must_act: '', root_cause: 'CI step failed', title: 'build red' })
  assert.equal(c.mode, 'fix'); assert.equal(c.owner, 'claude')
})
t('vendor PLAN EXPIRED -> NOTE mode (upsert expected, never worked/escalated)', () => {
  const c = classify({ who_must_act: 'Roger - renew the Smartlead plan', root_cause: 'HTTP 401 Plan expired', title: 'BackOffice Outreach: sync failed (Smartlead plan expired)' })
  assert.equal(c.mode, 'note'); assert.equal(c.owner, 'none')
})

// ── verdictToUpsert receipt-guard ──────────────────────────────────────────────
const inc = { source: 'production-monitor', key: 'k1', title: 'x', severity: 'warning' }
t('fixed WITHOUT receipt -> downgraded to investigating (never a shallow close)', () => {
  const p = verdictToUpsert(inc, { class: 'C-CLOSED', status: 'fixed', action: 'looks fine', receipt: '' })
  assert.equal(p.p_status, 'investigating')
})
t('fixed WITH receipt -> closes as fixed', () => {
  const p = verdictToUpsert(inc, { class: 'A-INFRA', status: 'fixed', action: 'pushed abc123', receipt: 'monitor run 999 green' })
  assert.equal(p.p_status, 'fixed'); assert.equal(p.p_who_must_act, null)
})
t('blocked -> carries who_must_act for Roger', () => {
  const p = verdictToUpsert(inc, { class: 'D-ESCALATE', status: 'blocked', action: 'none', who_must_act: 'Roger - do X' })
  assert.equal(p.p_status, 'blocked'); assert.match(p.p_who_must_act, /Roger - do X/)
})

console.log(`\n${n} assertions passed.`)


// ── PHASE 4: severity threshold (Roger's call 2026-08-20, replacing a bare MAX_PER_RUN=3) ──
const RANK = { critical: 3, warning: 2, info: 1 }

t('threshold warning: critical and warning are worked, info is not', () => {
  assert.equal(meetsThreshold({ severity: 'critical' }, RANK.warning), true)
  assert.equal(meetsThreshold({ severity: 'warning' }, RANK.warning), true)
  assert.equal(meetsThreshold({ severity: 'info' }, RANK.warning), false)
})

t('threshold critical: only critical is worked', () => {
  assert.equal(meetsThreshold({ severity: 'critical' }, RANK.critical), true)
  assert.equal(meetsThreshold({ severity: 'warning' }, RANK.critical), false)
})

t('threshold info: everything is worked', () => {
  for (const sev of ['critical', 'warning', 'info']) {
    assert.equal(meetsThreshold({ severity: sev }, RANK.info), true)
  }
})

t('an UNKNOWN severity is never silently skipped', () => {
  // A row we cannot grade must go ABOVE the bar, not below. Skipping the ungradeable is how
  // a threshold quietly becomes a blind spot.
  assert.equal(meetsThreshold({ severity: null }, RANK.critical), true)
  assert.equal(meetsThreshold({ severity: 'nonsense' }, RANK.critical), true)
  assert.equal(meetsThreshold({}, RANK.critical), true)
})

// ── PHASE 4: scout reports enter through the SAME unchanged boundary ──────────────────
const rep = (o = {}) => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', product: 'replyflow',
  function_name: 'connect-platform', operation: 'oauth',
  message_pattern: 'No stored tokens, restart OAuth flow',
  occurrences: 38, distinct_users: 4, authenticated: true,
  sample_evidence: { user_id: 'u1' }, narrative: 'users dead-end in OAuth',
  state_reason: 'confirmed by replay', ...o,
})

t('a scout report that hit a signed-in user maps to severity=warning', () => {
  assert.equal(scoutReportToIncident(rep()).severity, 'warning')
})

t('an anonymous-but-human-approved report maps to info, never critical', () => {
  const inc = scoutReportToIncident(rep({ authenticated: false }))
  assert.equal(inc.severity, 'info')
  assert.notEqual(inc.severity, 'critical')
})

t('a scout report carries its id so the loop can be closed back', () => {
  assert.equal(scoutReportToIncident(rep()).scoutReportId, rep().id)
})

t("REGRESSION GUARD: an OAuth scout report still hard-escalates, autonomy did NOT widen", () => {
  // Phase 4 must not smuggle a new autonomy class in. This report is exactly the kind the
  // scout surfaces, and OAuth is in HUMAN_HANDS, so it must still land in verify-only mode
  // owned by Roger, identical to before Phase 4 existed.
  const c = classify(scoutReportToIncident(rep()))
  assert.equal(c.mode, 'verify')
  assert.equal(c.owner, 'roger')
})

t('a plain UX copy fix from the scout is Claude-owned and fixable', () => {
  const c = classify(scoutReportToIncident(rep({
    message_pattern: 'empty state gives no guidance',
    narrative: 'the empty state text does not tell the user where to go',
    state_reason: 'copy only',
  })))
  assert.equal(c.owner, 'claude')
  assert.equal(c.mode, 'fix')
})

t('a scout report asking for a DB delete still hard-escalates', () => {
  const c = classify(scoutReportToIncident(rep({
    message_pattern: 'orphan rows should be deleted from the connections table',
    narrative: 'drop the orphaned rows',
  })))
  assert.equal(c.mode, 'verify')
})


// ── stuck-escalation ownership (incident board-drainer-stuck-escalates-to-roger, 2026-08-20) ──
// Roger's 2026-08-12 hard rule: a CODE fix must never end up sitting on him. The old block
// hardcoded "Roger - ..." on every stuck item and CONCATENATED onto the previous string.

t('a stuck CODE fix keeps Claude as the owner, it does not land on Roger', () => {
  const r = stuckWhoMustAct('Claude - fix the failing spec in gate-a-crawl.spec.ts')
  assert.equal(r.owner, 'Claude')
  assert.match(r.value, /^Claude - fix the failing spec/)
})

t("a stuck action that genuinely needs Roger's hands IS re-owned to Roger", () => {
  assert.equal(stuckWhoMustAct('Claude - reconnect the Google OAuth account').owner, 'Roger')
  assert.equal(stuckWhoMustAct('Claude - the vendor plan expired, renew the payment').owner, 'Roger')
})

t('the stuck prefix can NEVER compound across repeated passes', () => {
  // This is the exact shape observed live: the boilerplate was prepended again each pass.
  let v = 'Claude - fix the runner permissions'
  for (let i = 0; i < 5; i++) v = stuckWhoMustAct(v).value
  assert.equal(v, 'Claude - fix the runner permissions')
  assert.equal((v.match(/could not resolve/g) || []).length, 0)
})

t('an already-compounded string is CLEANED, not appended to', () => {
  const dirty = 'Roger - board-drainer could not resolve after 3 tries; Claude - fix kb-learning/RUNNER.md'
  const r = stuckWhoMustAct(dirty)
  assert.equal(r.priorAction, 'fix kb-learning/RUNNER.md')  // owner prefix stripped, re-added once
  assert.equal(r.owner, 'Claude')
})

t('an empty who_must_act degrades to a safe, ownable action', () => {
  const r = stuckWhoMustAct(null)
  assert.equal(r.value, 'Claude - investigate manually')
})
