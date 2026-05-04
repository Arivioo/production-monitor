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

  test('landing page has hero and CTA', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('body')).toContainText(/BelegPilot/i)
  })

  test('privacy page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/datenschutz`, { waitUntil: 'networkidle' })
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/datenschutz|privacy/i)
  })

  test('terms page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/agb`, { waitUntil: 'networkidle' })
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/AGB|nutzungsbedingungen|terms/i)
  })

  test('impressum page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/impressum`, { waitUntil: 'networkidle' })
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/impressum|predivo/i)
  })

  test('auth page has form', async ({ page }) => {
    await page.goto(`${SITE_URL}/auth`, { waitUntil: 'networkidle' })
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

  test('dashboard shows welcome content', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    await expect(page.locator('h1, h2').first()).toBeVisible({ timeout: 15_000 })
  })

  test('documents page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/documents`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('upload page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/upload`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    // Should have upload functionality (drop zone or button)
    const uploadEl = page.locator('input[type="file"], [class*="upload"], [class*="Upload"], [class*="drop"], button:has-text("Upload"), button:has-text("Hochladen")').first()
    await expect(uploadEl).toBeVisible({ timeout: 15_000 })
  })

  test('settings page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })
})
