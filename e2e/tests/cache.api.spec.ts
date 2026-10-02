/** Caching — SPEC.md §3. Derived, bounded, correctly keyed. */
import { test, expect } from '@playwright/test';
import { API, productSearchParams } from '@ecommerce-store/spec';
import { covers } from '../lib/spec.ts';

const get = (id: string, tier: string, region: string) => `${API.product(id)}?${productSearchParams({ tier, region })}`;
const cacheStatus = (serverTiming: string | null) => serverTiming?.match(/cache;desc=(\w+)/)?.[1] ?? null;

test.describe('caching', () => {
	test(covers('CACHE-001')('a cached response is byte-identical to the one that filled it'), async ({ request }) => {
		const url = get('product-000011', 'silver', 'us-west');
		const first = await request.get(url);
		const second = await request.get(url);
		// The cache may only change latency. If a hit differs from the fill that produced it,
		// the cache is authoritative rather than derived.
		expect(await second.text()).toBe(await first.text());
		expect(cacheStatus(second.headers()['server-timing'])).toBe('hit');
	});

	test(covers('CACHE-003')('a value cached for one tier is never served to another'), async ({ request }) => {
		// Warm standard, then ask for platinum. A key missing a varying dimension returns the
		// warmed value — a correctness failure that presents as a pricing bug.
		await request.get(get('product-000012', 'standard', 'us-east'));
		const platinum = await (await request.get(get('product-000012', 'platinum', 'us-east'))).json();
		const standard = await (await request.get(get('product-000012', 'standard', 'us-east'))).json();
		expect(platinum.tier).toBe('platinum');
		for (const sku of Object.keys(standard.resolvedPrice)) {
			expect(platinum.resolvedPrice[sku], `platinum must not be served the standard price for ${sku}`)
				.toBeLessThan(standard.resolvedPrice[sku]);
		}
	});

	test(covers('CACHE-002', 'OBS-002')('a write invalidates the cache, and status is reported'), async ({ request }) => {
		const url = get('product-000013', 'gold', 'us-east');
		const warmed = await (await request.get(url)).json();
		const sku = warmed.variants[0].sku;

		const hit = await request.get(url);
		expect(cacheStatus(hit.headers()['server-timing']), 'a second read must be a hit').toBe('hit');

		const write = await request.post(`/admin/variant/${sku}`, { data: { basePrice: 54321 } });
		expect(write.ok()).toBe(true);
		// The fan-out is the cost SPEC.md §6 measures, so the write reports what it invalidated.
		expect((await write.json()).invalidated).toBeGreaterThan(0);

		const after = await request.get(url);
		expect(cacheStatus(after.headers()['server-timing']), 'the write must have evicted it').toBe('miss');
		const body = await after.json();
		expect(body.variants.find((v: { sku: string }) => v.sku === sku).basePrice).toBe(54321);
	});

	test(covers('OBS-001', 'OBS-003')('Server-Timing decomposes data access and total'), async ({ request }) => {
		const response = await request.get(get('product-000014', 'gold', 'apac'));
		const timing = response.headers()['server-timing'];
		expect(timing, 'Server-Timing must be present').toBeTruthy();
		expect(timing, 'data-access phase').toMatch(/data;dur=[\d.]+/);
		expect(timing, 'total').toMatch(/total;dur=[\d.]+/);
		expect(timing, 'cache status').toMatch(/cache;desc=(hit|miss)/);
	});
});
