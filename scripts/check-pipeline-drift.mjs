#!/usr/bin/env node
/**
 * Deploy-PIPELINE drift detection for the Supabase-staged fleet.
 *
 * Complements check-drift.mjs (which checks DB schema/cron drift). This checks that
 * every product's .github/workflows/deploy.yml still conforms to the hardened
 * cross-project deploy standard (standards/deploy-standard.md), so a future edit
 * cannot silently regress the pipeline back to the fragile shape that caused the
 * recurring prod-promotion failures (2026-07-15):
 *
 *   §4a  prod promotion must NOT re-run the staging pipeline — it gates on the
 *        recorded staging result instead (no `needs: e2e-staging`; a "Verify
 *        staging gate" step present; staging chain gated `if: github.event_name == 'push'`).
 *   §3e  every `supabase functions deploy` wrapped in retry-with-backoff (no bare one-liner).
 *   §3c  Supabase CLI pinned, never `version: latest`.
 *
 * Read-only. Exits 1 on any drift — the workflow failure IS the alert.
 *
 * Source of each deploy.yml:
 *   - CI mode: fetches via `gh api repos/<owner/repo>/contents/...` (needs GH_TOKEN
 *     with read access to the fleet repos — secret FLEET_READ_TOKEN).
 *   - Local mode (LOCAL_FLEET_ROOT set, e.g. "C:\\Business\\Internal Projects"):
 *     reads each repo's working copy directly, zero auth.
 */

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

// name, GitHub owner/repo (for CI fetch), local dir name (for local mode)
const FLEET = [
  { name: 'ReplyFlow',    repo: 'Arivioo/ReplyFlow',    dir: 'replyflow' },
  { name: 'SignalScore',  repo: 'Arivioo/signalscore',  dir: 'signalscore' },
  { name: 'ChannelMover', repo: 'Arivioo/ChannelMover',  dir: 'ChannelMover' },
  { name: 'BoatBuddy',    repo: 'Arivioo/BoatBuddy',     dir: 'BoatBuddy' },
  { name: 'Valrano',      repo: 'Arivioo/Valrano',       dir: 'Valrano' },
]

const LOCAL_ROOT = process.env.LOCAL_FLEET_ROOT

// CI mode needs a token with read access to the fleet repos (secret FLEET_READ_TOKEN,
// a classic PAT with `repo` read scope, exposed to the script as GH_TOKEN). If neither
// local mode nor a token is available, skip cleanly rather than fail the nightly — the
// check activates the moment the secret is added.
if (!LOCAL_ROOT && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.log('pipeline-drift check skipped: set the FLEET_READ_TOKEN secret (classic PAT, repo:read) to enable cross-repo CI checking. Runnable locally with LOCAL_FLEET_ROOT set.')
  process.exit(0)
}

const failures = []
const fail = (m) => { failures.push(m); console.error(`  DRIFT ${m}`) }
const ok = (m) => console.log(`  OK  ${m}`)

function loadYaml({ repo, dir }) {
  if (LOCAL_ROOT) {
    const p = join(LOCAL_ROOT, dir, '.github', 'workflows', 'deploy.yml')
    if (!existsSync(p)) throw new Error(`local deploy.yml not found at ${p}`)
    return readFileSync(p, 'utf8')
  }
  // CI: fetch via gh api (base64 contents)
  const raw = execSync(
    `gh api repos/${repo}/contents/.github/workflows/deploy.yml --jq .content`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8')
}

for (const p of FLEET) {
  console.log(`\n== ${p.name}`)
  let yml
  try { yml = loadYaml(p) } catch (e) { fail(`${p.name}: cannot load deploy.yml — ${String(e).slice(0, 160)}`); continue }

  // §4a-1 — the prod deploy job must not re-run staging via a needs on the E2E gate.
  // Match only a real YAML `needs:` KEY (line-anchored) — not the string inside an
  // explanatory comment like "does NOT `needs: e2e-staging`" (comment lines start with #).
  if (/^\s*needs:\s*(\[[^\]]*e2e-staging|e2e-staging)\b/m.test(yml)) {
    fail(`${p.name}: a job still has "needs: ...e2e-staging" — prod must gate on the recorded staging run, not re-run it (§4a)`)
  } else ok(`${p.name}: no job re-runs the staging E2E chain via needs (§4a)`)

  // §4a-2 — the staging-gate step must be present (proves the recorded-result gate exists).
  if (yml.includes('Verify staging gate')) ok(`${p.name}: "Verify staging gate" step present (§4a)`)
  else fail(`${p.name}: missing the "Verify staging gate" step — prod deploy has no recorded-staging-result gate (§4a)`)

  // §4a-3 — the staging chain root must be push-only.
  if (yml.includes("if: github.event_name == 'push'")) ok(`${p.name}: staging chain gated push-only (§4a)`)
  else fail(`${p.name}: no "if: github.event_name == 'push'" gate — staging chain may re-run on prod dispatch (§4a)`)

  // §3e — no bare `run: supabase functions deploy` one-liner (all wrapped in retry).
  const bare = (yml.match(/run:\s*supabase functions deploy/g) || []).length
  if (bare > 0) fail(`${p.name}: ${bare} bare "run: supabase functions deploy" one-liner(s) — wrap in retry-with-backoff (§3e)`)
  else if (yml.includes('supabase functions deploy')) ok(`${p.name}: all functions-deploy steps wrapped in retry (§3e)`)
  else ok(`${p.name}: no edge functions to deploy`)

  // §3c — Supabase CLI must be pinned, never `version: latest`.
  if (/version:\s*latest/.test(yml)) fail(`${p.name}: uses "version: latest" for a setup action — pin the Supabase CLI (§3c)`)
  else ok(`${p.name}: no "version: latest" (§3c)`)
}

console.log('')
if (failures.length) {
  console.error(`PIPELINE DRIFT DETECTED (${failures.length} finding(s)) — a deploy.yml has regressed from the hardened standard (standards/deploy-standard.md).`)
  process.exitCode = 1
} else {
  console.log('No pipeline drift — all fleet deploy.yml conform to the hardened standard.')
}
