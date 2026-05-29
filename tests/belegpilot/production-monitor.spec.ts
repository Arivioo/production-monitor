import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.BELEGPILOT_URL || 'https://belegpilot.predivo.ch'
const SUPABASE_URL = process.env.BELEGPILOT_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.BELEGPILOT_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.BELEGPILOT_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

const AUTH_CONFIG = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE_KEY,
  anonKey: ANON_KEY,
  testEmail: TEST_EMAIL,
  siteUrl: SITE_URL,
}

/** Bypass the PasswordGate by setting sessionStorage before navigation. */
async function bypassPasswordGate(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.goto(SITE_URL, { waitUntil: 'commit' })
  await page.evaluate(() => sessionStorage.setItem('belegpilot-unlocked', 'true'))
  await page.goto(url, { waitUntil: 'networkidle' })
}

test.describe('BelegPilot — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ── Public pages ───────────────────────────────────────────────────

  test('site loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('landing page has hero', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('body')).toContainText(/BelegPilot/i)
  })

  test('privacy page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/datenschutz`)
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('terms page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/agb`)
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('impressum page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/impressum`)
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('auth page has form', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/auth`)
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i], input[placeholder*="E-Mail" i]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })
  })

  // ── Authenticated tests ────────────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toContain('/auth')
  })

  test('dashboard shows content', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('documents page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/documents`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('settings page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ── Interaction tests ──────────────────────────────────────────────

  test('document list: search input and filter buttons are interactive', async ({ page }) => {
    // Bypass PasswordGate before any navigation so it persists through the Supabase redirect
    await page.addInitScript(() => sessionStorage.setItem('belegpilot-unlocked', 'true'))
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/documents`, { waitUntil: 'networkidle' })

    // Search input is present and accepts text
    const searchInput = page.locator('input[aria-label="Dokumente durchsuchen"]')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
    await searchInput.fill('Test')
    await expect(searchInput).toHaveValue('Test')
    await searchInput.fill('')

    // Filter buttons are present (Alle is the default active filter)
    const filterButtons = page.locator('button:has-text("Alle")')
    await expect(filterButtons.first()).toBeVisible({ timeout: 5_000 })

    // The document table or empty-state is rendered
    // Note: :text() is not valid CSS — use .or() to combine two locators
    const tableOrEmpty = page.locator('table').or(page.locator('text=Keine Dokumente gefunden.'))
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 10_000 })

    // Clicking the Verifiziert filter doesn't crash the page
    const verifiedFilter = page.locator('button').filter({ hasText: /Verifiziert/i })
    if (await verifiedFilter.count() > 0) {
      await verifiedFilter.first().click()
      await page.waitForLoadState('networkidle')
      await expect(page.locator('body')).not.toBeEmpty()
    }
  })

  test('document upload: dropzone and file input are present and interactive', async ({ page }) => {
    // Bypass PasswordGate before any navigation so it persists through the Supabase redirect
    await page.addInitScript(() => sessionStorage.setItem('belegpilot-unlocked', 'true'))
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/upload`, { waitUntil: 'networkidle' })

    // Drop zone container is visible (has border-dashed class)
    const dropzone = page.locator('.border-dashed').first()
    await expect(dropzone).toBeVisible({ timeout: 10_000 })

    // The drag-and-drop instruction text is rendered
    await expect(page.locator('text=Dateien hierher ziehen oder klicken zum Auswählen')).toBeVisible({ timeout: 5_000 })

    // The "Dateien auswählen" button label is rendered
    await expect(page.locator('text=Dateien auswählen')).toBeVisible({ timeout: 5_000 })

    // Hidden file input exists and accepts the right MIME types
    const fileInput = page.locator('input[type="file"]')
    await expect(fileInput).toBeAttached({ timeout: 5_000 })
    const accept = await fileInput.getAttribute('accept')
    expect(accept).toContain('application/pdf')

    // Supported format hint text is visible (source: "PDF, JPG, PNG, TIFF — max. 20 MB pro Datei")
    await expect(page.locator('text=PDF, JPG, PNG, TIFF')).toBeVisible({ timeout: 5_000 })
  })

  test('dashboard: metric cards render with values', async ({ page }) => {
    // Bypass PasswordGate before any navigation so it persists through the Supabase redirect
    await page.addInitScript(() => sessionStorage.setItem('belegpilot-unlocked', 'true'))
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })

    // All four metric card labels are present (hardcoded uppercase strings in source)
    await expect(page.locator('text=BELEGE GESAMT')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=VERARBEITET')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('text=ZUR PRÜFUNG')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('text=EXPORTIERT (CHF)')).toBeVisible({ timeout: 5_000 })

    // Each metric card contains a numeric value rendered with font-mono text-2xl
    // The <p> element has classes: font-mono text-2xl font-semibold text-foreground
    const metricValues = page.locator('p.font-mono.text-2xl')
    await expect(metricValues.first()).toBeVisible({ timeout: 5_000 })
    const count = await metricValues.count()
    expect(count).toBeGreaterThanOrEqual(4)

    // "Letzte Dokumente" section heading is present
    await expect(page.locator('h2:has-text("Letzte Dokumente")')).toBeVisible({ timeout: 5_000 })

    // "Beleg hochladen" action link is present in the page header
    await expect(page.locator('text=Beleg hochladen')).toBeVisible({ timeout: 5_000 })
  })

  test('settings: tabs are present and each tab renders content', async ({ page }) => {
    // Bypass PasswordGate before any navigation so it persists through the Supabase redirect
    await page.addInitScript(() => sessionStorage.setItem('belegpilot-unlocked', 'true'))
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })

    // Tab list is rendered
    const tablist = page.locator('[role="tablist"]')
    await expect(tablist).toBeVisible({ timeout: 10_000 })

    // All 5 tabs are present
    const expectedTabs = ['Firmenprofil', 'Team', 'ERP-Exportformate', 'Abrechnung', 'Sicherheit']
    for (const label of expectedTabs) {
      await expect(page.locator(`[role="tab"]:has-text("${label}")`)).toBeVisible({ timeout: 5_000 })
    }

    // Default tab (Firmenprofil) shows firm name input
    const firmNameInput = page.locator('#firm-name')
    await expect(firmNameInput).toBeVisible({ timeout: 5_000 })
    await expect(firmNameInput).toBeEnabled()

    // Email field is present and disabled (read-only)
    const emailInput = page.locator('#firm-email')
    await expect(emailInput).toBeVisible({ timeout: 5_000 })
    await expect(emailInput).toBeDisabled()

    // Switch to Security tab — password fields appear
    await page.locator('[role="tab"]:has-text("Sicherheit")').click()
    await expect(page.locator('#new-password')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('#confirm-password')).toBeVisible({ timeout: 5_000 })

    // Switch to Billing tab — plan info appears
    await page.locator('[role="tab"]:has-text("Abrechnung")').click()
    await expect(page.locator('text=Aktueller Plan')).toBeVisible({ timeout: 5_000 })

    // Switch to ERP tab — table with ERP systems appears
    await page.locator('[role="tab"]:has-text("ERP-Exportformate")').click()
    await expect(page.locator('text=ERP-SYSTEM').first()).toBeVisible({ timeout: 5_000 })
  })

  test('login form: fields accept input and opacity > 0', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/auth`)

    const emailInput = page.locator('input[type="email"]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })

    const opacity = await emailInput.evaluate(
      (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
    )
    expect(opacity, 'Login email input must have opacity > 0').toBeGreaterThan(0)

    await emailInput.fill('test-monitor@example.com')
    expect(await emailInput.inputValue()).toBe('test-monitor@example.com')
  })

  test('site identity — title contains belegpilot', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'belegpilot.predivo.ch must contain "belegpilot" branding').toContain('belegpilot')
  })

  test('navigation: sidebar links load correct pages', async ({ page }) => {
    // Bypass PasswordGate before any navigation so it persists through the Supabase redirect
    await page.addInitScript(() => sessionStorage.setItem('belegpilot-unlocked', 'true'))
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })

    // Sidebar nav is present (inside the lg: desktop sidebar, visible at ≥1024px viewport)
    const nav = page.locator('nav[aria-label="Hauptnavigation"]')
    await expect(nav).toBeVisible({ timeout: 10_000 })

    // All expected nav links and their confirmed on-page text (verified against source)
    const navLinks: { label: string; href: string; expectedText: string }[] = [
      { label: 'Dokumente', href: '/documents', expectedText: 'Dokumente' },
      { label: 'Upload', href: '/upload', expectedText: 'Dateien hierher ziehen oder klicken zum Auswählen' },
      { label: 'Clients', href: '/clients', expectedText: 'Mandanten' },
      { label: 'Export', href: '/export', expectedText: 'Export' },
      { label: 'Einstellungen', href: '/settings', expectedText: 'Firmenprofil' },
    ]

    for (const { label, href, expectedText } of navLinks) {
      // Click the sidebar link
      const link = nav.locator(`a[href="${href}"]`)
      await expect(link).toBeVisible({ timeout: 5_000 })
      await link.click()
      await page.waitForLoadState('networkidle')

      // URL updated correctly
      expect(page.url()).toContain(href)

      // Page has meaningful content
      const body = await page.locator('body').textContent()
      expect((body || '').length).toBeGreaterThan(50)

      // Expected text appears on the page
      await expect(page.locator(`text=${expectedText}`).first()).toBeVisible({ timeout: 10_000 })

      // Navigate back to dashboard for next iteration
      await nav.locator('a[href="/dashboard"]').click()
      await page.waitForLoadState('networkidle')
    }
  })
})
