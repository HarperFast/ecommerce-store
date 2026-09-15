/**
 * Admin writes — SPEC.md §5.5. The measured write path, and the source of invalidation
 * fan-out: one SKU write must reach the detail response, listing results, facet counts and
 * the product aggregate.
 */
import { test } from '@playwright/test';
import { covers } from '../lib/spec.ts';

test.describe('admin writes', () => {
	test.fixme(covers('ADM-001', 'AUTH-005')('operator role required; 401 then 403'), async () => {});
	test.fixme(covers('ADM-002')('writes visible within FRESH_MS on detail, FANOUT_MS on listing'), async () => {});
	test.fixme(covers('ADM-003')('invalid stock or price returns 400 with no partial application'), async () => {});
	test.fixme(covers('ADM-004')('bulk updates apply atomically per SKU'), async () => {});
	test.fixme(covers('ADM-005')('a stock write updates product inStock and facet counts'), async () => {});
});

test.describe('observability', () => {
	test.fixme(covers('OBS-001')('Server-Timing decomposes data access, render and total'), async () => {});
	test.fixme(covers('OBS-002')('instrumentation is present on every surface'), async () => {});
	test.fixme(covers('OBS-003')('responses indicate cache status'), async () => {});
});

test.describe('corpus', () => {
	test.fixme(covers('SEED-001')('the corpus matches the manifest checksum'), async () => {});
	test.fixme(covers('SEED-002')('the expected tier is loaded'), async () => {});
	test.fixme(covers('SEED-003')('the lg working set exceeds node memory'), async () => {});
	test.fixme(covers('SEED-004')('vocabularies match the fixed tables'), async () => {});
	test.fixme(covers('SEED-005')('seeding is reproducible and checksum-verifiable'), async () => {});
	test.fixme(covers('SEED-006')('media are deterministic and served from the origin'), async () => {});
});
