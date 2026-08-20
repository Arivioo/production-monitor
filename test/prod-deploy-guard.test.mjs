/**
 * The verify_jwt declaration gate: the fix for a whole class of silent production breaks.
 *
 * `supabase functions deploy` defaults ANY undeclared function to verify_jwt = true. A fleet
 * audit on 2026-08-20 found 35 functions across 4 repos running false in production with
 * nothing declaring it. This script is the AUTONOMOUS deploy path (board-drainer hands it to
 * fix agents), so it must never let an agent break a product as a side effect.
 *
 * Run: node test/prod-deploy-guard.test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert'
import { verifyJwtGateDecision, declaredVerifyJwt } from '../scripts/prod-deploy-guard.mjs'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ok - ${name}`) }

t('declared and matching -> allowed', () => {
  assert.equal(verifyJwtGateDecision(false, false).ok, true)
  assert.equal(verifyJwtGateDecision(true, true).ok, true)
})

t('THE BUG: live=false but undeclared -> REFUSED, not defaulted to true', () => {
  const d = verifyJwtGateDecision(false, undefined)
  assert.equal(d.ok, false)
  assert.match(d.reason, /NOT declared/)
  assert.match(d.reason, /verify_jwt = false/)   // tells you the exact line to add
})

t('live=true but undeclared is ALSO refused (no silent luck)', () => {
  // Even when the default would happen to match, deploying on an undeclared value means the
  // repo is not the source of truth. Refuse, so it gets written down.
  assert.equal(verifyJwtGateDecision(true, undefined).ok, false)
})

t('config disagreeing with production -> REFUSED', () => {
  const d = verifyJwtGateDecision(false, true)
  assert.equal(d.ok, false)
  assert.match(d.reason, /PRODUCTION is false/)
})

t('FAILS CLOSED when live state is unreadable', () => {
  assert.equal(verifyJwtGateDecision(undefined, false).ok, false)
  assert.equal(verifyJwtGateDecision(null, false).ok, false)
})

t('parses a real config.toml block', () => {
  const cfg = `
[functions.stripe-webhook]
verify_jwt = false

[functions.checkout]
verify_jwt = true
`
  assert.equal(declaredVerifyJwt(cfg, 'stripe-webhook'), false)
  assert.equal(declaredVerifyJwt(cfg, 'checkout'), true)
  assert.equal(declaredVerifyJwt(cfg, 'not-there'), undefined)
})

t('a config.toml with no [functions.*] blocks declares nothing', () => {
  // ChannelMover's real shape before 2026-08-20: a full config.toml, zero verify_jwt.
  assert.equal(declaredVerifyJwt('[api]\nenabled = true\n\n[db]\nport = 54322\n', 'anything'), undefined)
  assert.equal(declaredVerifyJwt('', 'anything'), undefined)
  assert.equal(declaredVerifyJwt(null, 'anything'), undefined)
})

t('a function named as a prefix of another is not confused for it', () => {
  const cfg = '[functions.sync]\nverify_jwt = true\n\n[functions.sync-outreach]\nverify_jwt = false\n'
  assert.equal(declaredVerifyJwt(cfg, 'sync'), true)
  assert.equal(declaredVerifyJwt(cfg, 'sync-outreach'), false)
})

console.log(`\n${n} tests passed`)
