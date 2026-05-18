import { test, expect } from '@playwright/test'

const SITE_URL = process.env.APIS_URL || 'https://predivo.ch'

test.describe('APIs (predivo.ch) — Production Monitor', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.textContent('body')
    expect(text?.length).toBeGreaterThan(10)
  })

  test('landing page has heading', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const heading = page.locator('h1').first()
    await expect(heading).toBeVisible({ timeout: 10_000 })
  })

  test('site identity — title contains Predivo', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'predivo.ch must contain "predivo" branding').toContain('predivo')
    // Guard: must NOT show another project's branding as primary content
    expect(title.toLowerCase(), 'Title must not be hijacked by another project').not.toContain('valrano')
    expect(title.toLowerCase(), 'Title must not be hijacked by another project').not.toContain('signalscore')
    expect(title.toLowerCase(), 'Title must not be hijacked by another project').not.toContain('shipsolo')
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
})
