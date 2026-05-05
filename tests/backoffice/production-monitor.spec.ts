import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'
import { waitForOtpEmail, clearInbox } from '../../lib/imap'
import { createClient } from '@supabase/supabase-js'

const SITE_URL = process.env.BACKOFFICE_URL || 'https://backoffice.predivo.ch'
const SUPABASE_URL = process.env.BACKOFFICE_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.BACKOFFICE_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.BACKOFFICE_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

// IMAP config for reading OTP emails (test email that receives OTP)
const IMAP_HOST = process.env.IMAP_HOST || 'tertia.sui-inter.net'
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993')
const IMAP_USER = process.env.IMAP_USER || 'noreply@backoffice.predivo.ch'
const IMAP_PASS = process.env.IMAP_PASS || ''
const OTP_TEST_EMAIL = process.env.OTP_TEST_EMAIL || IMAP_USER

const AUTH_OPTS = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE_KEY,
  anonKey: ANON_KEY,
  testEmail: TEST_EMAIL,
  siteUrl: SITE_URL,
}

const IMAP_OPTS = {
  host: IMAP_HOST,
  port: IMAP_PORT,
  user: IMAP_USER,
  pass: IMAP_PASS,
}

test.describe('BackOffice — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
    // Also ensure the OTP test user exists (if different from magic link test user)
    if (OTP_TEST_EMAIL !== TEST_EMAIL) {
      await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, OTP_TEST_EMAIL)
    }
  })

  // ── Auth page ──────────────────────────────────────────────────

  test('auth page loads with form', async ({ page }) => {
    await page.goto(`${SITE_URL}/auth`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('button[type="submit"]')).toBeVisible({ timeout: 10_000 })
  })

  // ── Full login (magic link shortcut) ──────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    const url = page.url()
    expect(url).not.toContain('/auth')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 10_000 })
  })

  // ── Real E2E OTP flow (tests actual user experience) ─────────

  test('E2E OTP: request code → email delivery → enter code → dashboard', async ({ page }) => {
    test.skip(!IMAP_PASS, 'IMAP_PASS not configured — skipping E2E OTP test')
    test.setTimeout(90_000) // Email delivery can be slow

    // 1. Clear inbox to start fresh
    await clearInbox(IMAP_OPTS)

    // 2. Navigate to auth page
    await page.goto(`${SITE_URL}/auth`)
    await page.waitForLoadState('networkidle')

    // 3. Enter email and submit OTP request
    const emailInput = page.locator('input[type="email"]')
    await expect(emailInput).toBeVisible({ timeout: 10_000 })
    await emailInput.fill(OTP_TEST_EMAIL)
    await page.locator('button[type="submit"]').click()

    // 4. Wait for OTP step — either OTP inputs appear or an error about rate limiting
    const otpGroup = page.locator('[role="group"][aria-label="Bestätigungscode"]')
    const errorMsg = page.locator('text=/5 seconds|rate limit/i')
    const result = await Promise.race([
      otpGroup.waitFor({ timeout: 20_000 }).then(() => 'otp' as const),
      errorMsg.waitFor({ timeout: 20_000 }).then(() => 'ratelimit' as const),
    ]).catch(() => 'timeout' as const)
    if (result === 'ratelimit') {
      // Wait and retry the OTP request
      await new Promise((r) => setTimeout(r, 6000))
      await page.locator('button[type="submit"]').click()
      await expect(otpGroup).toBeVisible({ timeout: 20_000 })
    } else if (result === 'timeout') {
      // Fallback: check if OTP group appeared anyway
      await expect(otpGroup).toBeVisible({ timeout: 5_000 })
    }

    // 5. Read OTP email from IMAP
    const email = await waitForOtpEmail(IMAP_OPTS, { timeoutMs: 45_000, deleteAfter: true })
    expect(email.otp, 'Email should contain a 6-digit OTP code').toBeTruthy()
    expect(email.otp).toMatch(/^\d{6}$/)

    // 6. Enter OTP code digit by digit into the 6 input boxes
    const otpCode = email.otp!
    const digitInputs = otpGroup.locator('input[inputmode="numeric"]')
    await expect(digitInputs).toHaveCount(6)
    for (let i = 0; i < 6; i++) {
      await digitInputs.nth(i).fill(otpCode[i])
    }

    // 7. Verify redirect to dashboard
    await page.waitForURL((url) => !url.pathname.includes('/auth'), { timeout: 15_000 })
    await page.waitForLoadState('networkidle')
    await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 10_000 })
  })

  test('E2E OTP: email contains valid links (no 404)', async ({ page }) => {
    test.skip(!IMAP_PASS, 'IMAP_PASS not configured — skipping email link test')
    test.setTimeout(90_000)

    // 1. Clear inbox and wait to avoid Supabase 5-second cooldown from previous test
    await clearInbox(IMAP_OPTS)
    await new Promise((r) => setTimeout(r, 10_000))

    // 2. Trigger OTP email via anon client (real SMTP delivery)
    const anonClient = createClient(SUPABASE_URL, ANON_KEY)
    const isRateLimited = (err: { message?: string } | null) =>
      err?.message?.toLowerCase().includes('security purposes') ||
      err?.message?.toLowerCase().includes('rate limit') ||
      err?.message?.toLowerCase().includes('after') && err?.message?.toLowerCase().includes('seconds')
    let { error } = await anonClient.auth.signInWithOtp({ email: OTP_TEST_EMAIL })
    if (isRateLimited(error)) {
      // Wait longer and retry
      await new Promise((r) => setTimeout(r, 10_000))
      const retry = await anonClient.auth.signInWithOtp({ email: OTP_TEST_EMAIL })
      error = retry.error
    }
    if (isRateLimited(error)) {
      test.skip(true, 'Rate limited — skipping email link test this run')
      return
    }
    expect(error, `signInWithOtp failed: ${error?.message}`).toBeNull()

    // 3. Read email and check for links
    const email = await waitForOtpEmail(IMAP_OPTS, { timeoutMs: 45_000, deleteAfter: true })

    // 4. If there's a confirmation link, verify it doesn't 404
    if (email.confirmationLink) {
      const response = await page.goto(email.confirmationLink, { waitUntil: 'domcontentloaded' })
      const status = response?.status() ?? 0
      expect(status, `Email link returned ${status}: ${email.confirmationLink}`).not.toBe(404)
    }

    // 5. Verify OTP code was present (basic sanity)
    expect(email.otp).toMatch(/^\d{6}$/)
  })

  // ── Core pages load (authenticated) ────────────────────────────

  test('CRM page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/crm`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/crm')
  })

  test('projects page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/projects`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/projects')
  })

  test('documents page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/dokumente`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
  })

  test('banking page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/banking`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/banking')
  })

  test('stripe page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/stripe`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/stripe')
  })

  test('health monitor page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/health-monitor`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
  })

  test('debtors page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/invoicing`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
  })

  test('bills page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/bills`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
  })

  test('accounting page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/accounting`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/accounting')
  })

  test('time tracking page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/time-tracking`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
  })

  test('settings page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/settings`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/settings')
  })

  // ── Dashboard KPI cards ────────────────────────────────────────

  test('dashboard KPI cards visible', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.waitForLoadState('networkidle')
    const kpiLabels = ['Offene Debitoren', 'Offene Kreditoren', 'Umsatz']
    for (const label of kpiLabels) {
      await expect(
        page.locator(`text=${label}`).first(),
        `KPI card "${label}" should be visible`,
      ).toBeVisible({ timeout: 15_000 })
    }
  })

  // ── Sidebar navigation ─────────────────────────────────────────

  test('sidebar navigation has key items', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.waitForLoadState('networkidle')
    // Check for key nav items that exist in the sidebar (using actual labels from AppLayout.tsx)
    const navItems = ['Dashboard', 'Kontakte', 'Projekte', 'Debitoren', 'Kreditoren', 'Buchhaltung']
    for (const item of navItems) {
      await expect(
        page.locator(`text=${item}`).first(),
        `Sidebar should contain "${item}"`,
      ).toBeVisible({ timeout: 10_000 })
    }
  })

  // ── Stripe balance ─────────────────────────────────────────────

  test('Stripe page shows balance section', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/stripe`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    const balanceLocator = page.locator('text=/CHF|Balance|Saldo|Guthaben|Umsatz/i').first()
    await expect(balanceLocator).toBeVisible({ timeout: 15_000 })
  })

  // ── Console errors ─────────────────────────────────────────────

  test('no critical console errors on dashboard', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await loginViaMagicLink(page, AUTH_OPTS)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(3000)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('manifest') &&
        !e.includes('third-party') &&
        !e.includes('net::ERR_') &&
        !e.includes('ResizeObserver') &&
        !e.includes('Non-Error promise rejection'),
    )
    expect(
      criticalErrors,
      `Critical console errors:\n${criticalErrors.join('\n')}`,
    ).toHaveLength(0)
  })
})
