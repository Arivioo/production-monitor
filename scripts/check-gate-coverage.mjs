#!/usr/bin/env node
/**
 * v11 GATE-COVERAGE guard for the fleet.
 *
 * This is the enforcement half of "every project gets the v11 browser gates". It answers,
 * automatically and every week: does each app that SHOULD have the v11 staging-gate harness
 * actually have it, and is it GREEN?
 *
 *   - ENROLLED (has .github/workflows/staging-gates.yml) + latest run success  -> OK
 *   - ENROLLED + latest run failing/none                                       -> FAIL (broken gates = alert)
 *   - REQUIRED but NOT enrolled (no staging-gates.yml yet)                      -> PENDING (reported, never fails)
 *   - gates:'na' (static site / internal tool, no auth+DB+lists to gate)       -> skipped
 *
 * So a red run here means an *enrolled* project's gates broke; the PENDING list is the
 * living backfill queue (a past project not yet enrolled, or a future one that skipped the
 * template, can never be silently forgotten — it shows here until enrolled). New projects
 * inherit the harness from project-starter, so they land ENROLLED on day one.
 *
 * Read-only. Mirrors check-pipeline-drift.mjs (same FLEET, same local/CI dual mode).
 *   - CI mode:  gh api (needs GH_TOKEN = FLEET_READ_TOKEN, classic PAT repo:read).
 *   - Local:    LOCAL_FLEET_ROOT="C:\\Business\\Internal Projects" reads working copies;
 *               run status still uses gh api if a token is present, else marked "unknown".
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

// gates: 'required' = an app with auth/DB/lists/dialogs that MUST carry the v11 gates.
//        'na'       = static marketing site or internal tool — nothing to browser-gate.
const FLEET = [
  { name: 'ReplyFlow',        repo: 'Arivioo/ReplyFlow',        dir: 'replyflow',        gates: 'required' },
  { name: 'SignalScore',      repo: 'Arivioo/signalscore',      dir: 'signalscore',      gates: 'required' },
  { name: 'ChannelMover',     repo: 'Arivioo/ChannelMover',     dir: 'ChannelMover',     gates: 'required' },
  { name: 'BoatBuddy',        repo: 'Arivioo/BoatBuddy',        dir: 'BoatBuddy',        gates: 'required' },
  { name: 'BackOffice',       repo: 'Arivioo/BackOffice',       dir: 'BackOffice',       gates: 'required' },
  { name: 'Valrano',          repo: 'Arivioo/Valrano',          dir: 'Valrano',          gates: 'required' },
  { name: 'ScoutCopilot',     repo: 'Arivioo/ScoutCopilot',     dir: 'ScoutCopilot',     gates: 'required' },
  { name: 'Distribution-OS',  repo: 'Arivioo/Distribution-OS',  dir: 'Distribution-OS',  gates: 'required' },
  { name: 'launchready',      repo: 'Arivioo/launchready',      dir: 'launchready',      gates: 'required' },
  { name: 'arivioo',          repo: 'Arivioo/Cursor_Arivioo',   dir: 'arivioo',          gates: 'required' },
  { name: 'jass-tour-ui-kit', repo: 'Arivioo/jass-tour-ui-kit', dir: 'jass-tour-ui-kit', gates: 'required' },
  { name: 'predivo',          repo: 'Arivioo/predivo',          dir: 'predivo',          gates: 'na' },
]

const WORKFLOW = 'staging-gates.yml'
const LOCAL_ROOT = process.env.LOCAL_FLEET_ROOT
const hasToken = !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)

if (!LOCAL_ROOT && !hasToken) {
  console.log('gate-coverage check skipped: set FLEET_READ_TOKEN (classic PAT, repo:read) to enable, or run locally with LOCAL_FLEET_ROOT set.')
  process.exit(0)
}

// Does the repo carry the staging-gates workflow? (enrolled)
function isEnrolled({ repo, dir }) {
  if (LOCAL_ROOT) return existsSync(join(LOCAL_ROOT, dir, '.github', 'workflows', WORKFLOW))
  try {
    execSync(`gh api repos/${repo}/contents/.github/workflows/${WORKFLOW}`, { stdio: 'pipe' })
    return true
  } catch { return false } // 404 -> not enrolled
}

// Latest staging-gates run conclusion via gh api (needs a token). Returns 'success' |
// 'failure' | 'none' (enrolled but never ran) | 'unknown' (no token to check).
function latestRunConclusion({ repo }) {
  if (!hasToken) return 'unknown'
  try {
    const out = execSync(
      `gh api "repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=1" --jq ".workflow_runs[0].conclusion // \\"none\\""`,
      { stdio: 'pipe' },
    ).toString().trim()
    return out || 'none'
  } catch { return 'none' }
}

const violations = []   // enrolled but gates red -> exit 1 + alert
const pending = []      // required, not yet enrolled -> backfill queue (never fails)
const okList = []
const naList = []

for (const p of FLEET) {
  if (p.gates === 'na') { naList.push(p.name); continue }
  if (!isEnrolled(p)) { pending.push(p.name); continue }
  const c = latestRunConclusion(p)
  if (c === 'success' || c === 'unknown') okList.push(`${p.name}${c === 'unknown' ? ' (enrolled; run status needs a token)' : ''}`)
  else violations.push({ name: p.name, conclusion: c })
}

console.log('v11 gate-coverage guard — every REQUIRED app must carry a GREEN staging-gates harness:\n')
for (const v of violations) console.log(`*** FAIL *** ${v.name} — staging-gates enrolled but latest run = ${v.conclusion} (broken gates)`)
for (const n of okList) console.log(`OK    ${n}`)
if (pending.length) {
  console.log('\nPENDING enrollment (required apps without the v11 gates yet — the backfill queue):')
  for (const n of pending) console.log(`  - ${n}  (add e2e/staging/v11-gates.spec.ts + playwright.v11-gates.config.ts + ${WORKFLOW}; then it flips to enforced)`)
}
if (naList.length) console.log(`\nN/A (static site / internal tool, nothing to browser-gate): ${naList.join(', ')}`)

const required = FLEET.filter((p) => p.gates === 'required').length
console.log(`\nCoverage: ${okList.length}/${required} required apps enrolled + green · ${pending.length} pending · ${violations.length} broken.`)

if (violations.length) {
  console.error(`\nFAIL: ${violations.length} enrolled project(s) with a broken v11 gate run.`)
  process.exit(1)
}
console.log('\nAll ENROLLED gate harnesses green. (Pending apps are the tracked backfill queue, not a failure.)')
