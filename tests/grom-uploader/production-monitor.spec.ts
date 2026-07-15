import { test, expect } from '@playwright/test'

// grom-uploader is a Cloudflare Worker that serves the album-upload UI at GET /
// and exposes POST /usage + POST /presign. A liveness probe just needs GET / to
// return 200 with the uploader document (not a 5xx / worker error).
const SITE_URL = process.env.GROM_UPLOADER_URL || 'https://grom-uploader.grom-b3d.workers.dev'

test.describe('grom-uploader — Production Monitor', () => {
  test('worker root is reachable (not 5xx)', async ({ request }) => {
    const res = await request.get(SITE_URL, { failOnStatusCode: false })
    expect(res.status(), `grom-uploader returned ${res.status()} — worker DOWN`).toBeLessThan(500)
    expect(res.status(), 'GET / should serve the uploader UI').toBe(200)
  })

  test('serves the upload UI', async ({ page }) => {
    await page.goto(SITE_URL)
    await page.waitForLoadState('networkidle')
    const title = await page.title()
    const body = (await page.textContent('body')) || ''
    const combined = `${title} ${body}`.toLowerCase()
    expect(combined, 'must render the album-upload UI').toContain('upload')
    // The uploader always renders a file input for selecting album files.
    await expect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 10_000 })
  })
})
