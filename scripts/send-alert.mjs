import { createTransport } from 'nodemailer'
import { readFileSync, existsSync } from 'fs'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL, GITHUB_RUN_URL } = process.env

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL) {
  console.error('Missing SMTP or alert config')
  process.exit(1)
}

/** Strip ANSI escape codes from error messages */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Recursively extract failed specs from nested suite structure.
 *  Playwright nests: file-suite (title=filename) > describe-suite (title=describe name) > specs.
 *  We prefer the deepest suite title that isn't a filename (contains " — "). */
function extractFailures(suite, parentName) {
  const failures = []
  // Use this suite's title if it looks like a describe name, otherwise fall back to parent
  const isDescribe = suite.title && !suite.title.endsWith('.spec.ts')
  const name = isDescribe ? suite.title.replace(/ — Production Monitor$/, '') : (parentName || suite.title || 'Unknown')

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status === 'unexpected' || test.status === 'flaky') {
        const lastResult = test.results?.[test.results.length - 1]
        const errorMsg = lastResult?.errors?.[0]?.message
          || lastResult?.error?.message
          || 'Unknown error'
        const location = lastResult?.errors?.[0]?.location
        const cleanError = stripAnsi(errorMsg).split('\n')[0].slice(0, 300)
        const fileRef = location
          ? `${location.file?.split('/').pop()}:${location.line}`
          : ''

        failures.push({
          project: name,
          test: spec.title || 'Unknown test',
          error: cleanError,
          file: fileRef,
        })
      }
    }
  }

  for (const child of suite.suites ?? []) {
    failures.push(...extractFailures(child, name))
  }

  return failures
}

// Parse Playwright JSON results
let failures = []
const resultsPath = 'test-results/results.json'
if (existsSync(resultsPath)) {
  try {
    const results = JSON.parse(readFileSync(resultsPath, 'utf-8'))
    for (const suite of results.suites ?? []) {
      failures.push(...extractFailures(suite, null))
    }
  } catch (e) {
    failures = [{ project: 'Parser', test: 'results.json', error: `Failed to parse: ${e.message}` }]
  }
}

if (failures.length === 0) {
  failures = [{ project: 'Unknown', test: 'Unknown', error: 'Tests failed but no details available' }]
}

// Group failures by project for summary
const projectGroups = {}
for (const f of failures) {
  if (!projectGroups[f.project]) projectGroups[f.project] = []
  projectGroups[f.project].push(f)
}
const projectSummary = Object.entries(projectGroups)
  .map(([name, items]) => `${name} (${items.length})`)
  .join(', ')

const failureRows = failures
  .map(
    (f) =>
      `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap">${f.project}</td>
        <td style="padding:8px;border:1px solid #e5e7eb">${f.test}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;color:#dc2626;font-family:monospace;font-size:12px">${f.error}${f.file ? `<br><span style="color:#6b7280;font-size:11px">${f.file}</span>` : ''}</td>
      </tr>`,
  )
  .join('')

const html = `
  <div style="font-family:system-ui,sans-serif;max-width:700px;margin:0 auto">
    <div style="background:#dc2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
      <h2 style="margin:0;font-size:18px">Production Monitor Alert</h2>
      <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${failures.length} test(s) failed across ${Object.keys(projectGroups).length} project(s)</p>
    </div>
    <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f9fafb">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Project</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Test</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Error</th>
          </tr>
        </thead>
        <tbody>${failureRows}</tbody>
      </table>
      ${GITHUB_RUN_URL ? `<p style="margin-top:16px"><a href="${GITHUB_RUN_URL}" style="color:#2563eb">View full run logs</a></p>` : ''}
      <p style="margin-top:16px;font-size:12px;color:#6b7280">
        Sent by production-monitor at ${new Date().toISOString()}
      </p>
    </div>
  </div>
`

const transporter = createTransport({
  host: SMTP_HOST,
  port: parseInt(SMTP_PORT || '465'),
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
})

await transporter.sendMail({
  from: `Production Monitor <${SMTP_USER}>`,
  to: ALERT_EMAIL,
  subject: `[ALERT] ${failures.length} test(s) failed — ${projectSummary}`,
  html,
})

console.log(`Alert sent to ${ALERT_EMAIL} with ${failures.length} failure(s): ${projectSummary}`)
