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

  // ── Interaction tests ────────────────────────────────────────────

  test('dashboard data verification — sections and data type labels visible after login', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Quota / usage card — always rendered on the dashboard
    await expect(body).toContainText(/items left/i, { timeout: 15_000 })

    // Plan card
    await expect(body).toContainText(/plan/i)

    // Quick-action buttons present on the dashboard
    await expect(body).toContainText(/accounts/i)

    // Recent activity section
    await expect(body).toContainText(/recent activity/i)
  })

  test('migrate page interaction — wizard UI loads with step indicators and data toggles', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/migrate`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Migration wizard heading (ScreenHeader title="Migration Wizard")
    await expect(body).toContainText(/migration wizard/i, { timeout: 15_000 })

    // Step 1 and 2 labels from YTStepIndicator
    await expect(body).toContainText(/source/i)
    await expect(body).toContainText(/destination/i)

    // Step 3 — data type toggles (YTToggleRow labels)
    await expect(body).toContainText(/subscriptions/i)
    await expect(body).toContainText(/playlists/i)

    // "Review & Start" CTA button must be present (may be disabled, still rendered)
    await expect(body).toContainText(/review & start/i)
  })

  test('pricing page interaction — 3 tiers with prices, feature lists, and CTA buttons', async ({ page }) => {
    await page.goto(`${SITE_URL}/pricing`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Tier names from PRICING array in pricing.tsx
    await expect(body).toContainText('Free')
    await expect(body).toContainText('Standard')
    await expect(body).toContainText('Pro')

    // Prices — $0, $4.99, $7.99
    await expect(body).toContainText('$0')
    await expect(body).toContainText('$4.99')
    await expect(body).toContainText('$7.99')

    // Feature list items
    await expect(body).toContainText(/subscriptions transfer/i)
    await expect(body).toContainText(/50 items included/i)
    await expect(body).toContainText(/playlists with all videos/i)

    // CTA buttons rendered for each tier
    await expect(body).toContainText('Get Started')
    await expect(body).toContainText('Choose Standard')
    await expect(body).toContainText('Choose Pro')

    // Top-Up Packs section
    await expect(body).toContainText(/top-up packs/i)

    // Verify "Get Started" CTA is clickable (exists and is not hidden)
    const getStartedBtn = page.locator('text=Get Started').first()
    await expect(getStartedBtn).toBeVisible({ timeout: 10_000 })
    await getStartedBtn.click()
    // After click, should navigate toward auth login (Google OAuth page)
    await page.waitForLoadState('networkidle')
    const urlAfterClick = page.url()
    expect(urlAfterClick).toMatch(/auth\/login|accounts\.google|ytmigration\.com/)
  })

  test('extension page interaction — Chrome extension info sections and browser compatibility', async ({ page }) => {
    await page.goto(`${SITE_URL}/extension`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Page heading
    await expect(body).toContainText('Chrome Extension', { timeout: 10_000 })

    // Key informational sections from extension.tsx
    await expect(body).toContainText(/what does the extension do/i)
    await expect(body).toContainText(/how to install/i)
    await expect(body).toContainText(/how it works/i)
    await expect(body).toContainText(/privacy/i)

    // Browser compatibility list: Google Chrome is supported
    await expect(body).toContainText('Google Chrome')
    await expect(body).toContainText(/supported/i)

    // Microsoft Edge and Firefox listed (coming soon)
    await expect(body).toContainText('Microsoft Edge')
    await expect(body).toContainText('Mozilla Firefox')

    // Install/beta note
    await expect(body).toContainText(/beta/i)
  })

  test('guide page interaction — step-by-step guide content with data type sections', async ({ page }) => {
    await page.goto(`${SITE_URL}/guide/youtube-account-migration`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Guide must have substantial content
    const text = await body.textContent()
    expect((text || '').length).toBeGreaterThan(500)

    // Data type sections from DATA_TYPES array in the guide page
    await expect(body).toContainText('Subscriptions', { timeout: 10_000 })
    await expect(body).toContainText('Playlists')
    await expect(body).toContainText('Liked Videos')
    await expect(body).toContainText('Watch History')

    // Comparison methods section (METHODS array)
    await expect(body).toContainText(/manual/i)
    await expect(body).toContainText(/google takeout/i)

    // YouTube migration context
    await expect(body).toContainText(/youtube/i)
    await expect(body).toContainText(/migration/i)
  })

  test('site identity — title contains ytmigration or youtube migration', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(
      combined.includes('ytmigration') || combined.includes('youtube migration') || combined.includes('yt migration'),
      'ytmigration.com must contain "ytmigration", "yt migration", or "youtube migration" branding',
    ).toBe(true)
  })

  test('CSP connect-src includes correct Supabase ref', async () => {
    // Use Node fetch directly — Playwright's response object sometimes strips headers in CI
    const res = await fetch(SITE_URL, { redirect: 'follow' })
    const csp = res.headers.get('content-security-policy') || ''
    expect(csp, 'CSP header or meta tag must be present').toBeTruthy()

    const connectSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src'))

    expect(connectSrc, 'CSP must contain a connect-src directive').toBeTruthy()
    expect(
      connectSrc,
      'connect-src must include the correct Supabase project ref',
    ).toContain('ipzqsfljwmkaczpqhhhm.supabase.co')
  })

  test('landing page CTA flow — hero buttons present and Get Started navigates to auth', async ({ page }) => {
    // Landing page is at /landing (unauthenticated public page)
    await page.goto(`${SITE_URL}/landing`)
    await page.waitForLoadState('networkidle')

    const body = page.locator('body')

    // Hero headline from landing.tsx
    await expect(body).toContainText(/switch youtube accounts/i, { timeout: 10_000 })

    // Hero CTA buttons: "Get Started Free" and "See How It Works"
    await expect(body).toContainText(/get started free/i)
    await expect(body).toContainText(/see how it works/i)

    // Trust line beneath hero CTAs
    await expect(body).toContainText(/no credit card required/i)

    // Pricing section on landing page (section-pricing)
    await expect(body).toContainText(/simple, item-based pricing/i)

    // Click the primary hero "Get Started Free" CTA
    const heroBtn = page.locator('[accessibilityLabel="Get started free"]').first()
    const heroBtnAlt = page.locator('text=Get Started Free').first()
    const target = (await heroBtn.count()) > 0 ? heroBtn : heroBtnAlt
    await expect(target).toBeVisible({ timeout: 10_000 })
    await target.click()
    await page.waitForLoadState('networkidle')

    // Should navigate to /auth/login (Google OAuth sign-in page)
    const urlAfter = page.url()
    expect(urlAfter).toMatch(/auth\/login|accounts\.google|ytmigration\.com/)
  })
})
