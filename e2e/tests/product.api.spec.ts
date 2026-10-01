/** Product aggregate — SPEC.md §5. The read-heavy leg. */
import { test, expect } from '@playwright/test';
import { API, productSearchParams } from '@ecommerce-store/spec';
import { covers } from '../lib/spec.ts';

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

	test.fixme(covers('PDP-003')('inventory and price reflect background writes within FRESH_MS'), async () => {});
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
	test.fixme(covers('PDP-005')('related items render without a further request'), async () => {});
});
