/**
 * Auto-Heal Engine for Production Monitor
 *
 * Detects site-level failures (blank page, no content, MIME errors) and
 * triggers a redeploy of the affected project via GitHub Actions.
 *
 * Safeguards:
 *   - Only triggers after 2 consecutive failures (checks previous run)
 *   - Max 1 redeploy per project per 6 hours
 *   - Always sends email notification (whether healed or not)
 *   - Only redeploys from main/master HEAD (same as manual push)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'

const RESULTS_PATH = 'test-results/results.json'
const HEAL_STATE_PATH = 'auto-heal-state.json'
const COOLDOWN_MS = 6 * 60 * 60 * 1000 // 6 hours

// Project → GitHub repo + workflow file + deploy branch
const PROJECT_CONFIG = {
  Valrano: { repo: 'Arivioo/Valrano', workflow: 'deploy.yml', branch: 'main' },
  BackOffice: { repo: 'Arivioo/BackOffice', workflow: 'deploy.yml', branch: 'main' },
  ScoutCopilot: { repo: 'Arivioo/ScoutCopilot', workflow: 'deploy.yml', branch: 'main' },
  YouTubeMigration: { repo: 'Arivioo/youtube-migration', workflow: 'deploy.yml', branch: 'main' },
  ReplyFlow: { repo: 'Arivioo/replyflow', workflow: 'deploy.yml', branch: 'main' },
  ShipSolo: { repo: 'Arivioo/Distribution-OS', workflow: 'deploy.yml', branch: 'main' },
  BelegPilot: { repo: 'Arivioo/BelegPilot', workflow: 'deploy.yml', branch: 'main' },
  Arivioo: { repo: 'Arivioo/Cursor_Arivioo', workflow: 'deploy.yml', branch: 'main' },
  LaunchReady: { repo: 'Arivioo/launchready', workflow: 'deploy.yml', branch: 'main' },
  SignalScore: { repo: 'Arivioo/signalscore', workflow: 'deploy.yml', branch: 'main' },
  Predivo: { repo: 'Arivioo/predivo', workflow: 'deploy.yml', branch: 'main' },
  'APIs (predivo.ch)': { repo: 'Arivioo/APIs', workflow: 'deploy.yml', branch: 'main' },
  SignalForgeAI: { repo: 'Arivioo/SignalForgeAI', workflow: 'deploy.yml', branch: 'main' },
}

// Patterns that indicate the SITE is broken (not just a test flake)
const SITE_DOWN_PATTERNS = [
  /body.*toBeEmpty/i,
  /Expected.*JavaScript.*module.*MIME/i,
  /net::ERR_/i,
  /page\.goto.*Timeout/i,
  /ERR_CONNECTION_REFUSED/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /404 Not Found/i,
  /503 Service Unavailable/i,
  /502 Bad Gateway/i,
]

function isSiteDown(failure) {
  // Check if the failure indicates the site itself is broken
  const testName = failure.test.toLowerCase()
  const error = failure.error

  // "landing page loads" or "body not empty" failures are site-level
  if (testName.includes('landing page loads') || testName.includes('not.*empty')) {
    return true
  }

  // MIME type error = broken deploy
  for (const pattern of SITE_DOWN_PATTERNS) {
    if (pattern.test(error)) return true
  }

  return false
}

function loadState() {
  // State is stored as a workflow artifact — check if file exists from cache
  if (existsSync(HEAL_STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(HEAL_STATE_PATH, 'utf-8'))
    } catch {
      return {}
    }
  }
  return {}
}

function saveState(state) {
  writeFileSync(HEAL_STATE_PATH, JSON.stringify(state, null, 2))
}

/**
 * Check if the previous monitor run also failed.
 * This gives us "2 consecutive failures" without needing persisted state.
 */
function previousRunFailed() {
  try {
    const runsJson = execSync(
      'gh run list --workflow=monitor.yml --status=completed --limit=2 --json conclusion',
      { encoding: 'utf-8', timeout: 15_000 }
    )
    const runs = JSON.parse(runsJson)
    // runs[0] = most recent completed (could be current), runs[1] = previous
    // If the previous run also failed, we have 2 consecutive failures
    if (runs.length >= 1 && runs[0].conclusion === 'failure') {
      return true
    }
  } catch (e) {
    console.log(`  [warn] Could not check previous run: ${e.message}`)
  }
  return false
}

function extractFailures(suite, parentName) {
  const failures = []
  const isDescribe = suite.title && !suite.title.endsWith('.spec.ts')
  const name = isDescribe
    ? suite.title.replace(/ — Production Monitor$/, '')
    : parentName || suite.title || 'Unknown'

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status === 'unexpected' || test.status === 'flaky') {
        const lastResult = test.results?.[test.results.length - 1]
        const errorMsg =
          lastResult?.errors?.[0]?.message ||
          lastResult?.error?.message ||
          'Unknown error'
        const cleanError = errorMsg
          .replace(/\x1b\[[0-9;]*m/g, '')
          .split('\n')[0]
          .slice(0, 500)

        failures.push({
          project: name,
          test: spec.title || 'Unknown test',
          error: cleanError,
        })
      }
    }
  }

  for (const child of suite.suites ?? []) {
    failures.push(...extractFailures(child, name))
  }

  return failures
}

function triggerRedeploy(project, config) {
  try {
    execSync(
      `gh workflow run ${config.workflow} --repo ${config.repo} --ref ${config.branch}`,
      { stdio: 'pipe', timeout: 30_000 }
    )
    return true
  } catch (e) {
    console.error(`  Failed to trigger redeploy for ${project}: ${e.message}`)
    return false
  }
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(RESULTS_PATH)) {
    console.log('[auto-heal] No test results found, skipping')
    process.exit(0)
  }

  let results
  try {
    results = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'))
  } catch (e) {
    console.error('[auto-heal] Failed to parse results.json:', e.message)
    process.exit(0)
  }

  const failures = []
  for (const suite of results.suites ?? []) {
    failures.push(...extractFailures(suite, null))
  }

  // Identify site-level failures
  const siteFailures = failures.filter(isSiteDown)
  if (siteFailures.length === 0) {
    console.log('[auto-heal] No site-level failures detected')
    process.exit(0)
  }

  // Deduplicate by project
  const affectedProjects = [...new Set(siteFailures.map(f => f.project))]
  console.log(`[auto-heal] Site-level failures detected for: ${affectedProjects.join(', ')}`)

  const state = loadState()
  const now = Date.now()
  const healed = []
  const skipped = []

  // Check if the previous run also failed (2 consecutive failures requirement)
  const prevFailed = previousRunFailed()
  if (!prevFailed) {
    console.log('[auto-heal] First failure — will trigger heal on next consecutive failure')
    for (const project of affectedProjects) {
      skipped.push({ project, reason: 'First failure — waiting for 2nd consecutive' })
    }
    const summary = { healed, skipped, timestamp: new Date().toISOString() }
    writeFileSync('auto-heal-results.json', JSON.stringify(summary, null, 2))
    process.exit(0)
  }

  console.log('[auto-heal] 2+ consecutive failures confirmed — proceeding with heal')

  for (const project of affectedProjects) {
    const config = PROJECT_CONFIG[project]
    if (!config) {
      console.log(`  [skip] ${project}: no deploy config`)
      skipped.push({ project, reason: 'No deploy config' })
      continue
    }

    const projectState = state[project] || { lastHeal: 0 }

    // Check: cooldown (max 1 redeploy per 6h)
    const timeSinceLastHeal = now - (projectState.lastHeal || 0)
    if (timeSinceLastHeal < COOLDOWN_MS) {
      const hoursLeft = ((COOLDOWN_MS - timeSinceLastHeal) / 3600000).toFixed(1)
      console.log(`  [cooldown] ${project}: last healed ${hoursLeft}h ago (6h cooldown)`)
      skipped.push({ project, reason: `Cooldown active (${hoursLeft}h remaining)` })
      continue
    }

    // Trigger redeploy
    console.log(`  [HEAL] ${project}: triggering redeploy via ${config.repo}/${config.workflow}`)
    const success = triggerRedeploy(project, config)

    if (success) {
      projectState.lastHeal = now
      state[project] = projectState
      healed.push(project)
      console.log(`  [OK] ${project}: redeploy triggered successfully`)
    } else {
      skipped.push({ project, reason: 'gh workflow run failed' })
    }
  }

  saveState(state)

  // Write summary for alert email to include
  const summary = {
    healed,
    skipped,
    timestamp: new Date().toISOString(),
  }
  writeFileSync('auto-heal-results.json', JSON.stringify(summary, null, 2))

  console.log(`\n[auto-heal] Summary: ${healed.length} healed, ${skipped.length} skipped`)
}

main()
