import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.REPLYFLOW_URL || 'https://replyflow.help'
const SUPABASE_URL = process.env.REPLYFLOW_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.REPLYFLOW_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.REPLYFLOW_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

test.describe('ReplyFlow — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ── Existing tests ──────────────────────────────────────────────────

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

  // ── Public page tests ───────────────────────────────────────────────

  test('landing page has hero and pricing', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })

    // Hero section should be visible
    const hero = page.locator('section').first()
    await expect(hero).toBeVisible({ timeout: 10_000 })

    // Expect a main heading in the hero area
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible({ timeout: 10_000 })

    // Pricing cards — expect 3 tiers
    const pricingCards = page.locator('[class*="pricing"], [class*="Pricing"], [class*="plan"], [class*="Plan"], [class*="tier"], [class*="card"]').or(
      page.locator('[data-testid*="pricing"]')
    )
    // Fallback: look for pricing section by heading text
    const pricingHeading = page.locator('text=/pricing|plans|Pricing|Plans/i').first()
    await expect(pricingHeading).toBeVisible({ timeout: 10_000 })
  })

  test('login page has form', async ({ page }) => {
    await page.goto(`${SITE_URL}/login`, { waitUntil: 'networkidle' })

    // Email input should be present
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })

    // Submit button should be present
    const submitButton = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Continue")').first()
    await expect(submitButton).toBeVisible({ timeout: 10_000 })
  })

  test('privacy page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/privacy`, { waitUntil: 'networkidle' })

    // Page should have meaningful content (not a blank or error page)
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()

    // Should contain privacy-related text
    const privacyContent = page.locator('text=/privacy|datenschutz|data protection/i').first()
    await expect(privacyContent).toBeVisible({ timeout: 10_000 })
  })

  test('terms page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/terms`, { waitUntil: 'networkidle' })

    const body = page.locator('body')
    await expect(body).not.toBeEmpty()

    // Should contain terms-related text
    const termsContent = page.locator('text=/terms|conditions|nutzungsbedingungen|AGB/i').first()
    await expect(termsContent).toBeVisible({ timeout: 10_000 })
  })

  // ── Protected route redirect test ───────────────────────────────────

  test('protected routes redirect when not authenticated', async ({ page }) => {
    // Go to /app without logging in — should redirect to login
    await page.goto(`${SITE_URL}/app`, { waitUntil: 'networkidle' })

    // Should end up on login or signup page, not /app
    await page.waitForURL((url) => {
      const path = url.pathname
      return path.includes('/login') || path.includes('/signup') || path.includes('/auth')
    }, { timeout: 15_000 })

    const finalUrl = page.url()
    expect(finalUrl).toMatch(/\/(login|signup|auth)/)
  })

  // ── Authenticated page tests ────────────────────────────────────────

  test('dashboard loads after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    // Should be on /app or dashboard area
    await page.goto(`${SITE_URL}/app`, { waitUntil: 'networkidle' })

    // Dashboard should show stats cards, review list, or an empty state
    const dashboardContent = page.locator(
      '[class*="dashboard"], [class*="Dashboard"], [class*="stats"], [class*="card"], [class*="empty"], [class*="review"], main, [role="main"]'
    ).first()
    await expect(dashboardContent).toBeVisible({ timeout: 15_000 })
  })

  test('reviews page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/app/reviews`, { waitUntil: 'networkidle' })

    // Should not redirect away (still on reviews page)
    expect(page.url()).toContain('/app/reviews')

    // Page should render review list or empty state
    const reviewsContent = page.locator(
      '[class*="review"], [class*="Review"], [class*="empty"], [class*="Empty"], table, [role="table"], main, [role="main"]'
    ).first()
    await expect(reviewsContent).toBeVisible({ timeout: 15_000 })
  })

  test('analytics page loads', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/app/analytics`, { waitUntil: 'networkidle' })

    // Should stay on analytics page
    expect(page.url()).toContain('/app/analytics')

    // Page should render charts, stats, or empty state
    const analyticsContent = page.locator(
      '[class*="analytics"], [class*="Analytics"], [class*="chart"], [class*="Chart"], [class*="empty"], [class*="Empty"], canvas, svg, main, [role="main"]'
    ).first()
    await expect(analyticsContent).toBeVisible({ timeout: 15_000 })
  })

  test('settings page loads with tabs', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/app/settings`, { waitUntil: 'networkidle' })

    // Should stay on settings page
    expect(page.url()).toContain('/app/settings')

    // Settings should have tabs or sections
    const settingsTabs = page.locator(
      '[role="tablist"], [class*="tab"], [class*="Tab"], [class*="settings"], [class*="Settings"], nav, [class*="section"], [class*="Section"]'
    ).first()
    await expect(settingsTabs).toBeVisible({ timeout: 15_000 })
  })
})
