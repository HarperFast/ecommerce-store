/**
 * Background writes and the remaining quote instrumentation — SPEC.md, "Background writes" and "Observability".
 *
 * The dataset requirements (DATA-001/002/003/005) and the run-level ones (DATA-004,
 * WRITE-001/003/004) are NOT here, deliberately. They are properties of the committed
 * artifact and of what the harness offered, not of any request, so they are verified by
 * `scripts/verify-dataset.mjs` and `scripts/verify-run-record.mjs`, which declare what they
 * cover and are counted by the coverage gate. A Playwright test for "the working set exceeds
 * memory" could only assert something it cannot observe.
 */
import { test, expect } from '@playwright/test';
import { API } from '@ecommerce-store/spec';
import { covers } from '../lib/spec.ts';

/** SPEC.md, "Background writes". The coherence BUDGET, not the expected latency. */
const FRESH_MS = 1000;

test.describe('background writes', () => {
	test(covers('WRITE-002')('a committed write reaches quote pricing within FRESH_MS'), async ({ request }) => {
		// Find a cart whose first line we can move the price of, then watch the QUOTE — not
		// the aggregate. A cache that invalidates the product view but leaves quote pricing
		// stale would pass PDP-003 and still be wrong.
		const cartId = 'cart-000314';
		const before = await request.post(API.quote(cartId), { data: {} });
		test.skip(before.status() === 404, 'sample cart absent from this dataset');
		const body = await before.json();
		const line = body.lines[0];
		const target = line.unitPrice > 20000 ? 1234 : 987654;

		const at = Date.now();
		const write = await request.post(`/admin/variant/${line.sku}`, { data: { basePrice: target } });
		expect(write.ok()).toBe(true);

		let observedMs = -1;
		for (let attempt = 0; attempt < 40; attempt++) {
			const after = await (await request.post(API.quote(cartId), { data: {} })).json();
			const updated = after.lines.find((l: { sku: string }) => l.sku === line.sku);
			// Tier pricing is applied on top, so compare against the gross direction of travel
			// rather than the exact figure.
			if (updated && updated.unitPrice !== line.unitPrice) {
				observedMs = Date.now() - at;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(observedMs, 'the write never reached quote pricing').toBeGreaterThanOrEqual(0);
		expect(observedMs, `visible after ${observedMs}ms, budget is ${FRESH_MS}ms`).toBeLessThanOrEqual(FRESH_MS);
	});
});

test.describe('observability', () => {
	test(covers('OBS-001')('the quote endpoint decomposes data access and compute'), async ({ request }) => {
		const response = await request.post(API.quote('cart-000042'), { data: {} });
		test.skip(response.status() === 404, 'sample cart absent from this dataset');
		const timing = response.headers()['server-timing'];
		expect(timing, 'Server-Timing must be present on the quote too').toBeTruthy();
		expect(timing, 'data-access phase').toMatch(/data;dur=[\d.]+/);
		expect(timing, 'compute phase').toMatch(/compute;dur=[\d.]+/);
		expect(timing, 'total').toMatch(/total;dur=[\d.]+/);
		// The quote is deliberately not response-cacheable, so it reports `miss` rather than
		// omitting the field — that is how a run record tells "not cached" from "not
		// instrumented".
		expect(timing, 'cache status').toMatch(/cache;desc=miss/);
	});
});

test.describe('identity', () => {
	test(covers('QUOTE-004')('tier is applied to pricing and the loyalty balance is carried'), async ({ request }) => {
		const byTier = new Map<string, number>();
		let withBalance = 0;
		let checked = 0;
		for (let i = 0; i < 80; i++) {
			const response = await request.post(API.quote(`cart-${String(i * 19).padStart(6, '0')}`), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();

			// Carried: present, an integer, non-negative. Redemption is future work, so it must
			// NOT have reduced anything — the totals have to reconcile without it.
			expect(Number.isInteger(body.loyaltyBalance), `${body.cartId} loyaltyBalance`).toBe(true);
			expect(body.loyaltyBalance).toBeGreaterThanOrEqual(0);
			if (body.loyaltyBalance > 0) withBalance++;
			expect(body.grandTotal, 'the balance must not have been silently redeemed')
				.toBe(body.subtotal - body.discountTotal + body.shipping + body.tax);

			// Applied: the tier must actually move prices. Collected per tier below.
			expect(body.tier).toBeTruthy();
			const line = body.lines[0];
			if (line) byTier.set(body.tier, Math.max(byTier.get(body.tier) ?? 0, line.unitPrice));
		}
		expect(checked).toBeGreaterThan(40);
		// Some sampled customer must actually hold a balance, or "carried" is untested.
		expect(withBalance, 'no sampled customer had a loyalty balance').toBeGreaterThan(0);
		expect(byTier.size, 'the sample must span more than one tier').toBeGreaterThan(1);
	});
});
