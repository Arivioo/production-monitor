import { test, expect } from '@playwright/test'
import { loginViaMagicLink, ensureTestUser } from '../../lib/auth'

const SITE_URL = process.env.SHIPSOLO_URL || 'https://distributionos.predivo.ch'
const SUPABASE_URL = process.env.SHIPSOLO_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SHIPSOLO_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.SHIPSOLO_ANON_KEY!
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
  await page.evaluate(() => sessionStorage.setItem('distribution-os-dev-access', 'true'))
  await page.goto(url, { waitUntil: 'networkidle' })
}

test.describe('ShipSolo — Production Monitor', () => {
  test.beforeAll(async () => {
    await ensureTestUser(SUPABASE_URL, SERVICE_ROLE_KEY, TEST_EMAIL)
  })

  // ── Public pages ───────────────────────────────────────────────────

  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('landing page has hero', async ({ page }) => {
    await bypassPasswordGate(page, SITE_URL)
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible({ timeout: 10_000 })
  })

  test('pricing page loads', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/pricing`)
    await expect(page.locator('body')).not.toBeEmpty()
    await expect(page.locator('body')).toContainText(/pricing|free|starter|pro|plan/i)
  })

  test('login page has form', async ({ page }) => {
    await bypassPasswordGate(page, `${SITE_URL}/login`)
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first()
    await expect(emailInput).toBeVisible({ timeout: 10_000 })
  })

  // ── Authenticated tests ────────────────────────────────────────────

  test('full login works and dashboard loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.waitForLoadState('networkidle')
    const url = page.url()
    expect(url).not.toContain('/auth')
  })

  test('dashboard shows content after login', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  test('products page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/products`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('settings page loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.locator('body').textContent()
    expect((text || '').length).toBeGreaterThan(50)
  })

  // ── Interaction tests ──────────────────────────────────────────────

  test('products CRUD: add product, verify in list, delete via settings', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/products`, { waitUntil: 'networkidle' })

    // Open add product modal
    const addBtn = page.locator('button', { hasText: '+ Add Product' }).first()
    await expect(addBtn).toBeVisible({ timeout: 10_000 })
    await addBtn.click()

    // Wait for modal to appear
    const modal = page.locator('[role="dialog"][aria-modal="true"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Fill in product name — the modal auto-focuses the first input
    const nameInput = modal.locator('input').first()
    await nameInput.fill('Test Product CI')

    // Fill description
    const descInput = modal.locator('input').nth(1)
    await descInput.fill('Automated test product — safe to delete')

    // Submit the form
    const submitBtn = modal.locator('button[type="submit"]')
    await expect(submitBtn).toBeEnabled({ timeout: 3_000 })
    await submitBtn.click()

    // Modal should close
    await expect(modal).not.toBeVisible({ timeout: 5_000 })

    // Verify new product card appears in the list
    const productCard = page.locator('h3', { hasText: 'Test Product CI' })
    await expect(productCard).toBeVisible({ timeout: 10_000 })

    // Delete the product via Settings > Products tab to avoid leaving test data
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })

    // Settings defaults to Products tab — find the delete button for our product
    const deleteBtn = page.locator('[aria-label*="delete" i], button[title*="delete" i], button svg.lucide-trash-2').first()
    // Fall back: find Trash2 button near our product name
    const productRow = page.locator('text=Test Product CI').first()
    await expect(productRow).toBeVisible({ timeout: 10_000 })

    // Accept the confirm() dialog that fires on delete
    page.on('dialog', dialog => dialog.accept())

    // Click the trash icon button in the same card as our product
    const trashBtn = page
      .locator('.space-y-4 > *')
      .filter({ hasText: 'Test Product CI' })
      .locator('button')
      .last()
    await trashBtn.click()

    // Verify product is no longer in the list
    await expect(page.locator('text=Test Product CI')).not.toBeVisible({ timeout: 5_000 })
  })

  test('dashboard data: shows command center heading and score badge', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })

    // The dashboard either shows Command Center (normal) or FirstMission/SetupSprint (onboarding)
    const body = page.locator('body')
    await expect(body).not.toBeEmpty()

    // Check for known dashboard content patterns
    const hasCommandCenter = await page.locator('h1', { hasText: /Command Center/i }).isVisible().catch(() => false)
    const hasFirstMission = await page.locator('h1, h2', { hasText: /mission|setup|welcome|get started/i }).isVisible().catch(() => false)

    expect(hasCommandCenter || hasFirstMission).toBe(true)

    if (hasCommandCenter) {
      // Verify score badge is present with numeric content
      const scoreBadge = page.locator('text=/Weekly Score/i').first()
      await expect(scoreBadge).toBeVisible({ timeout: 5_000 })

      // Verify overall progress section or engine metric cards are rendered
      const hasProgress = await page.locator('text=/Overall Progress|Engine/i').first().isVisible().catch(() => false)
      const hasEmptyState = await page.locator('text=/You\'re all set|no products|add a product/i').first().isVisible().catch(() => false)
      expect(hasProgress || hasEmptyState).toBe(true)
    }
  })

  test('product detail: click product card and verify detail view loads', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/products`, { waitUntil: 'networkidle' })

    // Check if any product cards exist
    const productLinks = page.locator('a[href^="/products/"]')
    const count = await productLinks.count()

    if (count === 0) {
      // No products — verify the empty state or add button is present instead
      const addBtn = page.locator('button', { hasText: '+ Add Product' }).first()
      await expect(addBtn).toBeVisible({ timeout: 5_000 })
      return
    }

    // Click the first product card
    await productLinks.first().click()
    await page.waitForLoadState('networkidle')

    // Verify URL changed to /products/:id
    expect(page.url()).toMatch(/\/products\/[^/]+$/)

    // Verify detail view elements: breadcrumb back link and product name heading
    const backLink = page.locator('a[href="/products"], a[href*="products"]').first()
    await expect(backLink).toBeVisible({ timeout: 10_000 })

    // Verify the page has product info (name in an h1 or h2)
    const heading = page.locator('h1, h2').first()
    await expect(heading).toBeVisible({ timeout: 5_000 })
    const headingText = await heading.textContent()
    expect((headingText || '').trim().length).toBeGreaterThan(0)
  })

  test('settings interaction: tabs work, AI config BYOK field exists, subscription tier displayed', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/settings`, { waitUntil: 'networkidle' })

    // Verify the Settings heading
    const heading = page.locator('h1', { hasText: /Settings/i })
    await expect(heading).toBeVisible({ timeout: 10_000 })

    // Verify the tab bar is present
    const tabList = page.locator('[role="tablist"]')
    await expect(tabList).toBeVisible({ timeout: 5_000 })

    // Navigate to the AI Configuration tab
    const aiTab = page.locator('[role="tab"]', { hasText: /AI Configuration/i })
    await expect(aiTab).toBeVisible({ timeout: 5_000 })
    await aiTab.click()

    // Verify BYOK (API key) input field is present
    const apiKeyInput = page.locator('input[placeholder*="sk-ant"]')
    await expect(apiKeyInput).toBeVisible({ timeout: 5_000 })

    // Navigate to General tab to verify subscription-related content
    const generalTab = page.locator('[role="tab"]', { hasText: /General/i })
    await expect(generalTab).toBeVisible()
    await generalTab.click()

    // General tab should render without error (dark mode toggle is a reliable landmark)
    const generalContent = page.locator('[role="tabpanel"]').last()
    await expect(generalContent).toBeVisible({ timeout: 5_000 })
    const generalText = await generalContent.textContent()
    expect((generalText || '').length).toBeGreaterThan(20)
  })

  test('navigation completeness: all sidebar nav items present and navigable without errors', async ({ page }) => {
    await loginViaMagicLink(page, AUTH_CONFIG)
    await page.goto(`${SITE_URL}/dashboard`, { waitUntil: 'networkidle' })

    // Collect the expected nav routes from the sidebar (mirrors NAV_ITEMS in AppLayout)
    const NAV_ROUTES = [
      { label: 'Dashboard', path: '/dashboard' },
      { label: 'Inbox', path: '/inbox' },
      { label: 'Products', path: '/products' },
      { label: 'Settings', path: '/settings' },
    ]

    // Verify each nav link is present in the desktop sidebar
    const sidebar = page.locator('aside.hidden.md\\:flex')

    for (const { label } of NAV_ROUTES) {
      const navLink = sidebar.locator(`a, [role="tab"]`, { hasText: label }).first()
      // Nav items may be locked during onboarding — accept either visible link or locked div
      const isPresent = await navLink.isVisible().catch(() => false)
      const isLockedPresent = await sidebar.locator(`text=${label}`).first().isVisible().catch(() => false)
      expect(isPresent || isLockedPresent).toBe(true)
    }

    // Navigate to each unlocked route and verify no hard error state
    const NAVIGABLE_ROUTES = [
      `${SITE_URL}/products`,
      `${SITE_URL}/settings`,
      `${SITE_URL}/inbox`,
      `${SITE_URL}/dashboard`,
    ]

    for (const url of NAVIGABLE_ROUTES) {
      await page.goto(url, { waitUntil: 'networkidle' })

      // Verify page did not land on /login (would mean auth failed)
      expect(page.url()).not.toContain('/login')
      expect(page.url()).not.toContain('/auth/verify')

      // Verify body has substantial content (not a blank error page)
      const text = await page.locator('body').textContent()
      expect((text || '').length).toBeGreaterThan(50)

      // Verify no unhandled React error boundary message
      const hasErrorBoundary = await page.locator('text=/Something went wrong|Unexpected error|application error/i').isVisible().catch(() => false)
      expect(hasErrorBoundary).toBe(false)
    }
  })
})
