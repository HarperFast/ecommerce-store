/** Product aggregate — SPEC.md §5. The read-heavy leg. */
import { test, expect } from '@playwright/test';
import { API, productSearchParams } from '@ecommerce-store/spec';
import { covers } from '../lib/spec.ts';

/** SPEC.md §6. The coherence BUDGET, not the expected latency. */
const FRESH_MS = 1000;

const get = (id: string, tier: string, region: string) => `${API.product(id)}?${productSearchParams({ tier, region })}`;

test.describe('product aggregate', () => {

	// A cache-key bug here serves one tier's price to another. It presents as a caching
	// problem and reads as a pricing problem, so it is asserted rather than inferred.
	test(covers('PDP-002')('tier and region vary the response and are part of any cache key'), async ({ request }) => {
		const standard = await (await request.get(get('product-000001', 'standard', 'us-east'))).json();
		const platinum = await (await request.get(get('product-000001', 'platinum', 'us-east'))).json();
		const skus = Object.keys(standard.resolvedPrice);
		expect(skus.length).toBeGreaterThan(0);
		for (const sku of skus) {
			expect(platinum.resolvedPrice[sku], `platinum must not pay the standard price for ${sku}`)
				.toBeLessThan(standard.resolvedPrice[sku]);
		}
		expect(standard.tier).toBe('standard');
		expect(platinum.tier).toBe('platinum');
	});

	test(covers('PDP-003')('a write is visible on the aggregate within FRESH_MS'), async ({ request }) => {
		const url = get('product-000021', 'silver', 'us-west');
		const warmed = await (await request.get(url)).json();
		const sku = warmed.variants[0].sku;
		const target = warmed.variants[0].basePrice === 31337 ? 31338 : 31337;

		const at = Date.now();
		expect((await request.post(`/admin/variant/${sku}`, { data: { basePrice: target } })).ok()).toBe(true);

		// Poll rather than sleep: FRESH_MS is the BUDGET, not the expected latency, and
		// asserting after a fixed wait would hide an implementation that is much faster.
		let observedMs = -1;
		for (let attempt = 0; attempt < 40; attempt++) {
			const body = await (await request.get(url)).json();
			if (body.variants.find((v: { sku: string }) => v.sku === sku)?.basePrice === target) {
				observedMs = Date.now() - at;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(observedMs, 'the write never became visible').toBeGreaterThanOrEqual(0);
		expect(observedMs, `visible after ${observedMs}ms, budget is ${FRESH_MS}ms`).toBeLessThanOrEqual(FRESH_MS);
	});
	test(covers('PDP-004')('an unknown product id returns 404'), async ({ request }) => {
		expect((await request.get(get('no-such-product', 'standard', 'us-east'))).status()).toBe(404);
	});

	test(covers('PDP-001')('aggregates product, variants, inventory, price, rollup and related'), async ({ request }) => {
		const body = await (await request.get(get('product-000001', 'gold', 'us-east'))).json();
		expect(body.product.id).toBe('product-000001');
		expect(body.product.reviewRollup).toBeDefined();
		expect(body.variants.length).toBeGreaterThan(0);
		for (const variant of body.variants) {
			expect(body.availability[variant.sku], `availability missing for ${variant.sku}`).toBeDefined();
			expect(body.resolvedPrice[variant.sku], `resolved price missing for ${variant.sku}`).toBeDefined();
		}
		expect(Array.isArray(body.related)).toBe(true);
	});
	test(covers('PDP-005')('related items carry enough detail to render'), async ({ request }) => {
		const body = await (await request.get(get('product-000022', 'standard', 'us-east'))).json();
		expect(Array.isArray(body.related)).toBe(true);
		expect(body.related.length, 'the sampled product should have related items').toBeGreaterThan(0);
		for (const item of body.related) {
			// Enough to render a related-items strip: an id to link, a title to show, and the
			// rollup the strip displays. Needing a second request per item would turn one
			// aggregate into N+1.
			expect(item.id).toBeTruthy();
			expect(item.title, `related item ${item.id} has no title`).toBeTruthy();
			expect(item.reviewRollup, `related item ${item.id} has no review rollup`).toBeDefined();
		}
	});
});
