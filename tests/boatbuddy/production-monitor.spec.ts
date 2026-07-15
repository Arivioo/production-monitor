import { test, expect } from '@playwright/test'

const SITE_URL = process.env.BOATBUDDY_URL || 'https://boatbuddy.predivo.ch'

test.describe('BoatBuddy — Production Monitor', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
    const text = await page.textContent('body')
    expect(text?.length).toBeGreaterThan(100)
  })

  test('site identity — title contains BoatBuddy', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'boatbuddy.predivo.ch must contain "boatbuddy" branding').toContain('boatbuddy')
    expect(title.toLowerCase(), 'Title must not be hijacked').not.toContain('valrano')
    expect(title.toLowerCase(), 'Title must not be hijacked').not.toContain('signalscore')
  })

  test('root document is served (not 5xx / not paused)', async ({ request }) => {
    const res = await request.get(SITE_URL, { failOnStatusCode: false })
    expect(res.status(), `BoatBuddy returned ${res.status()} — site DOWN`).toBeLessThan(500)
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
      (e) => !e.includes('favicon') && !e.includes('manifest') && !e.includes('third-party') && !e.includes('Content Security Policy') && !e.includes('X-Frame-Options'),
    )
    expect(criticalErrors, `Console errors: ${criticalErrors.join('; ')}`).toHaveLength(0)
  })
})
