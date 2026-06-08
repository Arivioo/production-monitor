import { ImapFlow } from 'imapflow'

interface ImapConfig {
  host: string
  port: number
  user: string
  pass: string
}

interface ParsedOtpEmail {
  otp: string | null
  confirmationLink: string | null
  subject: string
  from: string
  date: Date
}

/**
 * Connects to an IMAP mailbox and waits for a new email containing an OTP code.
 * Polls every 3 seconds for up to `timeoutMs` milliseconds.
 * Returns the OTP code and any confirmation link found in the email body.
 */
export async function waitForOtpEmail(
  config: ImapConfig,
  opts: { timeoutMs?: number; deleteAfter?: boolean } = {},
): Promise<ParsedOtpEmail> {
  const { timeoutMs = 30_000, deleteAfter = true } = opts

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  })

  try {
    await client.connect()
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock('INBOX')
      try {
        // Get the most recent message
        const status = await client.status('INBOX', { messages: true })
        if (status.messages === 0) {
          lock.release()
          await sleep(1000)
          continue
        }

        // Fetch the latest message
        const msg = await client.fetchOne('*', {
          envelope: true,
          source: true,
        })

        if (!msg?.source) {
          lock.release()
          await sleep(1000)
          continue
        }

        const rawEmail = msg.source.toString()
        const subject = msg.envelope?.subject || ''
        const from = msg.envelope?.from?.[0]?.address || ''
        const date = msg.envelope?.date || new Date()

        // Extract 6-digit OTP from subject or body
        const otpMatch = rawEmail.match(/\b(\d{6})\b/)
        const otp = otpMatch ? otpMatch[1] : null

        // Extract confirmation link (any URL containing /auth/v1/verify or token)
        const linkMatch = rawEmail.match(/https?:\/\/[^\s"<>]+(?:verify|confirm|callback)[^\s"<>]*/i)
        const confirmationLink = linkMatch ? decodeHtmlEntities(linkMatch[0]) : null

        // Delete the message after reading
        if (deleteAfter) {
          await client.messageDelete('*')
        }

        lock.release()
        return { otp, confirmationLink, subject, from, date }
      } catch {
        lock.release()
        await sleep(1000)
      }
    }

    throw new Error(`No OTP email received within ${timeoutMs}ms`)
  } finally {
    await client.logout().catch(() => {})
  }
}

/**
 * Clears all messages in the INBOX (used before tests to start fresh).
 */
export async function clearInbox(config: ImapConfig): Promise<number> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  })

  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const status = await client.status('INBOX', { messages: true })
      if (status.messages > 0) {
        await client.messageDelete('1:*')
      }
      lock.release()
      return status.messages
    } catch {
      lock.release()
      return 0
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
