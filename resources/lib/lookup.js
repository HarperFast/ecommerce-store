/**
 * An in-process memo of a small lookup table — locations, rates — bounded by expiry.
 *
 * Re-reading eight locations and 22 rates on every request would measure dictionary loading,
 * not architecture, so each worker keeps them. But a memo is a derived cache like any other,
 * and CACHE-002 bounds every cached value by FRESH_MS. These tables are written by no
 * application path, yet they are exported and writable over REST and the operations API; an
 * unbounded memo would keep a changed rate or a relocated warehouse until restart. Expiring
 * at half of FRESH_MS bounds it, for a re-read of a few dozen rows twice a second per worker.
 *
 * The memo holds the PROMISE of a load, so requests arriving while it runs share it rather
 * than each scanning; a failed load is dropped so the next request retries.
 */
const LOOKUP_TTL_MS = 500;

export function lookupTable(load) {
	let current = null;
	return function get() {
		const now = Date.now();
		if (!current || now - current.loadedAt > LOOKUP_TTL_MS) {
			const entry = { loadedAt: now, value: null };
			entry.value = load().catch((error) => {
				if (current === entry) current = null;
				throw error;
			});
			current = entry;
		}
		return current.value;
	};
}
