/**
 * Fixed vocabularies — SPEC.md DATA-005.
 *
 * In source, never sampled externally and never model-generated, so the dataset is
 * reproducible from this file plus a seed.
 */

export const TIERS = ['standard', 'silver', 'gold', 'platinum'] as const;

/** Tier price multipliers in basis points, applied to basePrice. Deterministic, not drawn. */
export const TIER_BASIS_POINTS: Record<string, number> = {
	standard: 10000,
	silver: 9500,
	gold: 9000,
	platinum: 8500,
};

export const REGIONS = ['us-east', 'us-west', 'eu-central', 'apac'] as const;

export const JURISDICTIONS = ['us-ny', 'us-ca', 'us-tx', 'eu-de', 'eu-fr', 'apac-jp'] as const;

export const CATEGORIES = [
	'apparel', 'apparel-shirts', 'apparel-outerwear', 'apparel-footwear',
	'home', 'home-kitchen', 'home-bedding',
	'electronics', 'electronics-audio', 'electronics-wearables',
	'outdoor', 'outdoor-camping', 'outdoor-cycling',
] as const;

export const BRANDS = [
	'Northwind', 'Alpine', 'Harbor', 'Cedar', 'Meridian', 'Kestrel',
	'Lumen', 'Basalt', 'Thistle', 'Юнона', 'Fjord', 'Solstice',
] as const;

export const ADJECTIVES = ['Classic', 'Lightweight', 'Insulated', 'Packable', 'Everyday', 'Technical', 'Heritage', 'Merino'] as const;
export const NOUNS = ['Jacket', 'Tee', 'Pullover', 'Boot', 'Kettle', 'Duvet', 'Earbuds', 'Watch', 'Tent', 'Bottle', 'Pannier'] as const;

export const OPTION_AXES = {
	size: ['XS', 'S', 'M', 'L', 'XL'],
	color: ['black', 'navy', 'sand', 'moss', 'rust'],
	material: ['cotton', 'merino', 'nylon'],
} as const;

/** Variants per product. Long-tailed: most products are small, a few are a full grid. */
export const VARIANTS_PER_PRODUCT: readonly (readonly [number, number])[] = [
	[1, 25], [2, 30], [3, 18], [4, 10], [6, 8], [9, 5], [12, 3], [20, 1],
];

/**
 * Cart size. The load generator needs a realistic distribution and the dataset must contain
 * carts matching it. The tail is where the quote's fan-out cost actually shows.
 */
export const CART_SIZE: readonly (readonly [number, number])[] = [
	[1, 22], [2, 24], [3, 18], [4, 12], [5, 8], [7, 7], [10, 5], [15, 3], [25, 1],
];

/** How many of the locations stock a given sku. Not all, so priority resolution does work. */
export const LOCATIONS_PER_SKU: readonly (readonly [number, number])[] = [
	[1, 20], [2, 30], [3, 28], [4, 15], [6, 7],
];
