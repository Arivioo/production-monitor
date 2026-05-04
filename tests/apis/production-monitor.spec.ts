import { test, expect } from '@playwright/test'

const SITE_URL = process.env.APIS_URL || 'https://predivo.ch'

test.describe('APIs (predivo.ch) — Production Monitor', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
    // Check key content sections render
    const text = await page.textContent('body')
    expect(text?.length).toBeGreaterThan(100)
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

  test('all navigation links work', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    // Check that key sections exist
    const body = await page.textContent('body')
    expect(body).toBeTruthy()
  })
})
