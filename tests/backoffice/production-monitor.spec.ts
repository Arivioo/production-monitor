import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.BACKOFFICE_URL || 'https://backoffice.predivo.ch'
const SUPABASE_URL = process.env.BACKOFFICE_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.BACKOFFICE_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.BACKOFFICE_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

test.describe('BackOffice — Production Monitor', () => {
  test.beforeAll(async () => {
    // Ensure test user exists (idempotent)
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ──────────────────────────────────────────────
  // 1. AUTH PAGE
  // ──────────────────────────────────────────────

  test('auth page loads and form is functional', async ({ page }) => {
    await page.goto(`${SITE_URL}/auth`)
    await expect(page.locator('h1')).toContainText('BackOffice')
    await expect(page.locator('input[type="email"]')).toBeVisible()
    await expect(page.locator('button[type="submit"]')).toBeVisible()
    await expect(page.locator('button[type="submit"]')).toContainText('Anmeldecode senden')

    // Fill email and submit — verify OTP step appears
    await page.fill('input[type="email"]', TEST_EMAIL)
    await page.click('button[type="submit"]')

    // Wait for either success message or error
    const messageEl = page.locator('[role="alert"]')
    await expect(messageEl).toBeVisible({ timeout: 15_000 })
    const messageText = await messageEl.textContent()

    // OTP sent = auth pipeline works. Rate limit = temporary (not broken).
    // Only fail on actual errors (500, hook failures, etc.)
    const isOk = messageText?.includes('Code wurde gesendet')
    const isRateLimited = messageText?.toLowerCase().includes('rate limit')
    expect(
      isOk || isRateLimited,
      `Unexpected auth response: ${messageText}`,
    ).toBeTruthy()
  })

  // ──────────────────────────────────────────────
  // 2. FULL LOGIN (magic link → session → dashboard)
  // ──────────────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })

    // After login, should be on the app (not auth page)
    const url = page.url()
    expect(url).not.toContain('/auth')

    // Dashboard should render — check for key elements
    // Wait for the page content to load (not just the shell)
    await page.waitForLoadState('networkidle')

    // The app shell should be visible (sidebar nav or header)
    await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 10_000 })

    // No uncaught errors in console
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.waitForTimeout(2000)
    const criticalErrors = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('manifest') && !e.includes('third-party'),
    )
    expect(criticalErrors, `Console errors: ${criticalErrors.join('; ')}`).toHaveLength(0)
  })

  // ──────────────────────────────────────────────
  // 3. CORE PAGES LOAD (authenticated)
  // ──────────────────────────────────────────────

  test('contacts page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/contacts`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    // Page should render without crashing
    expect(page.url()).toContain('/contacts')
  })

  test('projects page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/projects`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/projects')
  })

  test('documents page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/documents`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/documents')
  })

  test('banking page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/banking`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/banking')
  })

  test('stripe page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/stripe`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/stripe')
  })

  test('health monitor page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/health-monitor`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1')).toContainText('Health Monitor', { timeout: 10_000 })
    // Verify data loads (summary cards appear)
    await expect(page.locator('text=Projekte gesamt').first()).toBeVisible({ timeout: 30_000 })
  })

  test('debtors page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/debtors`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/debtors')
  })

  test('creditors page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/creditors`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/creditors')
  })

  test('accounting page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/accounting`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/accounting')
  })

  test('time tracking page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/time-tracking`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/time-tracking')
  })

  test('settings page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.goto(`${SITE_URL}/settings`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })
    expect(page.url()).toContain('/settings')
  })
})
