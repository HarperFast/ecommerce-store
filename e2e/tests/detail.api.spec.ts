/** Detail and search — SPEC.md §5.3, §5.4. */
import { test } from '@playwright/test';
import { covers } from '../lib/spec.ts';

test.describe('detail', () => {
	test.fixme(covers('PDP-001')('every variant is returned with live stock'), async () => {});
	test.fixme(covers('PDP-002')('a stock write is reflected within FRESH_MS'), async () => {});
	test.fixme(covers('PDP-003')('unavailable combinations are marked, not omitted'), async () => {});
	test.fixme(covers('PDP-004')('an unknown slug returns 404'), async () => {});
});

test.describe('search', () => {
	test.fixme(covers('SRCH-001')('full-text matching over title, brand and description'), async () => {});
	test.fixme(covers('SRCH-002')('faceting and pagination behave as in listing'), async () => {});
	test.fixme(covers('SRCH-003')('empty or whitespace-only q returns 400'), async () => {});
	test.fixme(covers('SRCH-004')('matching is case- and diacritic-insensitive'), async () => {});
	test.fixme(covers('SRCH-005')('multi-term queries are conjunctive'), async () => {});
});
