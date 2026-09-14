import { withHarper, cacheHandlerPath } from '@harperfast/nextjs';
import type { NextConfig } from 'next';

const config: NextConfig = {
	// The cache handler is Harper-backed: entries live in the `harperfast_nextjs` database
	// rather than the worker filesystem, so a cache write on one node is visible clusterwide.
	// Tag invalidation (`revalidateTag`) is soft — see docs/structure.md and P4.
	cacheHandler: cacheHandlerPath(import.meta.dirname),
};

export default withHarper(config);
