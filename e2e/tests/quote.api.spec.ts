/**
 * Cart quote — SPEC.md §4. The primary endpoint under test.
 *
 * P0 skeleton: titles bind to requirement ids and the shapes are stated; assertions are
 * fixme until P1 puts data behind them. Landing it now means the coverage check is real
 * from the first commit.
 */
import { test, expect } from '@playwright/test';
import { API } from '@ecommerce-store/spec';
import { covers } from '../lib/spec.ts';

test.describe('cart quote', () => {
	// The one an implementation is most likely to "optimise" into a conformance failure, so
	// it is asserted directly: two carts with identical contents but different ids must not
	// be able to share a response, and a repeated request must re-do the work.
	test.fixme(covers('QUOTE-001')('no response-level caching; every response is cart-unique'), async () => {});

	test.fixme(covers('QUOTE-002')('each line resolves product and variant; unknown sku fails with 400'), async ({ request }) => {
		const response = await request.post(API.quote('cart-with-unknown-sku'));
		expect(response.status()).toBe(400);
	});

	test.fixme(covers('QUOTE-003')('availability resolves across locations by priority'), async () => {});
	test.fixme(covers('QUOTE-004')('customer tier and loyalty balance are applied'), async () => {});

	// Stacking order is normative precisely because an unspecified order makes two correct
	// implementations disagree on a total — a non-equivalent-semantics cell, not a close one.
	test.fixme(covers('QUOTE-005')('promotions evaluate exclusive, threshold, BOGO, then stackable'), async () => {});

	test.fixme(covers('QUOTE-006')('shipping resolves by region and total weight'), async () => {});
	test.fixme(covers('QUOTE-007')('tax applies to the post-discount subtotal'), async () => {});

	// The ground-truth correctness guard the measurement rules require: a throughput-only
	// benchmark would report a silently wrong quote as a result.
	test(covers('QUOTE-008')('the same cart and dataset state produce a byte-identical quote'), async ({ request }) => {
		const url = API.quote('cart-000042');
		const first = await request.post(url, { data: {} });
		const second = await request.post(url, { data: {} });
		expect(first.status()).toBe(200);
		expect(second.status()).toBe(200);
		// Byte-identical, not deep-equal: key order is part of the contract, because a
		// response that reorders between identical requests cannot be cached or diffed.
		expect(await second.text()).toBe(await first.text());
	});

	test(covers('QUOTE-009')('an unknown cart id returns 404'), async ({ request }) => {
		const response = await request.post(API.quote('no-such-cart'), { data: {} });
		expect(response.status()).toBe(404);
	});

	test(covers('QUOTE-010')('the response itemizes per line and at cart level'), async ({ request }) => {
		const body = await (await request.post(API.quote('cart-000042'), { data: {} })).json();
		expect(body).toMatchObject({ cartId: 'cart-000042', currency: 'USD' });
		for (const field of ['subtotal', 'discountTotal', 'shipping', 'tax', 'grandTotal']) {
			expect(Number.isInteger(body[field]), `${field} must be integer minor units`).toBe(true);
		}
		expect(body.lines.length).toBeGreaterThan(0);
		for (const line of body.lines) {
			expect(Number.isInteger(line.unitPrice)).toBe(true);
			expect(Number.isInteger(line.lineTotal)).toBe(true);
			expect(Array.isArray(line.appliedPromotionIds)).toBe(true);
		}
		expect(body.grandTotal).toBe(body.subtotal - body.discountTotal + body.shipping + body.tax);
	});
});
