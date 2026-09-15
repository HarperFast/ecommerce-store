/**
 * Binds tests to SPEC.md requirement ids.
 *
 * Every test names the requirements it covers, as `covers('PLP-003', 'PLP-005')`, which
 * prefixes the test title with those ids. `scripts/coverage.mjs` then scans the suite and
 * fails if any MUST for the active profile has no test — SPEC.md §11.
 *
 * Using the title as the carrier (rather than a runtime registry) means coverage is
 * checkable statically, without running the suite against a live implementation.
 */
import { requirement, type Profile } from '@ecommerce-store/spec';

export const PROFILE: Profile = (process.env.PROFILE as Profile) ?? 'APP';

/** Build a test title carrying its requirement ids. Throws on an unknown id. */
export function covers(...ids: string[]): (description: string) => string {
	for (const id of ids) requirement(id); // throws if the id is not in the registry
	return (description: string) => `[${ids.join(' ')}] ${description}`;
}

/** True when a requirement applies to the profile under test. */
export function applies(id: string): boolean {
	const req = requirement(id);
	if (req.withdrawn) return false;
	return req.profile === PROFILE || (PROFILE === 'APP' && req.profile === 'DATA');
}
