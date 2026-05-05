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

  // ── Interaction tests ──

  test('company search flow: search input accepts text and shows results or empty state', async ({ page }) => {
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

    // The dashboard shows a "Search" card with CompanySearchInput when user can run checks
    const searchCard = page.locator('h3:has-text("Search")').first()
    await expect(searchCard).toBeVisible({ timeout: 10_000 })

    // The search input has aria-label="Search Swiss company"
    const searchInput = page.locator('[aria-label="Search Swiss company"]')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })

    // Type a company name — the input debounces at 2 chars
    await searchInput.fill('Migros')
    await page.waitForTimeout(1500) // allow search debounce + API roundtrip

    // Either results appeared (CommandGroup) or "No companies found." or searching spinner
    const hasResults = await page.locator('[cmdk-group-heading]').isVisible().catch(() => false)
    const hasEmpty = await page.locator('text=No companies found.').isVisible().catch(() => false)
    const isSearching = await page.locator('text=Searching...').isVisible().catch(() => false)

    expect(hasResults || hasEmpty || isSearching).toBe(true)

    // If results loaded, click the first one and verify company card + "Run Company Check" button appear
    if (hasResults) {
      const firstResult = page.locator('[cmdk-item]').first()
      await firstResult.click()
      await page.waitForTimeout(300)

      // After selection, search card is replaced by company detail card with "Run Company Check" button
      await expect(page.locator('button:has-text("Run Company Check")')).toBeVisible({ timeout: 5_000 })
    }
  })

  test('check history: page structure, search input, and status filters render', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/dashboard/history`, { waitUntil: 'networkidle' })

    // Page heading
    await expect(page.locator('h1:has-text("Check History")')).toBeVisible({ timeout: 10_000 })

    // Search input is rendered
    const historySearch = page.locator('[aria-label="Search credit checks"]')
    await expect(historySearch).toBeVisible({ timeout: 10_000 })

    // Status filter buttons are all present
    await expect(page.locator('button:has-text("All")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('button:has-text("Completed")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('button:has-text("Failed")')).toBeVisible({ timeout: 5_000 })

    // Either a list of checks rendered or the empty state
    const hasChecks = await page.locator('text=/\\d+ checks?/').isVisible().catch(() => false)
    const hasEmpty = await page.locator('text=No checks yet.').isVisible().catch(() => false)
    const hasFilteredEmpty = await page.locator('text=No checks match your filters.').isVisible().catch(() => false)
    expect(hasChecks || hasEmpty || hasFilteredEmpty).toBe(true)

    // If checks exist, clicking the first one should navigate to the report
    if (hasChecks) {
      // The check rows are <button> elements inside a CardContent div-y
      const firstCheckRow = page.locator('button.flex.w-full.items-center').first()
      const isVisible = await firstCheckRow.isVisible().catch(() => false)
      if (isVisible) {
        await firstCheckRow.click()
        await page.waitForLoadState('networkidle')
        // Should navigate to /dashboard/check/:id
        expect(page.url()).toMatch(/\/dashboard\/check\//)
        // The report page shows a back button and the subject name
        await expect(page.locator('body')).not.toBeEmpty()
        const text = await page.locator('body').textContent()
        expect((text || '').length).toBeGreaterThan(50)
      }
    }
  })

  test('dashboard data: heading, search card, and recent checks section all render', async ({ page }) => {
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

    // Dashboard heading
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible({ timeout: 10_000 })

    // "Recent Checks" section always renders (heading present)
    await expect(page.locator('h2:has-text("Recent Checks")')).toBeVisible({ timeout: 10_000 })

    // Either shows recent checks or the empty-state prompt
    const hasChecks = await page.locator('[role="button"]').first().isVisible().catch(() => false)
    const hasEmptyState = await page.locator('text=No credit checks yet').isVisible().catch(() => false)
    expect(hasChecks || hasEmptyState).toBe(true)

    // If there are recent checks, the score badge or status badge is visible
    if (hasChecks) {
      // RecentCheckRow renders a Badge with score grade · score or status label
      const badges = page.locator('[class*="badge"], .badge')
      const badgeCount = await badges.count()
      expect(badgeCount).toBeGreaterThan(0)
    }

    // The methodology link is always shown on the dashboard
    await expect(page.locator('text=How is the score calculated?')).toBeVisible({ timeout: 5_000 })
  })

  test('settings interaction: account email displays, nav tabs render, billing plan section visible', async ({ page }) => {
    await loginViaMagicLink(page, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      anonKey: ANON_KEY,
      testEmail: TEST_EMAIL,
      siteUrl: SITE_URL,
    })
    await page.waitForLoadState('networkidle')

    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })

    // Settings heading
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 })

    // Side nav is rendered with labelled section links
    const settingsNav = page.locator('nav[aria-label="Settings sections"]')
    await expect(settingsNav).toBeVisible({ timeout: 5_000 })
    await expect(settingsNav.locator('a:has-text("Account")')).toBeVisible({ timeout: 5_000 })
    await expect(settingsNav.locator('a:has-text("Billing")')).toBeVisible({ timeout: 5_000 })

    // The Account sub-page is the default outlet — email input is visible
    const emailInput = page.locator('#account-email')
    await expect(emailInput).toBeVisible({ timeout: 5_000 })
    // Email input shows the test user's email (non-empty)
    const emailValue = await emailInput.inputValue()
    expect(emailValue.length).toBeGreaterThan(0)
    expect(emailValue).toContain('@')

    // Navigate to Billing tab and verify plan/subscription info renders
    await settingsNav.locator('a:has-text("Billing")').click()
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/settings/billing')

    // "Current Usage" card is always shown (requires org data to load)
    await expect(page.locator('text=Current Usage')).toBeVisible({ timeout: 10_000 })

    // Plans section heading
    await expect(page.locator('h2:has-text("Plans")')).toBeVisible({ timeout: 5_000 })

    // At least the Free plan card is visible with a "Current Plan" badge (test user is on free tier)
    await expect(page.locator('text=Free').first()).toBeVisible({ timeout: 5_000 })
  })

  test('methodology page: all 7 sections render and dimension cards are visible', async ({ page }) => {
    // Methodology is accessible both as a public page and as an authenticated route.
    // Test the public route so no login is needed.
    await bypassPasswordGate(page, `${SITE_URL}/legal/methodology`)

    // Hero heading is split across two lines in JSX: "Scoring" + "Methodology"
    await expect(page.locator('h1').filter({ hasText: 'Scoring' })).toBeVisible({ timeout: 10_000 })

    // All 7 section headers render (SectionHeader emits "Section 01" … "Section 07" labels)
    for (const num of ['01', '02', '03', '04', '05', '06', '07']) {
      await expect(page.locator(`text=Section ${num}`)).toBeVisible({ timeout: 10_000 })
    }

    // Section 01 — "How It Works" with its three step cards
    await expect(page.locator('h2:has-text("How It Works")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('h3:has-text("Collect")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('h3:has-text("Analyze")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('h3:has-text("Score")')).toBeVisible({ timeout: 5_000 })

    // Section 02 — "The 7 Scoring Dimensions" and the weight distribution bar
    await expect(page.locator('h2:has-text("The 7 Scoring Dimensions")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('text=Weight Distribution')).toBeVisible({ timeout: 5_000 })

    // At least one dimension card label is visible (Registry & Legal Stability is first)
    await expect(page.locator('h3:has-text("Registry & Legal Stability")')).toBeVisible({ timeout: 5_000 })

    // Section 03 — Scoring Scale with grade labels
    await expect(page.locator('h2:has-text("Scoring Scale")')).toBeVisible({ timeout: 5_000 })
    // Grade "A" tile is visible
    await expect(page.locator('text=Very Low Risk').first()).toBeVisible({ timeout: 5_000 })

    // Section 04 — Data Sources
    await expect(page.locator('h2:has-text("Data Sources")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('text=Zefix').first()).toBeVisible({ timeout: 5_000 })

    // Section 07 — Calibration & Transparency (last section before disclaimer)
    await expect(page.locator('h2:has-text("Calibration & Transparency")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('h3:has-text("Current Limitations")')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('h3:has-text("Planned Improvements")')).toBeVisible({ timeout: 5_000 })

    // Disclaimer banner at the bottom
    await expect(page.locator('h3:has-text("Important Limitations")')).toBeVisible({ timeout: 10_000 })
  })
})
