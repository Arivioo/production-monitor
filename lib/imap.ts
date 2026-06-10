// ============================================================
// ImapFlow UID consistency rule — READ BEFORE EDITING
// ------------------------------------------------------------
// ImapFlow methods take { uid: true } in DIFFERENT positions:
//   search(criteria, OPTIONS)        → 2nd arg (2 params)
//   fetchOne(range, query, OPTIONS)  → 3rd arg (3 params)
//   messageDelete(range, OPTIONS)    → 2nd arg (2 params)
//
// If you change ANY IMAP call, verify ALL calls agree on UID
// vs sequence mode. Putting uid:true in fetchOne's 2nd arg
// silently treats UIDs as sequence numbers — works by accident
// when UIDs are small, then breaks as UIDs grow past message
// count. Use fetchOneByUid() below to avoid this entirely.
// ============================================================
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
 *
 * When `subjectFilter` is provided, only emails whose subject contains that
 * string are considered. This prevents race conditions when multiple projects
 * share the same IMAP inbox and run OTP tests concurrently.
 */
export async function waitForOtpEmail(
  config: ImapConfig,
  opts: { timeoutMs?: number; deleteAfter?: boolean; subjectFilter?: string } = {},
): Promise<ParsedOtpEmail> {
  const { timeoutMs = 30_000, deleteAfter = true, subjectFilter } = opts

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
        // Search for messages — filter by subject when provided
        const searchCriteria: Record<string, unknown> = {}
        if (subjectFilter) {
          searchCriteria.subject = subjectFilter
        }
        const uids = await client.search(searchCriteria, { uid: true })

        if (uids.length === 0) {
          lock.release()
          await sleep(1000)
          continue
        }

        // Fetch the latest matching message (highest UID)
        const latestUid = uids[uids.length - 1]
        const msg = await fetchOneByUid(client, latestUid, {
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

        // Delete only this message after reading
        if (deleteAfter) {
          await client.messageDelete(String(latestUid), { uid: true })
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

/**
 * Safe wrapper: always fetches by UID (3rd arg), never sequence number.
 * Prevents the bug where uid:true in the 2nd arg is silently ignored.
 */
function fetchOneByUid(client: ImapFlow, uid: number, query: { envelope?: boolean; source?: boolean }) {
  return client.fetchOne(String(uid), query, { uid: true })
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
