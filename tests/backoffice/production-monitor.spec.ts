import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.BACKOFFICE_URL || 'https://backoffice.predivo.ch'
const SUPABASE_URL = process.env.BACKOFFICE_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.BACKOFFICE_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.BACKOFFICE_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

const AUTH_OPTS = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE_KEY,
  anonKey: ANON_KEY,
  testEmail: TEST_EMAIL,
  siteUrl: SITE_URL,
}

test.describe('BackOffice — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ── Auth page ──────────────────────────────────────────────────

  test('auth page loads with form', async ({ page }) => {
    await page.goto(`${SITE_URL}/auth`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('button[type="submit"]')).toBeVisible({ timeout: 10_000 })
  })

  // ── Full login ─────────────────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS)
    const url = page.url()
    expect(url).not.toContain('/auth')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 10_000 })
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
