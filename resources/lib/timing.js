/**
 * Per-wave Server-Timing entries, for diagnostics: on only with SERVER_TIMING_WAVES=1. Callers
 * issue each read themselves and pass it in, so off, a wave costs one call and one check and
 * allocates nothing: a measured run executes the same reads, in the same order, with no extra
 * awaits.
 *
 * Each wave is timed from issue to settle. Overlapping waves overlap, so the entries do not sum
 * to `data`. Names never contain `cache`, `data`, `compute` or `total`, which the conformance
 * suite and the harness match by substring.
 */
export const WAVE_TIMING = process.env.SERVER_TIMING_WAVES === '1';

export function waveRecorder() {
	return WAVE_TIMING ? [] : null;
}

/** Evaluate before the wave's reads are issued. */
export function waveStart(waves) {
	return waves ? performance.now() : 0;
}

export function settled(waves, name, started, read, describe) {
	if (!waves) return read;
	return Promise.resolve(read).then((value) => {
		record(waves, name, started, value, describe);
		return value;
	});
}

export function record(waves, name, started, value, describe) {
	if (!waves) return;
	const desc = describe ? `;desc="${describe(value)}"` : '';
	waves.push(`${name};dur=${(performance.now() - started).toFixed(2)}${desc}`);
}

export function waveEntries(waves) {
	return waves?.length ? `, ${waves.join(', ')}` : '';
}

export const countReads = (rows) => `reads=${rows.length}`;
export const countNestedReads = (rows) => `reads=${rows.reduce((sum, inner) => sum + inner.length, 0)}`;
export const countRows = (rows) => `rows=${rows.length}`;
export const countCandidates = (rows) => `candidates=${rows.length}`;
