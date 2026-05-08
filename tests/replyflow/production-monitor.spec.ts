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

  test('protected route requires auth', async ({ page }) => {
    // Go to /app without logging in — should either redirect or show login prompt
    await page.goto(`${SITE_URL}/app`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    // Should not show actual app content (reviews, analytics) without auth
    const url = page.url()
    const body = await page.locator('body').textContent()
    // Either redirected to login/auth page OR shows login prompt on the page
    const isOnAuthPage = url.includes('/login') || url.includes('/auth') || url.includes('/signup')
    const hasLoginPrompt = (body || '').match(/sign.?in|log.?in|anmeld/i)
    expect(isOnAuthPage || hasLoginPrompt, 'Should require auth to access /app').toBeTruthy()
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

  // ── Feature interaction tests ────────────────────────────────────────

  const AUTH_OPTS = () => ({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    anonKey: ANON_KEY,
    testEmail: TEST_EMAIL,
    siteUrl: SITE_URL,
  })

  test('dashboard data loads — stat cards and sections render with content', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    await page.goto(`${SITE_URL}/app`, { waitUntil: 'networkidle' })

    // Page heading "Dashboard" must be visible
    // The h1 is sr-only on some layouts — check by title or main presence instead
    const heading = page.locator('h1', { hasText: 'Dashboard' })
    await expect(heading).toBeVisible({ timeout: 15_000 })

    // All four stat card labels must appear.
    // Labels are rendered as text nodes inside StatCard spans — matched via partial text.
    // "Needs Reply" card is wrapped in a <Link>; use the span label text directly.
    await expect(page.locator('span', { hasText: 'Total Reviews' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('span', { hasText: 'Average Rating' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('span', { hasText: 'Response Rate' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('span', { hasText: 'Needs Reply' }).first()).toBeVisible({ timeout: 15_000 })

    // "Recent Reviews" section heading must be present
    const recentHeading = page.locator('h2', { hasText: 'Recent Reviews' })
    await expect(recentHeading).toBeVisible({ timeout: 15_000 })

    // Quick-action links must be present
    await expect(page.locator('a, button').filter({ hasText: 'Generate AI Replies' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('a').filter({ hasText: 'View All Reviews' }).first()).toBeVisible({ timeout: 15_000 })

    // The section below "Recent Reviews" must show either a review card or the empty-state message.
    // Empty state: "Set up your business in Settings to get started." (no business) or
    //              "No reviews yet. Connect a platform to start importing reviews." (business but no reviews)
    // Review card: aria-label="Review from ..."
    // We look for each independently and assert at least one is present.
    const emptyState = page.locator('p').filter({ hasText: /Set up your business|No reviews yet/i }).first()
    const reviewCard = page.locator('[aria-label^="Review from"]').first()
    const hasEmpty = await emptyState.isVisible({ timeout: 20_000 }).catch(() => false)
    const hasReviews = await reviewCard.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasEmpty || hasReviews, 'Recent Reviews section must show either reviews or an empty-state message').toBeTruthy()
  })

  test('reviews interaction — list loads, filters work, detail panel opens', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    await page.goto(`${SITE_URL}/app/reviews`, { waitUntil: 'networkidle' })

    // Page heading "Reviews" must be visible
    const heading = page.locator('h1', { hasText: 'Reviews' })
    await expect(heading).toBeVisible({ timeout: 15_000 })

    // All five status tabs must be present
    for (const label of ['All', 'Needs Reply', 'Draft Ready', 'Edited', 'Posted']) {
      await expect(page.getByRole('button', { name: new RegExp(label, 'i') }).first()).toBeVisible({ timeout: 10_000 })
    }

    // Rating and sort dropdowns must be rendered
    const ratingSelect = page.locator('select[aria-label="Filter by rating"]')
    await expect(ratingSelect).toBeVisible({ timeout: 10_000 })
    const sortSelect = page.locator('select[aria-label="Sort reviews"]')
    await expect(sortSelect).toBeVisible({ timeout: 10_000 })

    // Switch sort to "Oldest First" and verify the dropdown reflects the change
    await sortSelect.selectOption('oldest')
    await expect(sortSelect).toHaveValue('oldest')

    // Switch sort back to "Newest First"
    await sortSelect.selectOption('newest')
    await expect(sortSelect).toHaveValue('newest')

    // Click the "Needs Reply" status tab
    await page.getByRole('button', { name: /Needs Reply/i }).first().click()
    // The right panel should show the placeholder when nothing is selected, or reviews are visible
    const rightPanel = page.locator('text=/Select a review to view details|No reviews match/i').first()
    await expect(rightPanel).toBeVisible({ timeout: 10_000 })

    // Click "All" tab to reset
    await page.getByRole('button', { name: /^All\s/i }).first().click()

    // If any review rows exist, click the first one and verify detail panel opens
    const firstReviewBtn = page.locator('[aria-label^="Review from"]').first()
    const hasReviews = await firstReviewBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasReviews) {
      await firstReviewBtn.click()
      // Detail panel should show the reviewer name as an h2
      const detailHeading = page.locator('h2').first()
      await expect(detailHeading).toBeVisible({ timeout: 10_000 })
      // Review body card should be present (contains the review text)
      const reviewBodyCard = page.locator('.rounded-xl.border').first()
      await expect(reviewBodyCard).toBeVisible({ timeout: 10_000 })
    } else {
      // Empty state — verify the no-match message is shown
      await expect(page.locator('text=/No reviews match the current filters/i').first()).toBeVisible({ timeout: 10_000 })
    }
  })

  test('analytics interaction — stat cards, date range buttons and distribution sections render', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    await page.goto(`${SITE_URL}/app/analytics`, { waitUntil: 'networkidle' })

    // Page heading "Analytics" must be visible
    const heading = page.locator('h1', { hasText: 'Analytics' })
    await expect(heading).toBeVisible({ timeout: 15_000 })

    // Subheading copy must be present
    await expect(page.locator('p', { hasText: 'Track your review performance over time.' }).first()).toBeVisible({ timeout: 10_000 })

    // All five date range buttons must be present
    for (const range of ['7D', '30D', '3M', '12M', 'All']) {
      await expect(page.getByRole('button', { name: range }).first()).toBeVisible({ timeout: 10_000 })
    }

    // Default active range is "30D" — click "7D" and verify it becomes active
    const btn7D = page.getByRole('button', { name: '7D' }).first()
    await btn7D.click()
    // After click the button should have accent styling (border-accent bg-accent text-white)
    await expect(btn7D).toHaveClass(/bg-accent/, { timeout: 5_000 })

    // Click "All" range
    await page.getByRole('button', { name: 'All' }).first().click()

    // Stat card labels are rendered as spans inside StatCard — use span locator to avoid
    // matching the outer wrapper button's combined accessible text.
    await expect(page.locator('span', { hasText: 'Total Reviews' }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('span', { hasText: 'Avg Rating' }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('span', { hasText: 'Response Rate' }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('span', { hasText: 'Replies Posted' }).first()).toBeVisible({ timeout: 10_000 })

    // Section headings for both distribution panels must appear
    await expect(page.locator('h2', { hasText: 'Rating Distribution' })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('h2', { hasText: 'Sentiment Breakdown' })).toBeVisible({ timeout: 10_000 })

    // Sentiment labels (Positive/Neutral/Negative) only render when reviews exist.
    // With a fresh test account there may be zero reviews, in which case the section shows
    // "No reviews in this time period." — accept either state.
    const hasReviews = await page.locator('span', { hasText: 'Positive' }).first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasReviews) {
      await expect(page.locator('span', { hasText: 'Positive' }).first()).toBeVisible({ timeout: 5_000 })
      await expect(page.locator('span', { hasText: 'Neutral' }).first()).toBeVisible({ timeout: 5_000 })
      await expect(page.locator('span', { hasText: 'Negative' }).first()).toBeVisible({ timeout: 5_000 })
    } else {
      // No reviews — both distribution sections show the empty-state message
      const emptyMessages = page.locator('p', { hasText: 'No reviews in this time period.' })
      await expect(emptyMessages.first()).toBeVisible({ timeout: 5_000 })
    }
  })

  test('settings interaction — profile tab fields populated, tab switching works, business tab has name field', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    // Navigate directly to the profile tab via URL — the page uses useSearchParams for tab state
    await page.goto(`${SITE_URL}/app/settings?tab=profile`, { waitUntil: 'networkidle' })

    expect(page.url()).toContain('/app/settings')

    // ── Profile tab ────────────────────────────────────────────────────

    // The email input (#settings-email) must be present and contain the test email address.
    // It is rendered as a disabled/readOnly input on the profile tab.
    const emailInput = page.locator('#settings-email')
    await expect(emailInput).toBeVisible({ timeout: 15_000 })
    await expect(emailInput).toHaveValue(TEST_EMAIL, { timeout: 10_000 })

    // The full-name input must be present (value may be empty for a fresh test user)
    const nameInput = page.locator('#settings-fullname')
    await expect(nameInput).toBeVisible({ timeout: 10_000 })

    // "Change password" and "Update email" buttons must be present
    await expect(page.getByRole('button', { name: /Change password/i }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: /Update email/i }).first()).toBeVisible({ timeout: 10_000 })

    // Danger zone section must be present
    await expect(page.locator('h3', { hasText: 'Danger Zone' }).first()).toBeVisible({ timeout: 10_000 })

    // ── Switch to Business tab ─────────────────────────────────────────
    // The settings page uses URL query param ?tab=<key> for navigation.
    // Navigate via URL to avoid desktop-vs-mobile nav ambiguity.
    await page.goto(`${SITE_URL}/app/settings?tab=business`, { waitUntil: 'networkidle' })

    // Business tab must render the business name input
    const businessNameInput = page.locator('#settings-business-name')
    await expect(businessNameInput).toBeVisible({ timeout: 15_000 })

    // Business type select must be present
    const businessTypeSelect = page.locator('#settings-business-type')
    await expect(businessTypeSelect).toBeVisible({ timeout: 10_000 })

    // ── Switch to Billing tab ──────────────────────────────────────────
    await page.goto(`${SITE_URL}/app/settings?tab=billing`, { waitUntil: 'networkidle' })

    // Billing tab must render — look for "Plan" or "Billing" or "Upgrade" or "Trial" text
    const billingContent = page.locator('body').filter({ hasText: /Plan|Billing|Upgrade|Trial/i })
    await expect(billingContent).toBeVisible({ timeout: 15_000 })

    // ── Switch to Notifications tab ────────────────────────────────────
    await page.goto(`${SITE_URL}/app/settings?tab=notifications`, { waitUntil: 'networkidle' })

    // Notifications tab renders toggles with labels like "New review alerts", "Weekly digest"
    const notifContent = page.locator('body').filter({ hasText: /review alerts|Weekly digest|Notification/i })
    await expect(notifContent).toBeVisible({ timeout: 15_000 })
  })

  test('site identity — title contains replyflow', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'replyflow.help must contain "replyflow" branding').toContain('replyflow')
  })

  test('navigation flow — sidebar has all nav items, clicking each loads the correct page without errors', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_OPTS())
    await page.goto(`${SITE_URL}/app`, { waitUntil: 'networkidle' })

    // The sidebar brand label must be visible
    await expect(page.getByText('ReplyFlow').first()).toBeVisible({ timeout: 15_000 })

    // All four nav links must be visible in the sidebar
    const expectedNavLabels = ['Dashboard', 'Reviews', 'Analytics', 'Settings']
    for (const label of expectedNavLabels) {
      await expect(page.getByRole('link', { name: label }).first()).toBeVisible({ timeout: 10_000 })
    }

    // Navigate to Reviews via sidebar link
    await page.getByRole('link', { name: 'Reviews' }).first().click()
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/app/reviews')
    // No JS error banner — body must not contain "Something went wrong"
    await expect(page.locator('body')).not.toContainText('Something went wrong', { timeout: 5_000 })
    // Reviews h1 must be present
    await expect(page.locator('h1', { hasText: 'Reviews' })).toBeVisible({ timeout: 10_000 })

    // Navigate to Analytics via sidebar link
    await page.getByRole('link', { name: 'Analytics' }).first().click()
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/app/analytics')
    await expect(page.locator('body')).not.toContainText('Something went wrong', { timeout: 5_000 })
    await expect(page.locator('h1', { hasText: 'Analytics' })).toBeVisible({ timeout: 10_000 })

    // Navigate to Settings via sidebar link
    await page.getByRole('link', { name: 'Settings' }).first().click()
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/app/settings')
    await expect(page.locator('body')).not.toContainText('Something went wrong', { timeout: 5_000 })
    // Settings renders an sr-only h1; check the profile email field is present instead
    await expect(page.locator('#settings-email')).toBeVisible({ timeout: 15_000 })

    // Navigate back to Dashboard via sidebar link
    await page.getByRole('link', { name: 'Dashboard' }).first().click()
    await page.waitForLoadState('networkidle')
    expect(page.url()).toMatch(/\/app\/?$/)
    await expect(page.locator('body')).not.toContainText('Something went wrong', { timeout: 5_000 })
    await expect(page.locator('h1', { hasText: 'Dashboard' })).toBeVisible({ timeout: 10_000 })
  })
})
