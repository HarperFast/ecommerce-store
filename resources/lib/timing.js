/**
 * Per-wave Server-Timing entries, for diagnostics: where a request's `data` phase goes when its
 * reads overlap. On only with SERVER_TIMING_WAVES=1. Off, a wave is its bare read plus one check,
 * so a measured run executes the same reads in the same order.
 *
 * Each entry times one wave from the moment its reads are issued to the moment they all settle.
 * Overlapping waves overlap in time, so the entries do not sum to `data`; the dependency chain
 * through them does. Names never contain `cache`, `data`, `compute` or `total`, which the
 * conformance suite and the harness match by substring.
 */
export const WAVE_TIMING = process.env.SERVER_TIMING_WAVES === '1';

/** A request's wave entries, or `null` when wave timing is off. */
export function waveRecorder() {
	return WAVE_TIMING ? [] : null;
}

/** Issue one wave's reads; `describe` turns its result into the entry's `desc`, without `,` or `;`. */
export function wave(waves, name, issue, describe) {
	if (!waves) return issue();
	const started = performance.now();
	return Promise.resolve(issue()).then((value) => {
		const desc = describe ? `;desc="${describe(value)}"` : '';
		waves.push(`${name};dur=${(performance.now() - started).toFixed(2)}${desc}`);
		return value;
	});
}

/** The entries to append after a request's own Server-Timing metrics. */
export function waveEntries(waves) {
	return waves?.length ? `, ${waves.join(', ')}` : '';
}
