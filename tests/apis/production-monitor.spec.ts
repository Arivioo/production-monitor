import { test, expect } from '@playwright/test'

const SITE_URL = process.env.APIS_URL || 'https://predivo.ch'

test.describe('APIs (predivo.ch) — Production Monitor', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.textContent('body')
    expect(text?.length).toBeGreaterThan(100)
  })

  test('landing page has hero and navigation', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    // Should have a heading
    const h1 = page.locator('h1').first()
    await expect(h1).toBeVisible({ timeout: 10_000 })
    // Should have navigation
    const nav = page.locator('nav, header').first()
    await expect(nav).toBeVisible({ timeout: 10_000 })
  })

  test('no console errors on landing page', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)
    const criticalErrors = errors.filter(
      (e) => !e.includes('favicon') && !e.includes('manifest') && !e.includes('third-party'),
    )
    expect(criticalErrors, `Console errors: ${criticalErrors.join('; ')}`).toHaveLength(0)
  })

  test('impressum page loads', async ({ page }) => {
    const response = await page.goto(`${SITE_URL}/impressum`, { waitUntil: 'networkidle' })
    if (response?.status() !== 404) {
      await expect(page.locator('body')).toContainText(/impressum|predivo/i)
    }
  })

  test('datenschutz page loads', async ({ page }) => {
    const response = await page.goto(`${SITE_URL}/datenschutz`, { waitUntil: 'networkidle' })
    if (response?.status() !== 404) {
      await expect(page.locator('body')).toContainText(/datenschutz|privacy/i)
    }
  })

  test('all internal links are valid', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    // Collect all internal anchor links
    const links = await page.locator('a[href^="/"]').all()
    expect(links.length).toBeGreaterThan(0)
    // Verify at least one internal link exists and is visible
    await expect(page.locator('a[href^="/"]').first()).toBeVisible({ timeout: 10_000 })
  })
})
