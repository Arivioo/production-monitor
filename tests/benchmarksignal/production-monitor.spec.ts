import { test, expect } from '@playwright/test'

const SITE_URL = process.env.BENCHMARKSIGNAL_URL || 'https://benchmarksignal.predivo.ch'

test.describe('BenchmarkSignal — Production Monitor', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).not.toBeEmpty()
  })

  test('site identity — title contains BenchmarkSignal', async ({ page }) => {
    await page.goto(SITE_URL, { waitUntil: 'networkidle' })
    const title = await page.title()
    const body = await page.textContent('body')
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'benchmarksignal.predivo.ch must contain "benchmarksignal" branding').toContain('benchmarksignal')
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
