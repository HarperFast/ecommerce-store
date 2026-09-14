/**
 * Deterministic tiered catalog generator.
 *
 * Tiers (P1): `sm` / `md` / `lg`, where `lg` deliberately exceeds a free Fabric node's RAM
 * so "working set exceeds memory" is a dimension we design for rather than a footnote.
 *
 * Determinism is a hard requirement — the same tier must produce byte-identical corpora on
 * every platform implementation, or the comparison is measuring different data.
 */
export {};
