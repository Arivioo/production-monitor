import * as nodemailer from 'nodemailer'

interface AlertConfig {
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPass: string
  to: string
}

interface TestFailure {
  project: string
  testName: string
  error: string
  screenshotPath?: string
  runUrl?: string
}

export async function sendFailureAlert(config: AlertConfig, failures: TestFailure[]): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: true,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  })

  const failureRows = failures
    .map(
      (f) =>
        `<tr>
          <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600">${f.project}</td>
          <td style="padding:8px;border:1px solid #e5e7eb">${f.testName}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;color:#dc2626">${f.error}</td>
        </tr>`,
    )
    .join('')

  const runLink = failures[0]?.runUrl
    ? `<p style="margin-top:16px"><a href="${failures[0].runUrl}" style="color:#2563eb">View full run logs</a></p>`
    : ''

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#dc2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:18px">Production Monitor Alert</h2>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9">${failures.length} test(s) failed</p>
      </div>
      <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#f9fafb">
              <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Project</th>
              <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Test</th>
              <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Error</th>
            </tr>
          </thead>
          <tbody>${failureRows}</tbody>
        </table>
        ${runLink}
        <p style="margin-top:16px;font-size:12px;color:#6b7280">
          Sent by production-monitor at ${new Date().toISOString()}
        </p>
      </div>
    </div>
  `

  await transporter.sendMail({
    from: `Production Monitor <${config.smtpUser}>`,
    to: config.to,
    subject: `[ALERT] ${failures.length} production test(s) failed — ${failures.map((f) => f.project).join(', ')}`,
    html,
  })
}
