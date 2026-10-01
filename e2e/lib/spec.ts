/**
 * Binds tests to SPEC.md requirement ids.
 *
 * Every test names what it covers, as `covers('QUOTE-005')`, which prefixes the test title
 * with those ids. `scripts/coverage.mjs` then scans the suite and fails if any MUST has no
 * test — SPEC.md §8.
 *
 * Using the title as the carrier (rather than a runtime registry) keeps coverage checkable
 * statically, without running the suite against a live implementation.
 */
import { requirement } from '@ecommerce-store/spec';

/** Build a test title carrying its requirement ids. Throws on an unknown id. */
export function covers(...ids: string[]): (description: string) => string {
	for (const id of ids) requirement(id); // throws if the id is not in the registry
	return (description: string) => `[${ids.join(' ')}] ${description}`;
}
