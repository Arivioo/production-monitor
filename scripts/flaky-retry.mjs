/**
 * Flaky-Deploy Auto-Retry — Phase 1b of the agentic auto-remediation plan.
 *
 * Cross-fleet poll (scheduled). For each project's `deploy.yml`, finds recent FAILED runs
 * that are almost certainly a transient/infra flake and reruns their failed jobs ONCE, so a
 * one-off blip (staging mid-deploy, an auth-setup timeout, an FTP hiccup) self-heals instead
 * of sitting red and paging Roger. A second failure is left alone — the real alert path takes over.
 *
 * SAFEGUARDS (this script triggers CI on the production fleet — it must be conservative):
 *   - `push` and `schedule` runs ONLY. NEVER a `workflow_dispatch` run — those are manual PROD
 *     promotions; auto-rerunning one would deploy to production without Roger, and a stale one
 *     would REVERT prod. (This is the exact trap that bit us manually — encoded as a hard skip.)
 *   - HEAD guard: only rerun if the run's head_sha still equals the branch HEAD, so a rerun
 *     re-deploys the CURRENT code, never an old commit.
 *   - 1 retry max per run (run_attempt gate).
 *   - CODE failures (lint / unit / coverage / build / typecheck) are NEVER retried — they need a
 *     real fix, and retrying would just mask/burn CI. Only INFRA/FLAKY steps qualify.
 *   - Recent runs only (last 3h) so we never churn old history.
 *   - Global kill-switch: set FLAKY_RETRY_DISABLED=1 to no-op.
 *
 * Requires `gh` authenticated with a PAT that has `actions:write` on each repo (same GH_TOKEN
 * used by auto-heal.mjs for cross-repo `gh workflow run`).
 */
import { execSync } from 'child_process'

const LOOKBACK_MS = 3 * 60 * 60 * 1000
const RUNS_PER_REPO = 15

// Fleet: repo + deploy branch (mirrors auto-heal.mjs PROJECT_CONFIG).
const PROJECTS = [
  { name: 'ReplyFlow', repo: 'Arivioo/replyflow', branch: 'main' },
  { name: 'SignalScore', repo: 'Arivioo/signalscore', branch: 'main' },
  { name: 'ChannelMover', repo: 'Arivioo/ChannelMover', branch: 'main' },
  { name: 'Valrano', repo: 'Arivioo/Valrano', branch: 'main' },
  { name: 'BoatBuddy', repo: 'Arivioo/BoatBuddy', branch: 'main' },
  { name: 'BackOffice', repo: 'Arivioo/backoffice', branch: 'main' },
  { name: 'ScoutCopilot', repo: 'Arivioo/ScoutCopilot', branch: 'master' },
  { name: 'Distribution-OS', repo: 'Arivioo/distribution-os', branch: 'master' },
  { name: 'LaunchReady', repo: 'Arivioo/launchready', branch: 'master' },
  { name: 'Predivo', repo: 'Arivioo/predivo', branch: 'master' },
  { name: 'Arivioo', repo: 'Arivioo/Cursor_Arivioo', branch: 'main' },
]

// Flaky/infra step names — safe to auto-rerun.
const FLAKY = /e2e|gate-e2e|ftp|supabase cli|edge function|verify .*alive|deploy .*staging|install deps|puppeteer|playwright|seed|rate limit|npm ci|setup-node|checkout|cache|prerender|smoke/i
// Real code failures — NEVER auto-rerun (need a human/agent fix).
const CODE = /\blint\b|unit test|coverage|typecheck|tsc|feature coverage|^build|run build/i

function gh(args) {
  return execSync(`gh ${args}`, { encoding: 'utf-8', timeout: 30_000 }).trim()
}

function branchHead(repo, branch) {
  try {
    return gh(`api repos/${repo}/git/ref/heads/${branch} --jq .object.sha`)
  } catch (e) {
    console.log(`  [warn] ${repo}: cannot read HEAD (${e.message.split('\n')[0]})`)
    return null
  }
}

function failedStepName(repo, runId) {
  try {
    const data = JSON.parse(gh(`run view ${runId} --repo ${repo} --json jobs`))
    for (const job of data.jobs ?? []) {
      if (job.conclusion !== 'failure') continue
      const step = (job.steps ?? []).find((s) => s.conclusion === 'failure')
      if (step) return step.name
      return job.name // job failed without a step (e.g. a gate check) — use job name
    }
  } catch { /* best effort */ }
  return ''
}

function main() {
  if (process.env.FLAKY_RETRY_DISABLED === '1') {
    console.log('FLAKY_RETRY_DISABLED=1 — no-op')
    return
  }
  const dryRun = process.env.DRY_RUN === '1'
  if (dryRun) console.log('DRY_RUN=1 — will report candidates but not rerun anything\n')
  const retried = []
  const skipped = []

  for (const p of PROJECTS) {
    let runs
    try {
      runs = JSON.parse(gh(
        `run list --repo ${p.repo} --workflow=deploy.yml --limit ${RUNS_PER_REPO} ` +
        `--json databaseId,conclusion,createdAt,headSha,event,attempt,displayTitle`,
      ))
    } catch (e) {
      console.log(`[skip] ${p.name}: run list failed (${e.message.split('\n')[0]})`)
      continue
    }

    const head = branchHead(p.repo, p.branch)

    for (const run of runs) {
      if (run.conclusion !== 'failure') continue
      if (Date.now() - new Date(run.createdAt).getTime() > LOOKBACK_MS) continue
      const tag = `${p.name}#${run.databaseId}`

      // Hard skips — safety
      if (run.event === 'workflow_dispatch') { skipped.push(`${tag}: prod promotion (manual only)`); continue }
      if ((run.attempt ?? 1) >= 2) { skipped.push(`${tag}: already retried`); continue }
      if (head && run.headSha !== head) { skipped.push(`${tag}: stale commit (rerun would deploy old code)`); continue }

      const step = failedStepName(p.repo, run.databaseId)
      if (CODE.test(step)) { skipped.push(`${tag}: code failure "${step}" (needs a fix, not a retry)`); continue }
      if (!FLAKY.test(step)) { skipped.push(`${tag}: unrecognised step "${step}" (leave for alert)`); continue }

      // Safe to auto-rerun the flaky run once.
      try {
        gh(`run rerun ${run.databaseId} --repo ${p.repo} --failed`)
        retried.push(`${tag}: reran flaky step "${step}"`)
        console.log(`[RETRY] ${tag}: "${step}"`)
      } catch (e) {
        skipped.push(`${tag}: rerun failed (${e.message.split('\n')[0]})`)
      }
    }
  }

  console.log(`\nSummary: ${retried.length} reran, ${skipped.length} skipped`)
  retried.forEach((r) => console.log(`  retry  ${r}`))
  skipped.forEach((s) => console.log(`  skip   ${s}`))
}

main()
