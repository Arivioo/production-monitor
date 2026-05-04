import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.LAUNCHREADY_URL || 'https://launchready.predivo.ch'
const SUPABASE_URL = process.env.LAUNCHREADY_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.LAUNCHREADY_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.LAUNCHREADY_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

const AUTH_CONFIG = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE_KEY,
  anonKey: ANON_KEY,
  testEmail: TEST_EMAIL,
  siteUrl: SITE_URL,
}

test.describe('LaunchReady — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ── Public pages ───────────────────────────────────────────────────

  test('site loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('landing page has audit form', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    // LaunchReady is an audit tool — landing should have a URL input or audit form
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible({ timeout: 10_000 })
    // Look for a URL input or audit-related form
    const urlInput = page.locator('input[type="url"], input[type="text"], input[placeholder*="URL" i], input[placeholder*="website" i], input[placeholder*="domain" i]').first()
    await expect(urlInput).toBeVisible({ timeout: 10_000 })
  })

  test('privacy page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/privacy`, { waitUntil: 'networkidle' })
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/privacy|datenschutz/i)
  })

  test('terms page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/terms`, { waitUntil: 'networkidle' })
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/terms|nutzungsbedingungen|AGB/i)
  })

  test('impressum page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/impressum`, { waitUntil: 'networkidle' })
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/impressum|predivo/i)
  })

  test('login page has form', async ({ page }) => {
    await page.goto(`${SITE_URL}/login`, { waitUntil: 'networkidle' })
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })
  })

  // ── Authenticated tests ────────────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toContain('/auth')
  })

  test('dashboard shows audit history or empty state', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })
})
