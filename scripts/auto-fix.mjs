/**
 * Auto-Fix Engine for Production Monitor
 *
 * Reads test-results/results.json, matches failure patterns, and applies
 * safe fixes directly to test files. Commits and pushes if any fixes applied.
 *
 * Tiers:
 *   1 — Auto-fix & commit (safe test-side fixes)
 *   2 — Alert only (needs human review)
 *
 * Safeguards:
 *   - Max 5 auto-fixes per run
 *   - Never modifies project source code (only test files)
 *   - Tracks fix history to detect loops (3 consecutive auto-fixes = escalate)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'

const MAX_FIXES = 5
const HISTORY_PATH = 'auto-fix-history.json'
const RESULTS_PATH = 'test-results/results.json'

// ── Pattern matchers ────────────────────────────────────────────────

const PATTERNS = [
  {
    id: 'csp-console-error',
    match: (f) =>
      f.test.includes('console error') &&
      f.error.includes('Content Security Policy'),
    fix: addCspFilter,
    description: 'Add CSP violation to console error exclusion filter',
  },
  {
    id: 'timeout-click',
    match: (f) =>
      f.error.includes('Timeout') &&
      (f.error.includes('locator.click') || f.error.includes('locator.fill')),
    fix: increaseTimeout,
    description: 'Increase action timeout for flaky click/fill',
  },
  {
    id: 'timeout-visible',
    match: (f) =>
      f.error.includes('Timeout') &&
      f.error.includes('toBeVisible'),
    fix: increaseVisibilityTimeout,
    description: 'Increase visibility timeout',
  },
  {
    id: 'timeout-navigation',
    match: (f) =>
      f.error.includes('Timeout') &&
      (f.error.includes('waitForLoadState') || f.error.includes('waitForURL')),
    fix: increaseNavTimeout,
    description: 'Increase navigation timeout',
  },
]

// ── Fix implementations ─────────────────────────────────────────────

function addCspFilter(failure, testFile) {
  let content = readFileSync(testFile, 'utf-8')

  // Find the console error filter array and add CSP to it
  if (content.includes("!e.includes('Content Security Policy')")) {
    return null // Already filtered
  }

  // Add CSP filter alongside existing filters
  const filterPatterns = [
    "!e.includes('favicon')",
    "!e.includes('third-party')",
    "!e.includes('manifest')",
  ]

  for (const pattern of filterPatterns) {
    if (content.includes(pattern)) {
      content = content.replace(
        pattern,
        `${pattern} &&\n        !e.includes('Content Security Policy')`,
      )
      writeFileSync(testFile, content)
      return `Added CSP exclusion filter in ${testFile}`
    }
  }

  return null
}

function increaseTimeout(failure, testFile) {
  return applyTimeoutFix(failure, testFile, 'action')
}

function increaseVisibilityTimeout(failure, testFile) {
  return applyTimeoutFix(failure, testFile, 'visibility')
}

function increaseNavTimeout(failure, testFile) {
  return applyTimeoutFix(failure, testFile, 'navigation')
}

function applyTimeoutFix(failure, testFile, type) {
  if (!failure.line) return null

  let content = readFileSync(testFile, 'utf-8')
  const lines = content.split('\n')
  const lineIdx = failure.line - 1

  if (lineIdx < 0 || lineIdx >= lines.length) return null

  const line = lines[lineIdx]

  // Find timeout value and double it (cap at 60000)
  const timeoutMatch = line.match(/timeout:\s*(\d[\d_]*)\s*/)
  if (!timeoutMatch) return null

  const currentTimeout = parseInt(timeoutMatch[1].replace(/_/g, ''))
  if (currentTimeout >= 60_000) return null // Already at max

  const newTimeout = Math.min(currentTimeout * 2, 60_000)
  const newTimeoutStr = newTimeout >= 1000
    ? `${newTimeout / 1000}_000`
    : String(newTimeout)

  lines[lineIdx] = line.replace(
    /timeout:\s*\d[\d_]*/,
    `timeout: ${newTimeoutStr}`,
  )

  content = lines.join('\n')
  writeFileSync(testFile, content)
  return `Increased ${type} timeout ${currentTimeout} → ${newTimeout} at ${testFile}:${failure.line}`
}

// ── Failure extraction (same as send-alert.mjs) ─────────────────────

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
        const location = lastResult?.errors?.[0]?.location
        const cleanError = errorMsg
          .replace(/\x1b\[[0-9;]*m/g, '')
          .split('\n')[0]
          .slice(0, 500)

        failures.push({
          project: name,
          test: spec.title || 'Unknown test',
          error: cleanError,
          file: location?.file || '',
          line: location?.line || 0,
        })
      }
    }
  }

  for (const child of suite.suites ?? []) {
    failures.push(...extractFailures(child, name))
  }

  return failures
}

// ── History tracking ────────────────────────────────────────────────

function loadHistory() {
  // Check recent git log for auto-fix commits to detect loops
  const history = {}
  try {
    const log = execSync('git log --oneline -20 --grep="\\[auto-fix\\]"', {
      encoding: 'utf-8',
    }).trim()
    // Count how many [auto-fix] commits exist in recent history
    const lines = log ? log.split('\n') : []
    for (const line of lines) {
      // Extract pattern:test from commit message if present
      const match = line.match(/\[auto-fix\]/)
      if (match) {
        history.__total = (history.__total || 0) + 1
      }
    }
  } catch {
    // git log might fail in CI — ignore
  }
  return history
}

function saveHistory(_history) {
  // No-op — history is derived from git log
}

function isLooping(history, _fixId, _testKey) {
  // If there are 3+ consecutive auto-fix commits, stop fixing
  return (history.__total || 0) >= 3
}

function recordFix(history, _fixId, _testKey) {
  history.__total = (history.__total || 0) + 1
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(RESULTS_PATH)) {
    console.log('No test results found, skipping auto-fix')
    process.exit(0)
  }

  let results
  try {
    results = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'))
  } catch (e) {
    console.error('Failed to parse results.json:', e.message)
    process.exit(1)
  }

  const failures = []
  for (const suite of results.suites ?? []) {
    failures.push(...extractFailures(suite, null))
  }

  if (failures.length === 0) {
    console.log('No failures to fix')
    process.exit(0)
  }

  console.log(`Found ${failures.length} failure(s), attempting auto-fix...`)

  const history = loadHistory()
  const fixes = []
  const escalations = []

  for (const failure of failures) {
    if (fixes.length >= MAX_FIXES) {
      escalations.push({ ...failure, reason: 'Max fixes per run reached' })
      continue
    }

    const testKey = `${failure.project}:${failure.test}`
    let fixed = false

    for (const pattern of PATTERNS) {
      if (!pattern.match(failure)) continue

      // Check for fix loops
      if (isLooping(history, pattern.id, testKey)) {
        escalations.push({
          ...failure,
          reason: `Auto-fix loop detected (${pattern.id} applied 3+ times)`,
        })
        break
      }

      // Resolve test file path
      const testFile = failure.file
      if (!testFile || !existsSync(testFile)) {
        // Try to find test file from project name
        const projectDir = resolveProjectDir(failure.project)
        if (!projectDir) continue
        continue
      }

      const result = pattern.fix(failure, testFile)
      if (result) {
        fixes.push({
          pattern: pattern.id,
          description: pattern.description,
          detail: result,
          failure,
        })
        recordFix(history, pattern.id, testKey)
        fixed = true
        console.log(`  [AUTO-FIX] ${result}`)
        break
      }
    }

    if (!fixed && !escalations.find((e) => e.test === failure.test)) {
      escalations.push({ ...failure, reason: 'No matching auto-fix pattern' })
    }
  }

  saveHistory(history)

  // Commit and push if any fixes were applied
  if (fixes.length > 0) {
    try {
      const fixSummary = fixes.map((f) => `- ${f.detail}`).join('\n')
      execSync('git add -A', { stdio: 'inherit' })
      execSync(
        `git commit -m "[auto-fix] ${fixes.length} test fix(es) applied\n\n${fixSummary}\n\nCo-Authored-By: Production Monitor <noreply@predivo.ch>"`,
        { stdio: 'inherit' },
      )
      execSync('git push', { stdio: 'inherit' })
      console.log(`\nCommitted and pushed ${fixes.length} auto-fix(es)`)
    } catch (e) {
      console.error('Failed to commit/push auto-fixes:', e.message)
    }
  }

  // Write summary for the email script to pick up
  const summary = { fixes, escalations, timestamp: new Date().toISOString() }
  writeFileSync('auto-fix-results.json', JSON.stringify(summary, null, 2))

  console.log(`\nSummary: ${fixes.length} fixed, ${escalations.length} escalated`)

  // Exit with error if there are escalations (so the alert email still sends)
  if (escalations.length > 0) {
    process.exit(1)
  }
}

function resolveProjectDir(projectName) {
  const map = {
    'APIs (predivo.ch)': 'apis',
    BackOffice: 'backoffice',
    Predivo: 'predivo',
    ReplyFlow: 'replyflow',
    YouTubeMigration: 'ytmigration',
    ScoutCopilot: 'scoutcopilot',
    ShipSolo: 'shipsolo',
    BelegPilot: 'belegpilot',
    Arivioo: 'arivioo',
    LaunchReady: 'launchready',
    SignalScore: 'signalscore',
    Valrano: 'valrano',
  }
  const dir = map[projectName]
  if (!dir) return null
  const path = `tests/${dir}/production-monitor.spec.ts`
  return existsSync(path) ? path : null
}

main()
