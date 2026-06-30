import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'
import { waitForOtpEmail } from '../../lib/imap'
import { createClient } from '@supabase/supabase-js'

const SITE_URL = process.env.YTMIGRATION_URL || 'https://channelmover.com'
const SUPABASE_URL = process.env.YTMIGRATION_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.YTMIGRATION_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.YTMIGRATION_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

// Shared IMAP config for OTP email delivery verification
const IMAP_HOST = process.env.IMAP_HOST || 'tertia.sui-inter.net'
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993')
const IMAP_USER = process.env.IMAP_USER || ''
const IMAP_PASS = process.env.IMAP_PASS || ''
const OTP_TEST_EMAIL = process.env.OTP_TEST_EMAIL || IMAP_USER

const IMAP_OPTS = {
  host: IMAP_HOST,
  port: IMAP_PORT,
  user: IMAP_USER,
  pass: IMAP_PASS,
}

test.describe('ChannelMover — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
    if (OTP_TEST_EMAIL && OTP_TEST_EMAIL !== TEST_EMAIL) {
      await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, OTP_TEST_EMAIL)
    }
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

  // NOTE: The /extension page and the Chrome extension were retired in
  // ChannelMover commit a90d08e (Data API v3 is now the default migration
  // path). The "extension page loads" and "extension page interaction" tests
  // were removed here to match shipped reality.

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
    const response = await page.goto(`${SITE_URL}/compare/channelmover-vs-google-takeout`)
    await page.waitForLoadState('networkidle')

    expect(response?.status()).not.toBe(404)

    const body = page.locator('body')
    await expect(body).not.toBeEmpty()
    await expect(body).toContainText(/takeout|compare|migration|transfer|channelmover/i)
  })

  test('auth login page loads', async ({ page }) => {
    await page.goto(`${SITE_URL}/auth/login`)
    await page.waitForLoadState('networkidle')
    // ChannelMover uses Google OAuth — verify the page loads with sign-in content
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
    expect(urlAfterClick).toMatch(/auth\/login|accounts\.google|channelmover\.com/)
  })

  // (extension page interaction test removed — extension retired, see note above)

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

  test('site identity — title contains channelmover branding', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(
      combined.includes('channelmover') || combined.includes('channel mover'),
      'channelmover.com must contain "channelmover" branding',
    ).toBe(true)
  })

  test('CSP connect-src includes correct Supabase ref', async () => {
    // Use curl via child_process — Playwright and Node fetch both miss headers in GitHub Actions CI
    const { execSync } = await import('child_process')
    const headers = execSync(`curl -sI "${SITE_URL}"`, { encoding: 'utf-8' })
    const cspLine = headers.split('\n').find((l) => l.toLowerCase().startsWith('content-security-policy'))
    const csp = cspLine ? cspLine.replace(/^[^:]+:\s*/, '').trim() : ''
    expect(csp, 'CSP header or meta tag must be present').toBeTruthy()

    const connectSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src'))

    expect(connectSrc, 'CSP must contain a connect-src directive').toBeTruthy()
    expect(
      connectSrc,
      'connect-src must include the correct Supabase project ref',
    ).toContain('qswluvqunswggfmesdcs.supabase.co')
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
    expect(urlAfter).toMatch(/auth\/login|accounts\.google|channelmover\.com/)
  })

  // ── Edge function reachability — catches missing deploys after migration ──

  test('send-auth-email edge function is reachable', async ({ request }) => {
    const response = await request.fetch(
      `${SUPABASE_URL}/functions/v1/send-auth-email`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {},
      }
    )
    const status = response.status()
    expect(
      status !== 404 && status !== 500,
      `send-auth-email returned ${status} — not deployed or crashed`
    ).toBe(true)
  })

  test.describe('Edge Functions Reachable', () => {
    const ALL_EDGE_FUNCTIONS = [
      'ai-analyze',
      'ai-categorize',
      'ai-chat',
      'check-channel-status',
      'clean-account-worker',
      'cleanup-old-data',
      'connect-youtube-account',
      'create-checkout-session',
      'delete-account',
      'disconnect-youtube-account',
      'encrypt-existing-tokens',
      'innertube-auth-poll',
      'innertube-auth-start',
      'migrate-liked-videos',
      'migrate-playlists',
      'migrate-subscriptions',
      'migrate-watch-history',
      'migrate-watch-later',
      'migration-watchdog',
      'process-migration-queue',
      'process-takeout',
      'refresh-youtube-token',
      'restart-migration',
      'resume-migration',
      'rollback-migration',
      'scan-clean-account',
      'scan-source-account',
      'send-auth-email',
      'start-clean-account',
      'start-migration',
      'stripe-webhook',
      'validate-account-tokens',
    ]

    for (const fn of ALL_EDGE_FUNCTIONS) {
      test(`edge function ${fn} is deployed`, async ({ request }) => {
        const response = await request.fetch(
          `${SUPABASE_URL}/functions/v1/${fn}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: {},
          }
        )
        const status = response.status()
        // Any status except 404 means the function is deployed and responding.
        // 500 is expected when calling without auth/body — it's still proof the function exists.
        expect(
          status !== 404,
          `Edge function "${fn}" returned 404 — not deployed`
        ).toBe(true)
      })
    }
  })

  // ── Real Login Form Interaction (not magic link bypass) ─────────────

  test('login form: fields accept input and opacity > 0', async ({ page }) => {
    await page.goto(`${SITE_URL}/auth/login`, { waitUntil: 'networkidle' })

    // ChannelMover uses Google OAuth — check for email input or Google sign-in button
    const emailInput = page.locator('input[type="email"]').first()
    const googleBtn = page.locator('button:has-text("Google"), a:has-text("Google"), button:has-text("Sign in")').first()

    const hasEmail = await emailInput.isVisible().catch(() => false)
    const hasGoogle = await googleBtn.isVisible().catch(() => false)

    expect(hasEmail || hasGoogle, 'Login page must have email input or Google sign-in').toBe(true)

    if (hasEmail) {
      const opacity = await emailInput.evaluate(
        (el: HTMLElement) => parseFloat(getComputedStyle(el).opacity),
      )
      expect(opacity, 'Login email input must have opacity > 0').toBeGreaterThan(0)
      await emailInput.fill('test-monitor@example.com')
      expect(await emailInput.inputValue()).toBe('test-monitor@example.com')
    }
  })

  // ── E2E OTP Email Delivery Verification (IMAP) ─────────────────────

  test('E2E OTP: trigger email → verify IMAP delivery → check OTP format', async ({ page }) => {
    test.skip(!IMAP_PASS, 'IMAP_PASS not configured — skipping E2E OTP email delivery test')
    test.setTimeout(150_000)

    const anonClient = createClient(SUPABASE_URL, ANON_KEY)
    const { error } = await anonClient.auth.signInWithOtp({
      email: OTP_TEST_EMAIL,
      options: { shouldCreateUser: false },
    })

    if (error?.message?.includes('security purposes') || error?.message?.includes('rate')) {
      await new Promise((r) => setTimeout(r, 10_000))
      const retry = await anonClient.auth.signInWithOtp({
        email: OTP_TEST_EMAIL,
        options: { shouldCreateUser: false },
      })
      if (retry.error) {
        test.skip(true, `OTP request rate-limited: ${retry.error.message}`)
        return
      }
    } else if (error) {
      throw new Error(`signInWithOtp failed: ${error.message}`)
    }

    let email: Awaited<ReturnType<typeof waitForOtpEmail>>
    try {
      email = await waitForOtpEmail(IMAP_OPTS, { timeoutMs: 90_000, deleteAfter: true, subjectFilter: 'ChannelMover' })
    } catch {
      throw new Error(
        'OTP email NOT delivered within 90s — send-auth-email chain is broken. ' +
        'Check: pg_net Authorization header, edge function signature guard, SMTP credentials.'
      )
    }

    expect(email.otp, 'Email should contain a 6-digit OTP code').toBeTruthy()
    expect(email.otp).toMatch(/^\d{6}$/)
    expect(email.from, 'OTP email must have a sender address').toBeTruthy()
    expect(email.subject).toContain(email.otp!)
  })
})
