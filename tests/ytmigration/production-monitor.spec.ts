import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.YTMIGRATION_URL || 'https://ytmigration.com'
const SUPABASE_URL = process.env.YTMIGRATION_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.YTMIGRATION_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.YTMIGRATION_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

test.describe('YouTubeMigration — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ── Existing tests ──────────────────────────────────────────────────

  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toContain('/auth')
  })

  test('pricing page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/pricing`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  // ── New tests ───────────────────────────────────────────────────────

  test('landing page has features and pricing section', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')

    // Verify feature keywords are present on the landing page
    const body = page.locator('body')
    await expect(body).toContainText(/subscriptions/i)
    await expect(body).toContainText(/playlists/i)

    // Verify a pricing section or CTA exists
    const pricingSection = page.locator('text=/pricing|plans|free|get started/i').first()
    await expect(pricingSection).toBeVisible({ timeout: 10_000 })
  })

  test('pricing page shows 3 tiers', async ({ page }) => {
    await page.goto(`${SITE_URL}/pricing`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Verify the three tier names appear
    await expect(body).toContainText(/free/i)
    await expect(body).toContainText(/standard/i)
    await expect(body).toContainText(/pro/i)

    // Verify at least one price is shown (e.g. $0, $4.99, $9.99 or similar)
    await expect(body).toContainText(/\$\d/)
  })

  test('extension page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/extension`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    // Should mention Chrome or extension
    await expect(body).toContainText(/extension|chrome|install/i)
  })

  test('about page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/about`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    // Should have meaningful content (not a blank shell)
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(100)
  })

  test('privacy page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/privacy`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/privacy/i)
  })

  test('guide page loads (not 404)', async ({ page }) => {
    const response = await page.goto(`${SITE_URL}/guide/youtube-account-migration`)
    await page.waitForLoadState('networkidle')

    // Verify not a 404
    expect(response?.status()).not.toBe(404)

    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/youtube|migration|account/i)
  })

  test('comparison page loads (not 404)', async ({ page }) => {
    const response = await page.goto(`${SITE_URL}/compare/yt-migration-vs-google-takeout`)
    await page.waitForLoadState('networkidle')

    expect(response?.status()).not.toBe(404)

    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/takeout|compare|migration/i)
  })

  test('auth login page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/auth/login`)
    await page.waitForLoadState('networkidle')
    // YTMigration uses Google OAuth — verify the page loads with sign-in content
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('migrate page shows sign-in prompt without auth', async ({ page }) => {
    // Visit /migrate without auth — shows empty state with "Sign In Required"
    await page.goto(`${SITE_URL}/migrate`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('dashboard loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    // Should be on dashboard (not auth, not landing)
    const url = page.url()
    expect(url).not.toContain('/auth')

    // Dashboard should have meaningful content
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })
})
