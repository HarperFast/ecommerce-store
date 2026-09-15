/**
 * The machine-readable half of SPEC.md.
 *
 * Everything exported here is PLATFORM-NEUTRAL: routes, shapes and requirement ids, never
 * mechanisms. If a symbol here could not be implemented on Postgres, it does not belong in
 * this package.
 */

export const SPEC_VERSION = '0.1.0-draft' as const;

export * from './model.ts';
export * from './requirements.ts';
export * from './routes.ts';
