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

  // ──────────────────────────────────────────────
  // 4. DASHBOARD KPI CARDS
  // ──────────────────────────────────────────────

  test('dashboard KPI cards visible', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })

    await page.waitForLoadState('networkidle')

    // Dashboard should show key financial KPI cards
    const kpiLabels = ['Offene Debitoren', 'Offene Kreditoren', 'Umsatz']
    for (const label of kpiLabels) {
      await expect(
        page.locator(`text=${label}`).first(),
        `KPI card "${label}" should be visible on dashboard`,
      ).toBeVisible({ timeout: 15_000 })
    }

    // Check for overdue indicator (may use different casing/phrasing)
    const overdueLocator = page.locator('text=/[Üü]berf[äa]llig/i').first()
    await expect(
      overdueLocator,
      'Overdue indicator should be visible on dashboard',
    ).toBeVisible({ timeout: 10_000 })
  })

  // ──────────────────────────────────────────────
  // 5. SIDEBAR NAVIGATION
  // ──────────────────────────────────────────────

  test('sidebar navigation has key items', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })

    await page.waitForLoadState('networkidle')

    // Sidebar should contain all primary navigation items
    const navItems = ['Dashboard', 'Kontakte', 'Projekte', 'Dokumente', 'Rechnungen', 'Buchhaltung']
    const sidebar = page.locator('nav').first()
    await expect(sidebar).toBeVisible({ timeout: 10_000 })

    for (const item of navItems) {
      await expect(
        sidebar.locator(`text=${item}`).first(),
        `Sidebar should contain "${item}" nav item`,
      ).toBeVisible({ timeout: 10_000 })
    }
  })

  // ──────────────────────────────────────────────
  // 6. ACCOUNTING PAGE TABS
  // ──────────────────────────────────────────────

  test('accounting page has tab navigation', async ({ page }) => {
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

    // Verify tab navigation exists with key accounting tabs
    const expectedTabs = ['Kontenplan', 'Journal']
    for (const tab of expectedTabs) {
      await expect(
        page.locator(`role=tab >> text=${tab}, text=${tab}`).first().or(
          page.locator(`[role="tab"]:has-text("${tab}")`).first(),
        ).or(
          page.locator(`button:has-text("${tab}"), a:has-text("${tab}")`).first(),
        ),
        `Accounting page should have "${tab}" tab`,
      ).toBeVisible({ timeout: 10_000 })
    }
  })

  // ──────────────────────────────────────────────
  // 7. BILLS PAGE WITH TABLE
  // ──────────────────────────────────────────────

  test('bills page loads with table', async ({ page }) => {
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

    // Verify table structure is present (table or data grid)
    const tableLocator = page.locator('table, [role="grid"], [role="table"]').first()
    await expect(
      tableLocator,
      'Bills page should contain a data table',
    ).toBeVisible({ timeout: 15_000 })

    // Verify table has header row with columns
    const headerCells = page.locator('th, [role="columnheader"]')
    const headerCount = await headerCells.count()
    expect(headerCount, 'Table should have at least one column header').toBeGreaterThan(0)
  })

  // ──────────────────────────────────────────────
  // 8. CRM PAGE WITH SEARCH
  // ──────────────────────────────────────────────

  test('CRM page loads with search', async ({ page }) => {
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

    // Verify search input is present
    const searchInput = page.locator(
      'input[type="search"], input[placeholder*="Such"], input[placeholder*="such"], input[placeholder*="Search"], input[placeholder*="Filter"]',
    ).first()
    await expect(
      searchInput,
      'CRM/Contacts page should have a search input',
    ).toBeVisible({ timeout: 10_000 })
  })

  // ──────────────────────────────────────────────
  // 9. STRIPE DASHBOARD BALANCE
  // ──────────────────────────────────────────────

  test('Stripe dashboard shows balance section', async ({ page }) => {
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

    // Verify balance section renders (look for CHF amount or balance label)
    const balanceLocator = page.locator(
      'text=/CHF|Balance|Saldo|Guthaben|Umsatz/i',
    ).first()
    await expect(
      balanceLocator,
      'Stripe page should display a balance or revenue section',
    ).toBeVisible({ timeout: 15_000 })
  })

  // ──────────────────────────────────────────────
  // 10. NO CONSOLE ERRORS ON DASHBOARD
  // ──────────────────────────────────────────────

  test('no critical console errors on dashboard', async ({ page }) => {
    // Attach console listener BEFORE navigation
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })

    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })

    await page.waitForLoadState('networkidle')
    await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 10_000 })

    // Give async operations time to settle
    await page.waitForTimeout(3000)

    // Filter out non-critical noise
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
      `Critical console errors on dashboard:\n${criticalErrors.join('\n')}`,
    ).toHaveLength(0)
  })
})
