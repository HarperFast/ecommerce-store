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
	test.fixme(covers('QUOTE-008')('the same cart and dataset state produce a byte-identical quote'), async () => {});

	test.fixme(covers('QUOTE-009')('an unknown cart id returns 404'), async () => {});
	test.fixme(covers('QUOTE-010')('the response itemizes per line and at cart level'), async () => {});
});
