/**
 * Target CPU and memory accounting from cgroup v2, read from the generator.
 *
 * The generator runs in its own container and cannot see the target's processes. Every
 * container is a cgroup, though, and the generator shares a kernel with the target on both
 * tiers, so with the host's cgroup tree mounted read-only it can read the target's
 * `cpu.stat` at each step boundary. That accounts every process of the target — Harper's
 * workers, or a separated stack's framework, database and cache, one cgroup each — with
 * nothing running inside the budget being measured.
 *
 * A target is named by container id (its scope is found by searching the tree, which covers
 * Podman's `libpod-<id>.scope` and Docker's `docker-<id>.scope` under any parent) or by a
 * cgroup path relative to the root (a whole slice on the tier-2 host).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CGROUP_ROOT = process.env.CGROUP_ROOT ?? '/host-cgroup';

async function findScope(root, id, depth = 0) {
	if (depth > 6) return null;
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return null;
	}
	// `libpod-<id>.scope` or `docker-<id>.scope` (systemd driver), or a bare `<id>` directory
	// (cgroupfs driver) — not Podman's `libpod-conmon-<id>.scope`, which holds only the
	// container monitor and ends in the same id.
	const isContainerScope = (name) => name === id || (name.endsWith(`-${id}.scope`) && !name.includes('-conmon-'));
	for (const entry of entries) {
		if (entry.isDirectory() && isContainerScope(entry.name)) return join(root, entry.name);
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = await findScope(join(root, entry.name), id, depth + 1);
		if (found) return found;
	}
	return null;
}

/**
 * Resolve `name=idOrPath` specs to cgroup directories. Unresolvable specs are reported, not
 * dropped. A spec nested inside another is refused: its CPU is already in its parent's.
 */
export async function resolveCgroups(specs) {
	const resolved = [];
	for (const spec of specs) {
		const [name, ref] = spec.includes('=') ? spec.split('=', 2) : [spec, spec];
		const dir = ref.startsWith('/') ? join(CGROUP_ROOT, ref) : await findScope(CGROUP_ROOT, ref);
		let readable = false;
		if (dir) {
			try {
				await readFile(join(dir, 'cpu.stat'), 'utf8');
				readable = true;
			} catch {}
		}
		resolved.push({ name, ref, dir: readable ? dir : null });
	}
	for (const inner of resolved) {
		const outer = resolved.find((other) => other !== inner && other.dir && inner.dir?.startsWith(`${other.dir}/`));
		if (outer) throw new Error(`target cgroup ${inner.name} is inside ${outer.name}; it would be counted twice`);
	}
	return resolved;
}

const readNumber = async (path) => {
	try {
		const value = Number((await readFile(path, 'utf8')).trim());
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
};

/** One reading of a cgroup: cumulative CPU counters plus current memory. */
export async function readCgroup(dir) {
	if (!dir) return null;
	const stat = {};
	try {
		for (const line of (await readFile(join(dir, 'cpu.stat'), 'utf8')).split('\n')) {
			const [key, value] = line.split(' ');
			if (key) stat[key] = Number(value);
		}
	} catch {
		return null;
	}
	return {
		atEpochMs: Date.now(),
		usageUsec: stat.usage_usec ?? null,
		userUsec: stat.user_usec ?? null,
		systemUsec: stat.system_usec ?? null,
		nrThrottled: stat.nr_throttled ?? null,
		throttledUsec: stat.throttled_usec ?? null,
		memoryCurrent: await readNumber(join(dir, 'memory.current')),
		memoryPeak: await readNumber(join(dir, 'memory.peak')),
	};
}

export async function readAll(cgroups) {
	return Promise.all(cgroups.map((cgroup) => readCgroup(cgroup.dir)));
}

/**
 * Per-cgroup deltas between two readings, and their sum. A missing reading makes the whole
 * figure null rather than a partial sum that would undercount the target.
 */
export function accountStep(cgroups, before, after) {
	// A counter that went backwards was reset — the cgroup was recreated mid-step — and a field
	// the kernel did not report (no cpu controller on a slice) is unknown, not zero.
	const delta = (a, b, scale = 1) => (a === null || b === null || b < a ? null : (b - a) / scale);
	const components = cgroups.map((cgroup, i) => {
		const a = before[i];
		const b = after[i];
		const cpuSeconds = a && b ? delta(a.usageUsec, b.usageUsec, 1e6) : null;
		if (cpuSeconds === null) return { name: cgroup.name, cpuSeconds: null };
		return {
			name: cgroup.name,
			cpuSeconds,
			userSeconds: delta(a.userUsec, b.userUsec, 1e6),
			systemSeconds: delta(a.systemUsec, b.systemUsec, 1e6),
			throttledPeriods: delta(a.nrThrottled, b.nrThrottled),
			throttledSeconds: delta(a.throttledUsec, b.throttledUsec, 1e6),
			memoryCurrentBytes: b.memoryCurrent,
			// memory.peak is the cgroup's high-water mark since it was created, not this step's.
			memoryPeakSinceStartBytes: b.memoryPeak,
		};
	});
	const complete = components.length > 0 && components.every((c) => c.cpuSeconds !== null);
	return {
		targetCpuSeconds: complete ? components.reduce((sum, c) => sum + c.cpuSeconds, 0) : null,
		targetComponents: components,
	};
}
