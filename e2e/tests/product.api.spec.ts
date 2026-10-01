/** Product aggregate — SPEC.md §5. The read-heavy leg. */
import { test } from '@playwright/test';
import { covers } from '../lib/spec.ts';

test.describe('product aggregate', () => {
	test.fixme(covers('PDP-001')('aggregates product, variants, inventory, price, rollup and related'), async () => {});

	// A cache-key bug here serves one tier's price to another. It presents as a caching
	// problem and reads as a pricing problem, so it is asserted rather than inferred.
	test.fixme(covers('PDP-002')('tier and region vary the response and are part of any cache key'), async () => {});

	test.fixme(covers('PDP-003')('inventory and price reflect background writes within FRESH_MS'), async () => {});
	test.fixme(covers('PDP-004')('an unknown product id returns 404'), async () => {});
	test.fixme(covers('PDP-005')('related items render without a further request'), async () => {});
});
