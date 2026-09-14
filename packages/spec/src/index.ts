/**
 * The machine-readable half of SPEC.md.
 *
 * Everything exported here is PLATFORM-NEUTRAL. It describes routes, shapes and
 * requirement ids — never mechanisms. If a symbol here could not be implemented on
 * Postgres, it does not belong in this package.
 *
 * Populated in P0 alongside SPEC.md.
 */

/** Stable requirement id, e.g. `PLP-004`. Referenced by e2e tests and by SPEC.md. */
export type RequirementId = string;

export const SPEC_VERSION = '0.0.0-draft' as const;
