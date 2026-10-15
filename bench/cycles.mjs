/**
 * Join tier-2 cycle samples to a run record's steps: gigacycles, effective frequency, and ops
 * per gigacycle for every step.
 *
 * On the tier-2 host the clock cannot be pinned, so it is bounded (ALL_CORE_MAX) and measured:
 * `sample.sh` (application-architecture-benchmarks, environments/gcp) runs for the whole session
 *
 *   perf stat -a -x, -I 250 -e cycles,instructions,task-clock --for-each-cgroup <slices> -o perf.csv
 *
 * and writes the epoch it started perf at to perf.start-epoch-ms. Each perf row is one 250 ms
 * interval's count for one cgroup, stamped with the interval's END in seconds since perf started.
 * A step is the wall-clock window the record gives it, offer start to drain end, the same window
 * as its cgroup CPU figure. Intervals inside the window count whole; the two cut by its edges
 * count in proportion to their overlap, which assumes even load within 250 ms.
 *
 *   ops per gigacycle = successful reads in the step ÷ (target cycles in the step ÷ 10⁹)
 *   effective GHz     = target cycles ÷ target task-clock (CPU time on any of its CPUs)
 *
 * Limits, stated in the record: perf.start-epoch-ms is taken just before perf starts counting,
 * so every interval sits a few milliseconds later than stamped; and proration inside an interval
 * is linear. At 60 s steps both are well under 1% of a step.
 *
 *   node bench/cycles.mjs --samples <dir> [--target <cgroup,...>] [--generator <cgroup,...>]
 *                         [--wait-ms 10000] [--write] <run-record.json>
 *
 * Without --write it prints the join; with it, it adds `cycles` to every step and to
 * `conditions`, and rewrites the record. A group is a cgroup path as perf prints it, or a CPU
 * (`CPU2`) for per-CPU output such as the clock probe's.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TARGET_CGROUP = 'bench.slice/bench-target.slice';
export const GENERATOR_CGROUP = 'bench.slice/bench-generator.slice';
/** A step whose window the samples do not cover to this share has no cycle figure. */
const MIN_COVERAGE = 0.999;

const EVENT = /^(cycles|instructions|task-clock|cpu-clock)\b/;

/**
 * perf stat's CSV (-x,) with -I: `time,[CPUn,]value,unit,event,[cgroup,]run,pct,metric,unit`.
 * Rows are { t: interval end in ms since perf started, group, event, value }; comments, blank
 * lines, and uncounted values are skipped.
 */
export function parsePerfCsv(text) {
	const rows = [];
	for (const line of text.split('\n')) {
		if (!line.trim() || line.startsWith('#')) continue;
		const fields = line.split(',').map((field) => field.trim());
		const at = fields.findIndex((field, i) => i > 1 && EVENT.test(field));
		if (at < 0) continue;
		const value = Number(fields[at - 2]);
		if (!Number.isFinite(value)) continue; // <not counted>, <not supported>
		const event = fields[at].match(EVENT)[1] === 'cpu-clock' ? 'task-clock' : fields[at].match(EVENT)[1];
		const group = /^CPU\d+$/.test(fields[1]) ? fields[1] : fields[at + 1];
		rows.push({ t: Number(fields[0]) * 1000, group, event, value });
	}
	return rows;
}

/** Per event, the summed intervals of the given groups: [{ start, end, value }] in ms since perf start. */
function intervals(rows, groups) {
	const wanted = new Set(groups);
	const byEvent = new Map();
	for (const row of rows) {
		if (!wanted.has(row.group)) continue;
		if (!byEvent.has(row.event)) byEvent.set(row.event, new Map());
		const byTime = byEvent.get(row.event);
		byTime.set(row.t, (byTime.get(row.t) ?? 0) + row.value);
	}
	const out = new Map();
	for (const [event, byTime] of byEvent) {
		const times = [...byTime.keys()].sort((a, b) => a - b);
		out.set(event, times.map((end, i) => ({ start: i ? times[i - 1] : 0, end, value: byTime.get(end) })));
	}
	return out;
}

/** The share of each interval inside [from, to], summed; and how much of [from, to] they cover. */
function over(series, from, to) {
	let value = 0;
	let covered = 0;
	for (const { start, end, value: v } of series ?? []) {
		const overlap = Math.min(end, to) - Math.max(start, from);
		if (overlap <= 0 || end <= start) continue;
		value += (v * overlap) / (end - start);
		covered += overlap;
	}
	return { value, coverage: to > from ? covered / (to - from) : 0 };
}

function figures(series, from, to) {
	const cycles = over(series.get('cycles'), from, to);
	if (!series.get('cycles')?.length || cycles.coverage < MIN_COVERAGE) return { coverage: cycles.coverage };
	const taskClockMs = over(series.get('task-clock'), from, to).value;
	const instructions = series.get('instructions') ? over(series.get('instructions'), from, to).value : null;
	return {
		coverage: cycles.coverage,
		gigacycles: cycles.value / 1e9,
		cpuSeconds: taskClockMs / 1000,
		effectiveGHz: taskClockMs > 0 ? cycles.value / (taskClockMs * 1e6) : null,
		ipc: instructions !== null && cycles.value > 0 ? instructions / cycles.value : null,
	};
}

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * The join itself, pure: per-step figures for every step of `record`, and a summary.
 * `target` and `generator` are lists of groups.
 */
export function joinCycles(record, { rows, perfStartEpochMs, target = [TARGET_CGROUP], generator = [GENERATOR_CGROUP] }) {
	const targetSeries = intervals(rows, target);
	const generatorSeries = intervals(rows, generator);
	const steps = record.steps.map((step) => {
		const from = step.startedAtEpochMs - perfStartEpochMs;
		const to = step.drainEndEpochMs - perfStartEpochMs;
		if (!Number.isFinite(from) || !Number.isFinite(to)) return { label: step.label, cycles: null, reason: 'the step has no wall-clock boundaries' };
		const t = figures(targetSeries, from, to);
		if (t.gigacycles === undefined) {
			return { label: step.label, cycles: null, reason: `the samples cover ${(t.coverage * 100).toFixed(1)}% of the step` };
		}
		const g = generatorSeries.size ? figures(generatorSeries, from, to) : null;
		return {
			label: step.label,
			cycles: {
				window: 'offer start to drain end',
				coverage: t.coverage,
				target: { gigacycles: t.gigacycles, cpuSeconds: t.cpuSeconds, effectiveGHz: t.effectiveGHz, ipc: t.ipc },
				generator: g && g.gigacycles !== undefined ? { gigacycles: g.gigacycles, cpuSeconds: g.cpuSeconds, effectiveGHz: g.effectiveGHz } : null,
				opsPerGigacycle: t.gigacycles > 0 ? step.ok / t.gigacycles : null,
				// perf's CPU time against the cgroup's own, over the same window: near 1 when both
				// saw the same work.
				cpuAgreement: step.targetCpuSeconds > 0 ? t.cpuSeconds / step.targetCpuSeconds : null,
			},
		};
	});
	const ghz = steps.map((s) => s.cycles?.target.effectiveGHz).filter((v) => Number.isFinite(v));
	const intervalMs = median([...(targetSeries.get('cycles') ?? [])].map((i) => i.end - i.start));
	const mid = ghz.length ? median(ghz) : null;
	return {
		steps,
		summary: {
			source: 'sample.sh perf.csv: perf stat -a -x, -I <interval> -e cycles,instructions,task-clock --for-each-cgroup',
			perfStartEpochMs,
			intervalMs: Number.isFinite(intervalMs) ? intervalMs : null,
			target,
			generator,
			ops: 'successful reads in the step (step.ok)',
			effectiveGHz: mid === null ? null : { median: mid, min: Math.min(...ghz), max: Math.max(...ghz), spreadPct: ((Math.max(...ghz) - Math.min(...ghz)) / mid) * 100 },
			limits: 'intervals cut by a step edge are prorated linearly; perf.start-epoch-ms precedes perf counting by its setup time',
		},
	};
}

/** Read sample.sh output, waiting up to waitMs for perf to have written past `untilEpochMs`. */
export async function readSamples(dir, { untilEpochMs = 0, waitMs = 0 } = {}) {
	const perfStartEpochMs = Number((await readFile(join(dir, 'perf.start-epoch-ms'), 'utf8')).trim());
	const deadline = Date.now() + waitMs;
	for (;;) {
		const rows = parsePerfCsv(await readFile(join(dir, 'perf.csv'), 'utf8'));
		const last = rows.reduce((max, row) => Math.max(max, row.t), 0);
		if (perfStartEpochMs + last >= untilEpochMs || Date.now() >= deadline) return { rows, perfStartEpochMs };
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const argOf = (name, fallback) => {
		const i = args.indexOf(`--${name}`);
		return i === -1 ? fallback : args[i + 1];
	};
	const valued = new Set(['--samples', '--target', '--generator', '--wait-ms']);
	const file = args.find((arg, i) => !arg.startsWith('--') && !valued.has(args[i - 1]));
	const dir = argOf('samples', null);
	if (!file || !dir) {
		console.error('usage: node bench/cycles.mjs --samples <dir> [--target <cgroup,...>] [--generator <cgroup,...>] [--wait-ms ms] [--write] <run-record.json>');
		process.exit(2);
	}
	const record = JSON.parse(await readFile(file, 'utf8'));
	const target = argOf('target', TARGET_CGROUP).split(',');
	const generator = argOf('generator', GENERATOR_CGROUP).split(',');
	// One interval past the last drain end, so the interval holding it has been written.
	const untilEpochMs = Math.max(...record.steps.map((s) => s.drainEndEpochMs ?? 0)) + 500;
	const samples = await readSamples(dir, { untilEpochMs, waitMs: Number(argOf('wait-ms', '10000')) });
	const { steps, summary } = joinCycles(record, { ...samples, target, generator });

	console.log('step        target Gcycles   GHz     IPC    ops/Gcycle   generator Gcycles   perf/cgroup CPU');
	for (const { label, cycles, reason } of steps) {
		if (!cycles) {
			console.log(`${String(label).padEnd(10)}  no cycles: ${reason}`);
			continue;
		}
		const { target: t, generator: g } = cycles;
		console.log(
			`${String(label).padEnd(10)}  ${t.gigacycles.toFixed(2).padStart(14)}  ${t.effectiveGHz?.toFixed(3).padStart(6) ?? '   n/a'}  ${t.ipc?.toFixed(2).padStart(5) ?? '  n/a'}  ` +
				`${cycles.opsPerGigacycle?.toFixed(1).padStart(10) ?? '       n/a'}  ${g ? g.gigacycles.toFixed(2).padStart(18) : '               n/a'}  ${cycles.cpuAgreement?.toFixed(3).padStart(15) ?? '            n/a'}`
		);
	}
	if (summary.effectiveGHz) {
		const { median: m, min, max, spreadPct } = summary.effectiveGHz;
		console.log(`effective GHz: median ${m.toFixed(3)}, ${min.toFixed(3)}–${max.toFixed(3)} (${spreadPct.toFixed(2)}% spread)`);
	}
	if (args.includes('--write')) {
		steps.forEach(({ cycles }, i) => (record.steps[i].cycles = cycles));
		record.conditions.cycles = { ...summary, samples: dir, joinedAt: new Date().toISOString() };
		await writeFile(file, JSON.stringify(record, null, 2));
		console.log(`joined into ${file}`);
	}
	if (steps.some((s) => !s.cycles)) process.exitCode = 1;
}
