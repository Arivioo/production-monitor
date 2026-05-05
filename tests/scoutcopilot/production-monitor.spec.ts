import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.SCOUTCOPILOT_URL || 'https://scoutcopilot.com'
const SUPABASE_URL = process.env.SCOUTCOPILOT_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SCOUTCOPILOT_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.SCOUTCOPILOT_ANON_KEY!
const TEST_EMAIL = process.env.TEST_EMAIL || 'healthcheck-test@predivo.ch'

const AUTH_CONFIG = {
  supabaseUrl: SUPABASE_URL,
  serviceRoleKey: SERVICE_ROLE_KEY,
  anonKey: ANON_KEY,
  testEmail: TEST_EMAIL,
  siteUrl: SITE_URL,
}

/** Bypass the PasswordGate by setting sessionStorage before navigation. */
async function bypassPasswordGate(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.goto(SITE_URL, { waitUntil: 'commit' })
  await page.evaluate(() => sessionStorage.setItem('scoutcopilot-unlocked', 'true'))
  await page.goto(url, { waitUntil: 'networkidle' })
}

test.describe('ScoutCopilot — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ─── Public Pages ─────────────────────────────────────────────

  test('site loads and shows content', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('landing page loads after gate bypass', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible({ timeout: 10_000 })
  })

  test('pricing page loads', async ({ page }) => {
    // Use root /pricing — the site handles language routing internally
    await bypassPasswordGate(page, `${SITE_URL}/pricing`)
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(100)
  })

  test('privacy page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/privacy`)
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('login page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/login`)
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ─── Authenticated Pages ──────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toContain('/auth')
  })

  test('dashboard loads after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    // Navigate to dashboard — let the app handle language prefix
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('search page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/search`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('settings page loads after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ─── Real User Interaction Tests ──────────────────────────────

  test('player search flow: enter query and verify results table loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/search`, { waitUntil: 'networkidle' })

    // The search input has id="player-search"
    const searchInput = page.locator('#player-search')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })

    // Type a natural-language query that matches StatsBomb demo data
    await searchInput.fill('Top strikers with goals')

    // Click the search button (the primary Button next to the input)
    const searchBtn = page.locator('button[class*="primary"]').filter({ hasText: /search/i }).first()
    // Fallback: find by role and proximity if class name differs
    const btn = searchBtn.or(page.locator('button').filter({ hasText: /search/i }).first())
    await btn.click()

    // Wait for either the results table or the "players found" header to appear.
    // The table renders inside .bg-surface-container with a <table> element,
    // or the grid view renders cards. Both share the results count heading.
    // We also accept a "no results" state — just confirm the UI responded.
    await page.waitForFunction(
      () => {
        const body = document.body.textContent ?? ''
        return (
          body.includes('found') ||          // "X players found"
          body.includes('No players') ||      // no-results state
          body.includes('No results') ||
          document.querySelector('table tbody tr') !== null ||
          document.querySelector('[role="button"][aria-label*="player" i]') !== null
        )
      },
      { timeout: 60_000 },
    )

    const bodyText = await page.locator('body').textContent()
    // Confirm the search triggered a response (results or empty state, not just the empty search page)
    const respondedToSearch =
      (bodyText ?? '').toLowerCase().includes('found') ||
      (bodyText ?? '').toLowerCase().includes('no players') ||
      (bodyText ?? '').toLowerCase().includes('no results') ||
      (await page.locator('table tbody tr').count()) > 0
    expect(respondedToSearch).toBe(true)
  })

  test('player detail view: search then click first result to view profile', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/search`, { waitUntil: 'networkidle' })

    const searchInput = page.locator('#player-search')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
    await searchInput.fill('Strikers with goals')

    const btn = page.locator('button').filter({ hasText: /search/i }).first()
    await btn.click()

    // Wait for at least one clickable player row or card
    const playerRowSelector = 'table tbody tr[role="link"], [role="button"][aria-label*="player" i]'
    const hasResults = await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length > 0,
      playerRowSelector,
      { timeout: 60_000 },
    ).then(() => true).catch(() => false)

    if (!hasResults) {
      // If the AI returned no results for this query, skip gracefully
      const bodyText = await page.locator('body').textContent()
      const noResults =
        (bodyText ?? '').toLowerCase().includes('no players') ||
        (bodyText ?? '').toLowerCase().includes('no results')
      expect(noResults).toBe(true)
      return
    }

    // Click the first player row
    const firstRow = page.locator('table tbody tr[role="link"]').first()
    const firstCard = page.locator('[role="button"][aria-label*="player" i]').first()
    const target = (await firstRow.count()) > 0 ? firstRow : firstCard
    await target.click()

    // Verify we landed on a player detail page (/en/players/:id)
    await page.waitForLoadState('networkidle')
    expect(page.url()).toMatch(/\/players\//)

    // Player profile should contain position, age, and club info
    const bodyText = await page.locator('body').textContent() ?? ''
    const hasProfileContent =
      bodyText.length > 200 &&
      // The report page renders stats, position badge, club name, back button, etc.
      (bodyText.toLowerCase().includes('age') ||
       bodyText.toLowerCase().includes('club') ||
       bodyText.toLowerCase().includes('position') ||
       bodyText.toLowerCase().includes('goals') ||
       bodyText.toLowerCase().includes('report'))
    expect(hasProfileContent).toBe(true)
  })

  test('dashboard interaction: metric cards and quick actions are present', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })

    // Wait for the dashboard heading (h1 with t('dashboard.heading'))
    const heading = page.locator('h1').first()
    await expect(heading).toBeVisible({ timeout: 10_000 })

    // Metric cards: 4 cards rendered in a grid. They each have font-data large numbers.
    // The grid has role="status" while loading; after load the cards have bg-surface-container class.
    await page.waitForFunction(
      () => {
        // Cards loaded when the skeleton pulses are gone and real data divs exist
        const cards = document.querySelectorAll('.bg-surface-container.border')
        return cards.length >= 1
      },
      { timeout: 15_000 },
    )

    // Quick actions section: 3 cards with "New Player Search", "View Players", "Compare"
    const quickActionsText = await page.locator('body').textContent() ?? ''
    const hasQuickActions =
      quickActionsText.toLowerCase().includes('search') &&
      quickActionsText.toLowerCase().includes('player')
    expect(hasQuickActions).toBe(true)

    // The "SYSTEM LIVE" badge should be present
    const liveIndicator = page.locator('span').filter({ hasText: /live/i }).first()
    await expect(liveIndicator).toBeVisible({ timeout: 5_000 })

    // Recent searches table or empty state should be rendered
    const bodyText = await page.locator('body').textContent() ?? ''
    const hasRecentSearchesSection =
      bodyText.toLowerCase().includes('recent') ||
      bodyText.toLowerCase().includes('search') ||
      bodyText.toLowerCase().includes('query')
    expect(hasRecentSearchesSection).toBe(true)
  })

  test('settings interaction: settings tabs and profile form load', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })

    // Desktop sidebar nav should be present with settings tabs
    // The nav has buttons for: Account, API Keys, Team Management, Notifications, Billing, AI Insights, Player Database
    await page.waitForFunction(
      () => {
        const nav = document.querySelector('nav')
        return nav !== null && (nav.textContent ?? '').length > 20
      },
      { timeout: 10_000 },
    )

    // Profile tab is active by default — check for profile/account form content
    const bodyText = await page.locator('body').textContent() ?? ''
    const hasSettingsTabs =
      bodyText.toLowerCase().includes('account') ||
      bodyText.toLowerCase().includes('billing') ||
      bodyText.toLowerCase().includes('api') ||
      bodyText.toLowerCase().includes('settings')
    expect(hasSettingsTabs).toBe(true)

    // Navigate to Billing tab to verify subscription/plan display
    // Desktop: click the billing button in the sidebar nav
    const billingBtn = page.locator('nav button').filter({ hasText: /billing/i }).first()
    const mobileBillingTab = page.locator('button').filter({ hasText: /billing/i }).first()
    const billingTarget = (await billingBtn.count()) > 0 ? billingBtn : mobileBillingTab
    await billingTarget.click()

    await page.waitForFunction(
      () => {
        const body = document.body.textContent ?? ''
        // BillingSettings renders "Billing" heading and current plan info
        return body.toLowerCase().includes('plan') || body.toLowerCase().includes('billing')
      },
      { timeout: 10_000 },
    )

    const billingText = await page.locator('body').textContent() ?? ''
    expect(billingText.toLowerCase()).toMatch(/plan|billing|subscription|tier/)
  })

  test('search filters: position filter changes and UI reflects the update', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/search`, { waitUntil: 'networkidle' })

    // SearchFilters renders 3 <select> dropdowns.
    // Position select: id is computed from the translated label, but we can target by index.
    // The selects are rendered in order: Position, Age Range, League.
    const selects = page.locator('select')
    await expect(selects.first()).toBeVisible({ timeout: 10_000 })

    const selectCount = await selects.count()
    expect(selectCount).toBeGreaterThanOrEqual(3)

    // Select "Forward" (or the first non-default position option) in the first select (Position)
    const positionSelect = selects.nth(0)
    const positionOptions = await positionSelect.locator('option').allTextContents()
    // Pick the second option (first is "All Positions" default)
    const targetPosition = positionOptions[1]
    if (targetPosition) {
      await positionSelect.selectOption({ index: 1 })
      // Confirm the select now shows the chosen value
      const selected = await positionSelect.inputValue()
      expect(selected).toBe(targetPosition)
    }

    // Select an age range (second select)
    const ageSelect = selects.nth(1)
    const ageOptions = await ageSelect.locator('option').allTextContents()
    const targetAge = ageOptions[1]
    if (targetAge) {
      await ageSelect.selectOption({ index: 1 })
      const selectedAge = await ageSelect.inputValue()
      expect(selectedAge).toBe(targetAge)
    }

    // Now run a search and confirm the filters are still set (not reset on search)
    const searchInput = page.locator('#player-search')
    await searchInput.fill('midfielders')
    const searchBtn = page.locator('button').filter({ hasText: /search/i }).first()
    await searchBtn.click()

    // Wait for the search to complete (results or no-results state)
    await page.waitForFunction(
      () => {
        const body = document.body.textContent ?? ''
        return (
          body.includes('found') ||
          body.includes('No players') ||
          body.includes('No results') ||
          document.querySelector('table tbody tr') !== null
        )
      },
      { timeout: 60_000 },
    )

    // Verify position select retained its value after search
    const positionAfter = await positionSelect.inputValue()
    expect(positionAfter).toBe(targetPosition ?? positionAfter)
  })
})
