/**
 * Local Triage Runner — the "prefer the local subscription agent over the paid API" layer.
 *
 * Runs on Roger's always-on desktop via a Windows Scheduled Task (every ~20 min). It checks the
 * cloud production-monitor for an UNRESOLVED failure and, if found, runs agent-triage LOCALLY
 * through the Claude Code CLI authed by his SUBSCRIPTION — so remediation costs NO API credits.
 * The cloud/API triage in monitor.yml stays disabled (repo var AGENT_TRIAGE_ENABLED=0) as a
 * fallback for when the desktop is off.
 *
 * Flow:
 *   1. Find the latest "Production Monitor" run. If it didn't FAIL (or is still running) → nothing to do.
 *   2. If we already handled that run id → nothing to do (dedup).
 *   3. Refresh a dedicated PRISTINE clone (so the agent commits from a clean tree, isolated from
 *      Roger's own working copy of the repo).
 *   4. Download the run's test-results artifact (results.json → the failing checks).
 *   5. Run agent-triage.mjs with AGENT_TRIAGE_ENABLED=1 + AGENT_TRIAGE_LOCAL=1 (subscription, no key).
 *   6. Record the handled run id + append to the runner log.
 *
 * Requires on the desktop: git, gh (authenticated), node, and `claude` logged in to the subscription.
 * Env knobs: LOCAL_TRIAGE_DRY_RUN=1 (pass a dry run through), LOCAL_TRIAGE_HOME / _REPO overrides.
 */
import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'

const REPO = process.env.LOCAL_TRIAGE_REPO || 'Arivioo/production-monitor'
const BRANCH = 'master'
const BASE = process.env.LOCAL_TRIAGE_HOME || 'C:\\Business\\_agent-triage'
const WORKDIR = join(BASE, 'production-monitor')
const STATE = join(BASE, 'state.json')
const LOG = join(BASE, 'runner.log')
const DRY = process.env.LOCAL_TRIAGE_DRY_RUN === '1'

function sh(cmd, opts = {}) {
  const out = execSync(cmd, {
    encoding: 'utf-8',
    timeout: opts.timeout || 60_000,
    stdio: opts.inherit ? 'inherit' : 'pipe',
    cwd: opts.cwd,
    env: opts.env || process.env,
  })
  return out ? out.toString() : ''
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n') } catch { /* noop */ }
}
function loadState() { try { return JSON.parse(readFileSync(STATE, 'utf-8')) } catch { return {} } }
function saveState(s) { try { writeFileSync(STATE, JSON.stringify(s, null, 2)) } catch { /* noop */ } }

function main() {
  if (!existsSync(BASE)) mkdirSync(BASE, { recursive: true })
  const state = loadState()

  // 1. pick the run to triage. LOCAL_TRIAGE_FORCE_RUN=<id> overrides the poll (manual re-triage /
  //    testing) and bypasses the green + dedup checks.
  const forceRunId = process.env.LOCAL_TRIAGE_FORCE_RUN
  let run
  if (forceRunId) {
    try {
      run = JSON.parse(sh(`gh run view ${forceRunId} --repo ${REPO} --json databaseId,status,conclusion`))
    } catch (e) { log(`gh run view ${forceRunId} failed: ${e.message.split('\n')[0]}`); process.exit(1) }
    log(`FORCED run #${run.databaseId} (status=${run.status} conclusion=${run.conclusion})`)
  } else {
    try {
      run = JSON.parse(sh(`gh run list --repo ${REPO} --workflow=monitor.yml --limit 1 --json databaseId,status,conclusion,createdAt`))[0]
    } catch (e) { log(`gh run list failed: ${e.message.split('\n')[0]}`); process.exit(1) }
    if (!run) { log('no monitor runs found'); return }
    if (run.status !== 'completed') { log(`latest monitor run #${run.databaseId} still ${run.status} — will re-check next tick`); return }
    if (run.conclusion !== 'failure') { log(`monitor GREEN (run #${run.databaseId} ${run.conclusion}) — nothing to triage`); return }
    if (state.lastHandledRun === run.databaseId) { log(`run #${run.databaseId} already triaged — skip`); return }
  }

  log(`monitor run #${run.databaseId} FAILED — triaging locally on the subscription${DRY ? ' [DRY RUN]' : ''}...`)

  // 3. pristine clone (isolated from Roger's own working copy)
  try {
    if (!existsSync(join(WORKDIR, '.git'))) {
      log('cloning repo (first run)...')
      sh(`gh repo clone ${REPO} "${WORKDIR}"`, { timeout: 120_000 })
    }
    sh(`git fetch origin ${BRANCH}`, { cwd: WORKDIR })
    sh(`git checkout ${BRANCH}`, { cwd: WORKDIR })
    sh(`git reset --hard origin/${BRANCH}`, { cwd: WORKDIR })
    sh(`git clean -fd`, { cwd: WORKDIR })
  } catch (e) { log(`repo refresh failed: ${e.message.split('\n')[0]}`); process.exit(1) }

  // 4. download the run's test-results (extracts test-results/results.json into WORKDIR)
  try {
    sh(`gh run download ${run.databaseId} --repo ${REPO} -n test-results -D "${WORKDIR}"`, { timeout: 120_000 })
  } catch (e) { log(`artifact download failed (agent will investigate via gh instead): ${e.message.split('\n')[0]}`) }

  // 5. run the agent LOCALLY on the subscription — force subscription auth by dropping any API key
  const env = { ...process.env, AGENT_TRIAGE_ENABLED: '1', AGENT_TRIAGE_LOCAL: '1' }
  delete env.ANTHROPIC_API_KEY
  if (DRY) env.AGENT_TRIAGE_DRY_RUN = '1'
  try {
    sh('node scripts/agent-triage.mjs', { cwd: WORKDIR, env, inherit: true, timeout: 15 * 60_000 })
  } catch (e) { log(`agent-triage errored/timed out: ${e.message.split('\n')[0]}`) }

  // 6. record (even on agent error — don't loop on the same broken run every tick)
  state.lastHandledRun = run.databaseId
  state.lastHandledAt = new Date().toISOString()
  saveState(state)
  log(`done with run #${run.databaseId}`)
}

main()
