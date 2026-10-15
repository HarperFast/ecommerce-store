/**
 * DATA-004's memory evidence: did the target's working set exceed the memory it had?
 *
 * A working set larger than memory shows as a cgroup pressed against its own limit that keeps
 * reading from disk. Pressed alone is not enough: a cgroup can fill with heap or with a cache of
 * everything it will ever read, and then read nothing. Reading alone is not enough either: a
 * target with memory to spare still reads what it has not yet cached.
 *
 * Each target cgroup is judged against its OWN limit, so the rule does not depend on how a
 * target divides its budget. Summing peaks against the whole budget failed a separated stack
 * whose database was pinned at its 1,280 MiB while its application and cache sat below theirs:
 * the sum stayed under 90% of 2 GiB however hard the database was paging. When a cgroup has no
 * limit of its own, or a target has several, the summed peaks are also judged against the
 * budget the orchestrator recorded. The evidence holds when any judged basis is:
 *
 *   - pressed: its memory.peak (page cache included) reached PRESSED_SHARE of the limit, and
 *   - still reading: in every measured step its cgroups read at least MIN_READ_BYTES from disk,
 *     or refaulted page cache they had evicted.
 *
 * The verifier prints the basis that met it, or every basis it judged when none did.
 */
export const PRESSED_SHARE = 0.9;
export const MIN_READ_BYTES = 2 ** 20;

const mib = (bytes) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

export function memoryPressure({ conditions, steps }) {
	const components = steps.at(-1)?.targetComponents ?? [];
	if (!components.length || components.some((c) => c.memoryPeakSinceStartBytes == null)) {
		return { holds: false, basis: null, detail: [], reason: 'the record carries no memory peak for every target cgroup' };
	}
	const stillReading = (names) =>
		steps.length > 0 &&
		steps.every((step) => {
			const measured = (step.targetComponents ?? []).filter((c) => names.includes(c.name));
			const read = measured.reduce((sum, c) => sum + (c.diskReadBytes ?? 0), 0);
			const refaults = measured.reduce((sum, c) => sum + (c.pageCacheRefaults ?? 0), 0);
			return measured.length === names.length && (read >= MIN_READ_BYTES || refaults > 0);
		});

	const bases = components
		.filter((c) => c.memoryMaxBytes > 0)
		.map((c) => ({ basis: `per cgroup: ${c.name} against its own ${mib(c.memoryMaxBytes)} limit`, peak: c.memoryPeakSinceStartBytes, limit: c.memoryMaxBytes, names: [c.name] }));
	const budget = conditions.orchestrator?.target?.applied?.memoryBytes;
	if (budget > 0 && (components.length > 1 || !(components[0].memoryMaxBytes > 0))) {
		bases.push({
			basis: `summed: ${components.map((c) => c.name).join(' + ')} against the ${mib(budget)} budget`,
			peak: components.reduce((sum, c) => sum + c.memoryPeakSinceStartBytes, 0),
			limit: budget,
			names: components.map((c) => c.name),
		});
	}
	const judged = bases.map((b) => ({ ...b, share: b.peak / b.limit, reading: stillReading(b.names) }));
	const detail = judged.map(
		(j) => `${j.basis}: peak ${mib(j.peak)} (${(j.share * 100).toFixed(0)}%), ${j.reading ? 'reading from disk in every step' : 'not reading from disk in every step'}`
	);
	const met = judged.find((j) => j.share >= PRESSED_SHARE && j.reading);
	if (met) return { holds: true, basis: met.basis, detail };
	return {
		holds: false,
		basis: null,
		detail,
		reason: judged.length
			? `no target cgroup reached ${PRESSED_SHARE * 100}% of its limit while still reading from disk in every step; the working set fit in memory`
			: 'no target cgroup has a memory limit of its own, and the record gives no budget to judge against',
	};
}
