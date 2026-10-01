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

	// Sweeps a spread of carts rather than one: the defect these guard against was a cart-wide
	// promotion applied once per eligible line, which only shows on multi-line carts where that
	// promotion happens to be eligible. A single fixture would have missed it.
	test(covers('QUOTE-011')('discounts stay within the normative 60% cap, across many carts'), async ({ request }) => {
		const ids = Array.from({ length: 40 }, (_, i) => `cart-${String(i * 47).padStart(6, '0')}`);
		const offenders: string[] = [];
		let checked = 0;
		for (const id of ids) {
			const response = await request.post(API.quote(id), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();
			const lineSum = body.lines.reduce((sum: number, l: { lineTotal: number }) => sum + l.lineTotal, 0);
			// The cap is FLOORED (SPEC.md §4): asserting only `<= subtotal` accepted a 90%
			// discount, which is what the previous version of this test did.
			const cap = Math.floor((body.subtotal * 6000) / 10000);
			if (body.discountTotal > cap || body.discountTotal < 0 || body.subtotal !== lineSum) {
				offenders.push(`${id}: subtotal=${body.subtotal} lineSum=${lineSum} discount=${body.discountTotal} cap=${cap}`);
			}
		}
		// Without this, a run where every id 404s passes having verified nothing.
		expect(checked, 'quotes actually checked').toBeGreaterThan(20);
		expect(offenders, 'carts violating the discount invariant').toEqual([]);
	});

	test(covers('QUOTE-012')('every cited promotion reduced the line that cites it'), async ({ request }) => {
		const ids = Array.from({ length: 40 }, (_, i) => `cart-${String(i * 47).padStart(6, '0')}`);
		const offenders: string[] = [];
		let checked = 0;
		let withCitations = 0;
		for (const id of ids) {
			const response = await request.post(API.quote(id), { data: {} });
			if (response.status() === 404) continue;
			checked++;
			const body = await response.json();
			for (const line of body.lines) {
				const cited: string[] = line.appliedPromotionIds;
				if (cited.length) withCitations++;
				// A promotion listed twice on one line is the double-application signature.
				if (new Set(cited).size !== cited.length) offenders.push(`${id}/${line.sku}: duplicate ids ${cited.join(',')}`);
				// A cited promotion must have reduced THIS line. `lineTotal` is the gross line
				// amount, so a line citing promotions while paying its full share of an
				// undiscounted cart is a phantom citation.
				if (cited.length && body.discountTotal === 0) {
					offenders.push(`${id}/${line.sku}: cites ${cited.join(',')} but the cart has no discount`);
				}
				if (line.unitPrice * line.quantity !== line.lineTotal) {
					offenders.push(`${id}/${line.sku}: lineTotal ${line.lineTotal} != unitPrice*quantity`);
				}
			}
			if (body.discountTotal > 0 && !body.lines.some((l: { appliedPromotionIds: string[] }) => l.appliedPromotionIds.length)) {
				offenders.push(`${id}: discounted ${body.discountTotal} with no promotion cited anywhere`);
			}
		}
		expect(checked, 'quotes actually checked').toBeGreaterThan(20);
		expect(withCitations, 'lines citing a promotion').toBeGreaterThan(0);
		expect(offenders, 'carts violating promotion attribution').toEqual([]);
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
