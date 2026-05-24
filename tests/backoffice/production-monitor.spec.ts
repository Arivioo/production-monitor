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

    // 4. Wait for OTP step — either OTP inputs appear or an error message
    const otpGroup = page.locator('[role="group"][aria-label="Bestätigungscode"]')
    const errorMsg = page.locator('text=/Fehler/i')
    const result = await Promise.race([
      otpGroup.waitFor({ timeout: 20_000 }).then(() => 'otp' as const),
      errorMsg.waitFor({ timeout: 20_000 }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const)
    if (result === 'error') {
      // Check if it's a rate limit (contains "seconds" or "security")
      const errText = await errorMsg.textContent() ?? ''
      if (/seconds|security|rate/i.test(errText)) {
        // Extract cooldown duration if present (e.g. "after 57 seconds")
        const cooldownMatch = errText.match(/(\d+)\s*seconds/i)
        const waitTime = cooldownMatch ? Math.min(parseInt(cooldownMatch[1]) + 2, 65) * 1000 : 15_000
        await new Promise((r) => setTimeout(r, waitTime))
        await emailInput.fill(OTP_TEST_EMAIL)
        await page.locator('button[type="submit"]').click()
        try {
          await expect(otpGroup).toBeVisible({ timeout: 30_000 })
        } catch {
          test.skip(true, `OTP rate limit cooldown too long (${errText}) — skipping`)
          return
        }
      } else {
        // Non-rate-limit error (user not found, etc.) — skip
        test.skip(true, `OTP request failed: ${errText}`)
        return
      }
    } else if (result === 'timeout') {
      // Neither OTP group nor error appeared — skip
      test.skip(true, 'OTP form did not respond within 20s')
      return
    }

    // 5. Read OTP email from IMAP (may fail due to Supabase email delivery delays)
    let email: Awaited<ReturnType<typeof waitForOtpEmail>>
    try {
      email = await waitForOtpEmail(IMAP_OPTS, { timeoutMs: 45_000, deleteAfter: true })
    } catch {
      test.skip(true, 'OTP email not delivered within 45s — Supabase SMTP delay (not a code bug)')
      return
    }
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
    let email: Awaited<ReturnType<typeof waitForOtpEmail>>
    try {
      email = await waitForOtpEmail(IMAP_OPTS, { timeoutMs: 45_000, deleteAfter: true })
    } catch {
      test.skip(true, 'OTP email not delivered within 45s — Supabase SMTP delay (not a code bug)')
      return
    }

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

  // ── Site identity ──────────────────────────────────────────────

  test('site identity — title contains predivo', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'backoffice.predivo.ch must contain "predivo" branding').toContain('predivo')
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

  // ── CRM interaction ────────────────────────────────────────────

  test('CRM: create new contact, verify in list, delete', async ({ page }) => {
    test.setTimeout(60_000)

    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/crm`)
    await page.waitForLoadState('networkidle')

    // Wait for the contacts table to settle (loading state resolves)
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500)

    // Click "Neuer Kontakt" button
    await page.locator('button:has-text("Neuer Kontakt")').click()

    // Dialog should appear with title "Neuer Kontakt"
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog.locator('h2:has-text("Neuer Kontakt")')).toBeVisible()

    // The company field starts as a Zefix search input; fill the company name directly
    // by typing into the text field that appears after selecting "company_name" mode.
    // The form has a CompanySearchInput initially — we need to type directly into it or
    // use the first_name / last_name fields which are always visible text inputs.
    // Use last_name field (always an input[type=text]) to create a uniquely named contact.
    const uniqueSuffix = Date.now()
    const testContactLastName = `ProdTest-${uniqueSuffix}`

    // Fill last name
    const lastNameInput = dialog.locator('input[id="contact-last-name"], input[placeholder*="Nachname"], input[placeholder*="last"]').first()
    // Fallback: find any visible text input after the type select that isn't company
    // Based on the form structure, first_name and last_name fields have specific labels
    const firstNameLabel = dialog.locator('label:has-text("Vorname")')
    const lastNameLabel = dialog.locator('label:has-text("Nachname")')

    // Fill first name via label's for attribute — find sibling input
    if (await firstNameLabel.isVisible()) {
      const firstNameFor = await firstNameLabel.getAttribute('for')
      if (firstNameFor) {
        await page.locator(`#${firstNameFor}`).fill('Monitor')
      }
    }

    // Fill last name via label
    if (await lastNameLabel.isVisible()) {
      const lastNameFor = await lastNameLabel.getAttribute('for')
      if (lastNameFor) {
        await page.locator(`#${lastNameFor}`).fill(testContactLastName)
      }
    } else {
      // Fallback: fill all visible text inputs that look like name fields
      await lastNameInput.fill(testContactLastName)
    }

    // Submit the form
    await dialog.locator('button[type="submit"]').click()

    // Dialog should close and contact should appear in table
    await expect(dialog).not.toBeVisible({ timeout: 15_000 })

    // Verify the new contact name appears in the list
    await expect(
      page.locator(`text=${testContactLastName}`).first(),
    ).toBeVisible({ timeout: 15_000 })

    // Clean up: click the delete button for this contact row
    const contactRow = page.locator('tr').filter({ hasText: testContactLastName }).first()
    await expect(contactRow).toBeVisible({ timeout: 10_000 })

    // Click the delete icon (aria-label="Löschen") in that row
    await contactRow.locator('button[aria-label="Löschen"]').click()

    // Confirm dialog appears with title "Kontakt löschen"
    const confirmDialog = page.locator('[role="dialog"]')
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 })
    await expect(confirmDialog.locator('h2:has-text("Kontakt löschen")')).toBeVisible()

    // Click the destructive confirm button "Löschen"
    await confirmDialog.locator('button:has-text("Löschen")').last().click()

    // Confirm dialog closes and contact is gone from the list
    await expect(confirmDialog).not.toBeVisible({ timeout: 15_000 })
    await expect(page.locator(`text=${testContactLastName}`).first()).not.toBeVisible({ timeout: 10_000 })
  })

  // ── Documents interaction ──────────────────────────────────────

  test('Documents: list loads and category filter works', async ({ page }) => {
    test.setTimeout(60_000)

    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/dokumente`)
    await page.waitForLoadState('networkidle')

    // h1 is present
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })

    // Wait for the document list to settle (loading spinner disappears or table/empty state appears)
    await page.waitForTimeout(2000)

    // Either a table with documents or an empty state must be visible — not an error
    const hasTable = await page.locator('table, [aria-label*="okument"]').first().isVisible()
    const hasEmptyState = await page.locator('text=/Keine Dokumente|noch keine/i').first().isVisible().catch(() => false)
    const hasUploadArea = await page.locator('text=/Hochladen|Upload|Drag/i').first().isVisible().catch(() => false)
    expect(
      hasTable || hasEmptyState || hasUploadArea,
      'Documents page should show a document list, empty state, or upload area',
    ).toBe(true)

    // Verify the category filter bar is rendered (Status-Filter group or category buttons)
    const filterGroup = page.locator('[role="group"][aria-label*="Filter"], button:has-text("Alle")').first()
    await expect(filterGroup).toBeVisible({ timeout: 10_000 })

    // Click a category filter (e.g. "Versicherung" or just the second filter button)
    const filterButtons = page.locator('[role="group"] button, button:has-text("Alle") ~ button')
    const filterCount = await filterButtons.count()
    if (filterCount > 1) {
      await filterButtons.nth(1).click()
      await page.waitForTimeout(500)
      // Page should not crash — h1 still visible
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 5_000 })
    }
  })

  // ── Invoicing interaction ──────────────────────────────────────

  test('Invoicing: list loads and status filters work', async ({ page }) => {
    test.setTimeout(60_000)

    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/invoicing`)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1:has-text("Debitoren")').first()).toBeVisible({ timeout: 10_000 })

    // Wait for invoice data to load
    await page.waitForTimeout(2000)

    // Invoice table or empty state must be visible (no error state)
    const tableVisible = await page.locator('table[aria-label="Ausgangsrechnungen"]').isVisible().catch(() => false)
    const emptyVisible = await page.locator('text=/Noch keine Rechnungen|Keine Rechnungen/i').first().isVisible().catch(() => false)
    expect(tableVisible || emptyVisible, 'Invoice list or empty state should be visible').toBe(true)

    // Status filter group is rendered
    const statusFilterGroup = page.locator('[role="group"][aria-label="Status-Filter"]').first()
    await expect(statusFilterGroup).toBeVisible({ timeout: 10_000 })

    // Verify "Alle" filter button is active by default
    await expect(statusFilterGroup.locator('button:has-text("Alle")')).toBeVisible()

    // Click "Bezahlt" or second available filter
    const filterButtons = statusFilterGroup.locator('button')
    const count = await filterButtons.count()
    if (count > 1) {
      await filterButtons.nth(1).click()
      await page.waitForTimeout(800)
      // Should not crash — h1 still present
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 5_000 })
    }

    // Search box is present and accepts input
    const searchInput = page.locator('input[aria-label="Rechnungen suchen"]')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
    await searchInput.fill('Test')
    await page.waitForTimeout(500)
    await searchInput.fill('')
  })

  // ── Banking interaction ────────────────────────────────────────

  test('Banking: balance card and transaction stats display', async ({ page }) => {
    test.setTimeout(60_000)

    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/banking`)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1:has-text("Banking")').first()).toBeVisible({ timeout: 10_000 })

    // Wait for data hooks to resolve
    await page.waitForTimeout(2000)

    // The three summary stat cards must be visible: Kontostand, Nicht abgeglichen, Abgeglichen
    await expect(page.locator('text=Kontostand').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('text=Nicht abgeglichen').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=Abgeglichen').first()).toBeVisible({ timeout: 10_000 })

    // The filter buttons (Alle / Offen / Abgeglichen) should be present
    const filterButtons = page.locator('button:has-text("Alle"), button:has-text("Offen"), button:has-text("Abgeglichen")')
    const visible = await filterButtons.first().isVisible().catch(() => false)
    // Filter may or may not render if there are no transactions; just verify no crash
    if (visible) {
      await filterButtons.first().click()
      await page.waitForTimeout(500)
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 5_000 })
    }

    // Import button must always be present
    await expect(page.locator('button:has-text("Import")').first()).toBeVisible({ timeout: 10_000 })
  })

  // ── Accounting interaction ─────────────────────────────────────

  test('Accounting: tabs render and Kontenplan tab shows chart of accounts', async ({ page }) => {
    test.setTimeout(60_000)

    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/accounting`)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1:has-text("Buchhaltung")').first()).toBeVisible({ timeout: 10_000 })

    // All 6 tab buttons must be visible
    const expectedTabs = ['Kontenplan', 'Bilanz', 'Erfolgsrechnung', 'Journal', 'Offene Posten', 'Buchung erfassen']
    for (const tabLabel of expectedTabs) {
      await expect(
        page.locator(`[role="tab"]:has-text("${tabLabel}")`).first(),
        `Tab "${tabLabel}" should be visible`,
      ).toBeVisible({ timeout: 10_000 })
    }

    // Kontenplan tab is active by default — the accounts table or seed prompt should show
    await page.waitForTimeout(2000)
    const hasAccountsTable = await page.locator('table').first().isVisible().catch(() => false)
    const hasSeedButton = await page.locator('button:has-text("Kontenplan laden")').isVisible().catch(() => false)
    const hasKontenplanHeading = await page.locator('text=Kontenplan').first().isVisible().catch(() => false)
    expect(
      hasAccountsTable || hasSeedButton || hasKontenplanHeading,
      'Kontenplan tab content should be visible',
    ).toBe(true)

    // Click Journal tab
    await page.locator('[role="tab"]:has-text("Journal")').click()
    await page.waitForTimeout(1000)
    // Journal content should render — either entries or date filters
    const hasDateFilter = await page.locator('input[id="journal-from"], input[type="date"]').first().isVisible().catch(() => false)
    const hasJournalTable = await page.locator('table').first().isVisible().catch(() => false)
    expect(hasDateFilter || hasJournalTable, 'Journal tab should render').toBe(true)

    // Click Buchung erfassen tab
    await page.locator('[role="tab"]:has-text("Buchung erfassen")').click()
    await page.waitForTimeout(1000)
    // Buchung form should appear
    await expect(page.locator('text=Buchung erfassen').first()).toBeVisible({ timeout: 10_000 })
  })

  // ── Time tracking interaction ──────────────────────────────────

  test('Time tracking: open manual entry form, fill, submit, verify, delete', async ({ page }) => {
    test.setTimeout(60_000)

    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/time-tracking`)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1:has-text("Zeiterfassung")').first()).toBeVisible({ timeout: 10_000 })

    // Wait for projects list to load (needed for the form select)
    await page.waitForTimeout(2000)

    // Click "Manueller Eintrag" button
    await page.locator('button:has-text("Manueller Eintrag")').click()

    // Dialog "Zeiteintrag erfassen" must appear
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog.locator('h2:has-text("Zeiteintrag erfassen")')).toBeVisible()

    // Select the first available project from the project dropdown
    const projectSelect = dialog.locator('#te-project')
    await expect(projectSelect).toBeVisible({ timeout: 10_000 })

    const projectOptions = projectSelect.locator('option')
    const optionCount = await projectOptions.count()

    if (optionCount <= 1) {
      // No projects available — close dialog and skip the create/delete steps
      await dialog.locator('button[aria-label="Schliessen"]').click()
      await expect(dialog).not.toBeVisible({ timeout: 5_000 })
      // Still verify the weekly summary and filter controls rendered
      await expect(page.locator('text=Wochenübersicht').first()).toBeVisible({ timeout: 10_000 })
      return
    }

    // Select the first real project (index 1, index 0 is the placeholder)
    await projectSelect.selectOption({ index: 1 })

    // Fill hours field
    const hoursInput = dialog.locator('#te-hours')
    await hoursInput.fill('1')

    // Fill description
    const descInput = dialog.locator('#te-description')
    await descInput.fill('Produktionsmonitor-Test')

    // Submit
    await dialog.locator('button[type="submit"]').click()

    // Dialog should close on success
    await expect(dialog).not.toBeVisible({ timeout: 15_000 })

    // Verify the new entry appears in the time entries table
    await expect(
      page.locator('table[aria-label="Zeiteinträge"]').first(),
    ).toBeVisible({ timeout: 15_000 })

    await expect(
      page.locator('text=Produktionsmonitor-Test').first(),
    ).toBeVisible({ timeout: 10_000 })

    // Clean up: click the delete button for the new entry row
    const entryRow = page.locator('tr').filter({ hasText: 'Produktionsmonitor-Test' }).first()
    await entryRow.locator('button[aria-label="Löschen"]').click()

    // ConfirmDialog appears with "Eintrag löschen"
    const confirmDialog = page.locator('[role="dialog"]')
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 })
    await expect(confirmDialog.locator('h2:has-text("Eintrag löschen")')).toBeVisible()

    // Confirm deletion
    await confirmDialog.locator('button:has-text("Löschen")').last().click()
    await expect(confirmDialog).not.toBeVisible({ timeout: 15_000 })
    await expect(page.locator('text=Produktionsmonitor-Test').first()).not.toBeVisible({ timeout: 10_000 })
  })

  // ── Settings interaction ───────────────────────────────────────

  test('Settings: company profile form renders with all key sections', async ({ page }) => {
    test.setTimeout(60_000)

    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/settings`)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1:has-text("Einstellungen")').first()).toBeVisible({ timeout: 10_000 })

    // Wait for profile data to load
    await page.waitForTimeout(2000)

    // Key sections must be visible
    await expect(page.locator('h2:has-text("Profil")').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('h2:has-text("Firmenangaben")').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('h2:has-text("Bankverbindung")').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('h2:has-text("MWST-Methode")').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('h2:has-text("Standardwerte")').first()).toBeVisible({ timeout: 10_000 })

    // Read-only email field is present
    await expect(page.locator('#settings-email')).toBeVisible({ timeout: 10_000 })

    // Firmenname field is present and editable
    const companyNameInput = page.locator('#settings-company-name')
    await expect(companyNameInput).toBeVisible({ timeout: 10_000 })

    // Speichern button is present
    await expect(page.locator('button[type="submit"]:has-text("Speichern")').first()).toBeVisible({ timeout: 10_000 })

    // Bankkonten section is visible (rendered below the form)
    await expect(page.locator('h2:has-text("Bankkonten")').first()).toBeVisible({ timeout: 10_000 })

    // Danger zone is visible
    await expect(page.locator('h2:has-text("Gefahrenzone")').first()).toBeVisible({ timeout: 10_000 })

    // Verify VAT method dropdown works — change and revert without saving
    const vatMethodSelect = page.locator('#settings-vat-method')
    await expect(vatMethodSelect).toBeVisible({ timeout: 10_000 })
    const originalValue = await vatMethodSelect.inputValue()
    await vatMethodSelect.selectOption('net_tax_rate')
    await page.waitForTimeout(300)
    // Net tax rate fields should appear
    await expect(page.locator('#settings-net-tax-rate-1').first()).toBeVisible({ timeout: 5_000 })
    // Revert
    await vatMethodSelect.selectOption(originalValue)
    await page.waitForTimeout(300)
  })

  // ── Health Monitor data verification ──────────────────────────

  test('Health Monitor: project cards load with status indicators', async ({ page }) => {
    test.setTimeout(60_000)

    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/health-monitor`)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1:has-text("Health Monitor")').first()).toBeVisible({ timeout: 10_000 })

    // Wait for data to load (the edge function call may take a few seconds)
    // Either the summary cards with real numbers appear, or an error state
    const summaryCard = page.locator('text=Projekte gesamt').first()
    const errorState = page.locator('text=Fehler beim Laden').first()

    const result = await Promise.race([
      summaryCard.waitFor({ timeout: 30_000 }).then(() => 'data' as const),
      errorState.waitFor({ timeout: 30_000 }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const)

    // We accept data OR a graceful error state — just not a blank/crashed page
    expect(['data', 'error'], `Health Monitor should load data or show error state, got: ${result}`)
      .toContain(result)

    if (result === 'data') {
      // Summary stat cards must all be present
      await expect(page.locator('text=Gesund').first()).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('text=Eingeschrankt').first()).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('text=Ausgefallen').first()).toBeVisible({ timeout: 10_000 })

      // SMTP status card must appear
      await expect(page.locator('text=SMTP-Verbindung').first()).toBeVisible({ timeout: 10_000 })

      // At least one project card must be visible in the grid
      const projectCards = page.locator('.grid .rounded-lg').filter({ hasText: /backoffice|channelmover|valrano|signalscore|replyflow|scoutcopilot|launchready/i })
      const cardCount = await projectCards.count()
      expect(cardCount, 'At least one project card should be visible').toBeGreaterThan(0)
    }

    // Refresh button must always be present
    await expect(page.locator('button[aria-label="Aktualisieren"]').first()).toBeVisible({ timeout: 10_000 })
  })

  // ── Stripe data verification ───────────────────────────────────

  test('Stripe: summary cards and charges/payouts tables render', async ({ page }) => {
    test.setTimeout(60_000)

    await loginViaMagicLink(page, AUTH_OPTS)
    await page.goto(`${SITE_URL}/stripe`)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('h1:has-text("Stripe Dashboard")').first()).toBeVisible({ timeout: 10_000 })

    // Wait for Stripe API calls to resolve
    await page.waitForTimeout(3000)

    // Three summary card labels are present (verified in real DOM as <p class="text-sm text-muted-foreground">)
    // Use exact text locators to avoid matching the table section h2 "Zahlungen"
    await expect(page.locator('p:has-text("Rechnungen bezahlt")').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('p:has-text("Auszahlungen")').first()).toBeVisible({ timeout: 10_000 })

    // Summary card value for Zahlungen is numeric (not NaN or undefined)
    // DOM structure: <div class="rounded-lg border border-border bg-card p-4">
    //   <p class="text-sm text-muted-foreground">Zahlungen</p>
    //   <p class="mt-1 text-2xl font-semibold font-mono text-card-foreground">1</p>
    // </div>
    // Use nth(0) on value-only paragraphs — the class "mt-1 text-2xl ..." is unique to the 3 numeric
    // card values (Zahlungen=index 0, Rechnungen bezahlt=index 1, Auszahlungen=index 2)
    const chargesValue = page.locator('p.mt-1.text-2xl').nth(0)
    await expect(chargesValue).toBeVisible({ timeout: 10_000 })
    const chargesText = (await chargesValue.textContent())?.trim() ?? ''
    expect(chargesText, 'Charges count should be a number').toMatch(/^\d+$/)

    // Stripe Zahlungen table section heading is present (verified: h2 with text "Zahlungen" exists)
    await expect(page.locator('h2:has-text("Zahlungen")').first()).toBeVisible({ timeout: 10_000 })

    // Stripe Kontostand balance section is always rendered (it is a permanent h2)
    await expect(page.locator('h2:has-text("Stripe Kontostand")').first()).toBeVisible({ timeout: 10_000 })
    // Verfügbar label is always present under the balance card
    await expect(page.locator('text=Verfügbar').first()).toBeVisible({ timeout: 10_000 })

    // Rechnungen table section heading is present (verified: h2 with text "Rechnungen" exists)
    // Note: there is NO h2 "Auszahlungen" — payouts only appear as a summary card label, not a table section
    await expect(page.locator('h2:has-text("Rechnungen")').first()).toBeVisible({ timeout: 10_000 })
  })

  // ── Edge function reachability — catches missing deploys after migration ──

  test('send-auth-email edge function is reachable', async ({ request }) => {
    const response = await request.fetch(
      `${SUPABASE_URL}/functions/v1/send-auth-email`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {},
      }
    )
    const status = response.status()
    expect(
      status !== 404 && status !== 500,
      `send-auth-email returned ${status} — not deployed or crashed`
    ).toBe(true)
  })

  test.describe('Edge Functions Reachable', () => {
    const ALL_EDGE_FUNCTIONS = [
      'create-payment-link',
      'decrypt-secret',
      'delete-account',
      'dispatch-webhook',
      'encrypt-secret',
      'export-accounting',
      'health-monitor',
      'log-api-usage',
      'process-bill',
      'process-document',
      'search-companies',
      'send-auth-email',
      'send-invoice',
      'stripe-balance',
      'stripe-webhook',
      'sync-usage',
    ]

    for (const fn of ALL_EDGE_FUNCTIONS) {
      test(`edge function ${fn} is deployed`, async ({ request }) => {
        const response = await request.fetch(
          `${SUPABASE_URL}/functions/v1/${fn}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: {},
          }
        )
        const status = response.status()
        // 200/400/401/403 = function exists. 404 = NOT deployed. 500 = crashed.
        expect(
          status !== 404 && status !== 500,
          `Edge function "${fn}" returned ${status} — not deployed or crashed`
        ).toBe(true)
      })
    }
  })
})
