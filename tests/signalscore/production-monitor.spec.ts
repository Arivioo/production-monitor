import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.SIGNALSCORE_URL || 'https://signalscore.ch'
const SUPABASE_URL = process.env.SIGNALSCORE_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SIGNALSCORE_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.SIGNALSCORE_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

/**
 * Bypass the PasswordGate by setting the sessionStorage key before navigation.
 * The gate checks sessionStorage('signalscore-unlocked') === 'true'.
 */
async function bypassPasswordGate(page: import('@playwright/test').Page, url: string): Promise<void> {
  // Navigate to origin first to establish the storage context, then set the key
  await page.goto(SITE_URL, { waitUntil: 'commit' })
  await page.evaluate(() => sessionStorage.setItem('signalscore-unlocked', 'true'))
  await page.goto(url, { waitUntil: 'networkidle' })
}

test.describe('SignalScore — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ── Existing tests ──

  test('site loads', async ({ page }) => {
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

  test('methodology page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/legal/methodology`)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  // ── New public page tests ──

  test('landing page renders hero content', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    // The hero section contains the brand name and a CTA
    await expect(page.locator('text=SignalScore').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=Credit Check').first()).toBeVisible({ timeout: 10_000 })
  })

  test('landing page pricing section loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/pricing`)
    // /pricing renders the Landing component; verify the pricing section exists
    await expect(page.locator('#pricing')).toBeAttached({ timeout: 10_000 })
  })

  test('privacy page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/legal/privacy`)
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 10_000 })
    // Verify it contains privacy-related content
    await expect(page.locator('text=Privacy').first()).toBeVisible({ timeout: 10_000 })
  })

  test('terms page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/legal/terms`)
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=Terms').first()).toBeVisible({ timeout: 10_000 })
  })

  test('imprint page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/legal/imprint`)
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=Imprint').first()).toBeVisible({ timeout: 10_000 })
  })

  // ── Authenticated tests ──

  test('dashboard loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    if (!page.url().includes('/dashboard')) {
      await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    }

    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
    // Should not be on auth page
    expect(page.url()).not.toContain('/auth')
  })

  test('settings page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })

    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
    expect(page.url()).not.toContain('/auth')
  })

  test('check history page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/dashboard/history`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    // Page should not redirect to auth
    expect(page.url()).toContain('/dashboard/history')
  })
})
