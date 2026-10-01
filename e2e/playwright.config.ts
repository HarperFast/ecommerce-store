import { defineConfig } from '@playwright/test';

/**
 * The executable form of SPEC.md.
 *
 * Runs against ANY implementation via BASE_URL — Harper, or an assembled stack — so it must
 * never import stack code or assume a mechanism. It asserts the behaviors in SPEC.md and
 * nothing else.
 *
 *   BASE_URL=http://localhost:9926 npx playwright test
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:9926';

export default defineConfig({
	testDir: './tests',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
	use: {
		baseURL: BASE_URL,
		trace: 'on-first-retry',
		// Never record a measurement from this suite. It verifies conformance; benchmarks
		// live in bench/ and are run separately under controlled conditions.
	},
	// P0 is two JSON endpoints; there are no pages to drive. A browser project returns with
	// the storefront UI — see docs/future-work.md.
	projects: [{ name: 'api', testMatch: /.*\.api\.spec\.ts/ }],
});
