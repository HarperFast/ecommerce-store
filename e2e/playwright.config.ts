import { defineConfig, devices } from '@playwright/test';

/**
 * The executable form of SPEC.md.
 *
 * This suite runs against ANY implementation via BASE_URL — Harper, Vercel, Supabase — so
 * it must never import platform code or assume a mechanism. It asserts the behaviors in
 * SPEC.md and nothing else.
 *
 *   BASE_URL=http://localhost:9926 PROFILE=APP npx playwright test
 *
 * PROFILE selects which requirements apply (SPEC.md §2): DATA for backend-only
 * implementations, APP for full-stack ones.
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
	projects: [
		{ name: 'api', testMatch: /.*\.api\.spec\.ts/ },
		{ name: 'pages', testMatch: /.*\.page\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
	],
});
