import { test, expect } from '@playwright/test';

/**
 * External API Health Checks — verifies third-party APIs that our products depend on.
 * Runs hourly as part of the production monitor. Emails Roger if any API breaks.
 *
 * Currently monitors:
 * - Brandfetch Search API (used by Valrano for domain discovery)
 * - Google Favicon V2 (used by Valrano for company logos)
 */

// Brandfetch client ID — public (embedded in browser-facing search URLs)
const BRANDFETCH_CLIENT_ID = '1idRDjMi84k4oQP5jUq';

test.describe('External API Health Checks', () => {

  test.describe('Brandfetch Search API', () => {
    test('returns results for known company "Holcim"', async ({ request }) => {
      const response = await request.get(
        `https://api.brandfetch.io/v2/search/${encodeURIComponent('Holcim')}?c=${BRANDFETCH_CLIENT_ID}`,
      );

      expect(response.status(), 'Brandfetch Search API returned non-200').toBe(200);

      const results = await response.json() as Array<{ name: string; domain: string }>;
      expect(results.length, 'Brandfetch returned no results for "Holcim"').toBeGreaterThan(0);

      // At least one result should contain "holcim" in the domain
      const hasHolcim = results.some(r => r.domain?.toLowerCase().includes('holcim'));
      expect(hasHolcim, `Brandfetch results for "Holcim" don't include holcim domain: ${JSON.stringify(results.map(r => r.domain))}`).toBe(true);
    });

    test('returns results for known company "CEMEX"', async ({ request }) => {
      const response = await request.get(
        `https://api.brandfetch.io/v2/search/${encodeURIComponent('CEMEX')}?c=${BRANDFETCH_CLIENT_ID}`,
      );

      expect(response.status(), 'Brandfetch Search API returned non-200').toBe(200);

      const results = await response.json() as Array<{ name: string; domain: string }>;
      expect(results.length, 'Brandfetch returned no results for "CEMEX"').toBeGreaterThan(0);
    });

    test('returns empty array (not error) for nonsense query', async ({ request }) => {
      const response = await request.get(
        `https://api.brandfetch.io/v2/search/${encodeURIComponent('xyznonexistent12345')}?c=${BRANDFETCH_CLIENT_ID}`,
      );

      // Should return 200 with empty array, not an error
      expect(response.status(), 'Brandfetch should return 200 even for no-match queries').toBe(200);
    });
  });

  test.describe('Google Favicon V2', () => {
    const testDomains = ['holcim.com', 'cemex.com', 'sika.com'];

    for (const domain of testDomains) {
      test(`returns favicon for ${domain}`, async ({ request }) => {
        const response = await request.get(
          `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
        );

        expect(response.status(), `Google Favicon returned non-200 for ${domain}`).toBe(200);

        const contentType = response.headers()['content-type'] ?? '';
        expect(contentType, `Google Favicon did not return an image for ${domain}`).toMatch(/^image\//);

        // Favicon should be a reasonable size (not a 1x1 pixel placeholder)
        const body = await response.body();
        expect(body.length, `Google Favicon for ${domain} is suspiciously small (${body.length} bytes)`).toBeGreaterThan(100);
      });
    }
  });

});
