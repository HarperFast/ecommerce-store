/** Dataset, background writes and observability — SPEC.md §3, §6, §7. */
import { test } from '@playwright/test';
import { covers } from '../lib/spec.ts';

test.describe('dataset', () => {
	test.fixme(covers('DATA-001')('the eight logical entities are present and not pre-joined'), async () => {});
	test.fixme(covers('DATA-002')('money is integer minor units throughout'), async () => {});
	test.fixme(covers('DATA-003')('the loaded dataset matches the manifest checksum'), async () => {});
	test.fixme(covers('DATA-004')('the working set exceeds memory on the benchmark hardware'), async () => {});
	test.fixme(covers('DATA-005')('the dataset is reproducible from the committed generator'), async () => {});
});

test.describe('background writes', () => {
	test.fixme(covers('WRITE-001')('the writer updates inventory and prices in the read working set'), async () => {});
	test.fixme(covers('WRITE-002')('a committed write reaches the aggregate and quote within FRESH_MS'), async () => {});

	// The cheap way to pass WRITE-002 is to turn caching off, which would make the whole
	// comparison meaningless. Hit rate is asserted non-zero alongside freshness.
	test.fixme(covers('WRITE-003')('freshness is achieved with caching active, not disabled'), async () => {});

	test.fixme(covers('WRITE-004')('the write stream matches the configured rate and key distribution'), async () => {});
});

test.describe('observability', () => {
	test.fixme(covers('OBS-001')('Server-Timing decomposes data access, compute and total'), async () => {});
	test.fixme(covers('OBS-002')('responses indicate cache status'), async () => {});
	test.fixme(covers('OBS-003')('instrumentation is present on both endpoints'), async () => {});
});
