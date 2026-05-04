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

test.describe('ScoutCopilot — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ─── Public Pages ─────────────────────────────────────────────

  test('site loads and shows content', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
    expect(page.url()).toContain('scoutcopilot')
  })

  test('landing page has pricing section with tier cards', async ({ page }) => {
    await page.goto(`${SITE_URL}/en`, { waitUntil: 'networkidle' })
    // The landing page has a #pricing section with 3 tier cards (scout, pro, club)
    const pricingSection = page.locator('#pricing')
    await expect(pricingSection).toBeVisible({ timeout: 10_000 })
    // Each tier card contains a price with "$" and "/mo"
    const tierCards = pricingSection.locator('.grid > div').filter({ hasText: '/mo' })
    await expect(tierCards).toHaveCount(3, { timeout: 10_000 })
  })

  test('pricing page loads with 3 tier cards', async ({ page }) => {
    await page.goto(`${SITE_URL}/en/pricing`, { waitUntil: 'networkidle' })
    // Verify the h1 heading is present
    await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 })
    // 3 tier cards each with a "$" price and "/mo" suffix
    const tierCards = page.locator('section .grid > div').filter({ hasText: '/mo' })
    await expect(tierCards).toHaveCount(3, { timeout: 10_000 })
    // Verify comparison table exists
    await expect(page.locator('table')).toBeVisible({ timeout: 10_000 })
  })

  test('privacy page loads with content', async ({ page }) => {
    await page.goto(`${SITE_URL}/en/privacy`, { waitUntil: 'networkidle' })
    // h1 should be visible (Privacy Policy title)
    await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 })
    // Page should contain Predivo GmbH as the data controller
    await expect(page.locator('main')).toContainText('Predivo GmbH', { timeout: 10_000 })
    // Multiple sections with h2 headings
    const sections = page.locator('main h2')
    expect(await sections.count()).toBeGreaterThanOrEqual(3)
  })

  test('login page has email input and form', async ({ page }) => {
    await page.goto(`${SITE_URL}/en/login`, { waitUntil: 'networkidle' })
    // h1 sign-in heading
    await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 })
    // Email input field (id="login-email" in password tab, or id="code-email" in code tab)
    const emailInput = page.locator('input[type="email"]')
    await expect(emailInput.first()).toBeVisible({ timeout: 10_000 })
    // Submit button should be present
    await expect(page.locator('button[type="submit"]')).toBeVisible({ timeout: 10_000 })
  })

  // ─── Authenticated Pages ──────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toContain('/auth')
  })

  test('dashboard loads with metric cards or skeleton', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/en/dashboard`, { waitUntil: 'networkidle' })
    // Dashboard heading (h1) should be visible
    await expect(page.locator('h1')).toBeVisible({ timeout: 15_000 })
    // Either metric cards (grid with stat items) or skeleton loaders should be present
    const metricGrid = page.locator('[role="status"], .grid')
    await expect(metricGrid.first()).toBeVisible({ timeout: 15_000 })
    // Quick actions section should exist at the bottom
    await expect(page.locator('[role="button"]').first()).toBeVisible({ timeout: 10_000 })
  })

  test('search page has search input', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/en/search`, { waitUntil: 'networkidle' })
    // SearchBar component renders a div with role="search" containing an input[type="search"]
    const searchContainer = page.locator('[role="search"]')
    await expect(searchContainer).toBeVisible({ timeout: 15_000 })
    const searchInput = searchContainer.locator('input[type="search"]')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
  })

  test('players/reports page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/en/players`, { waitUntil: 'networkidle' })
    // Page should render — either a table with scouted players or an empty state
    await expect(page.locator('body')).not.toBeEmpty()
    // h1 or a heading element should be present
    const heading = page.locator('h1, h2').first()
    await expect(heading).toBeVisible({ timeout: 15_000 })
  })

  test('compare page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/en/compare`, { waitUntil: 'networkidle' })
    // Comparison page has an h1 heading
    await expect(page.locator('h1')).toBeVisible({ timeout: 15_000 })
    // Tactical context input should be present (id="tactical-context")
    await expect(page.locator('#tactical-context')).toBeVisible({ timeout: 10_000 })
  })

  test('settings page loads with tabs', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/en/settings`, { waitUntil: 'networkidle' })
    // Settings page has a desktop sub-sidebar nav with tab buttons
    // On mobile it uses ScrollableTabBar; on desktop it's a <nav> with buttons
    // Check that at least one settings section is visible (profile is the default tab)
    const settingsContent = page.locator('.max-w-4xl')
    await expect(settingsContent).toBeVisible({ timeout: 15_000 })
    // The page should contain settings-related sections (bg-surface-container cards)
    const settingsSections = page.locator('section, [class*="bg-surface-container"]')
    expect(await settingsSections.count()).toBeGreaterThanOrEqual(1)
  })

  test('sidebar navigation has expected nav items', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/en/dashboard`, { waitUntil: 'networkidle' })
    // Sidebar has aria-label for navigation and contains nav items as buttons
    const sidebar = page.locator('aside[aria-label]')
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    // The sidebar nav should contain 7 items: Dashboard, Search, Players, Compare, Watchlists, My Squads, Settings
    const navButtons = sidebar.locator('nav ul li button')
    await expect(navButtons).toHaveCount(7, { timeout: 10_000 })
  })
})
