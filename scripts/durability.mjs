/**
 * WRITE-005's evidence: was each acknowledged write made durable before it was acknowledged?
 *
 * The source of truth's processes are traced with `strace -f -ttt -T -y` for file writes and the
 * sync family while writes go through the write surface ONE AT A TIME, each awaited. Sequential
 * writes cannot share a sync, so group commit, which WRITE-005 permits, cannot hide a missing
 * one. Each write's own interval, from send to acknowledgement, must hold one of:
 *
 *   - a write to a file opened `O_DSYNC` or `O_SYNC`, which is durable when it returns; or
 *   - a write to a file, then a successful `fsync` or `fdatasync` of that same file; or
 *   - a write to a file, then a successful `syncfs` or `sync`; or
 *   - a successful `msync` with `MS_SYNC`, for storage written through a memory map.
 *
 * A sync of a file the interval did not write proves nothing about this write, nor does a
 * background flush. `sync_file_range` and `msync` without `MS_SYNC` are not durability barriers
 * at all: they start writeback, or return before it completes, and flush no device cache.
 *
 * Client times are `Date.now()` milliseconds and strace's are the same wall clock, to the
 * microsecond. A sync may finish up to 1 ms after the recorded acknowledgement, because
 * `Date.now()` truncates; the request's own transit makes the matching slack at the send side
 * harmless.
 */
export const SYNC_CALLS = ['fsync', 'fdatasync', 'sync_file_range', 'sync_file_range2', 'syncfs', 'sync', 'msync'];
export const WRITE_CALLS = ['write', 'writev', 'pwrite64', 'pwritev', 'pwritev2'];
const TRACED = [...SYNC_CALLS, ...WRITE_CALLS];

/** `O_DSYNC`; Linux's `O_SYNC` includes this bit. */
export const O_DSYNC = 0o10000;

const COMPLETE = /^(\d+)\s+(\d+\.\d+)\s+(\w+)\((.*)\)\s+=\s+(-?\d+)(?:\s+\w+\s+\(.*\))?\s+<(\d+\.\d+)>$/;
const UNFINISHED = /^(\d+)\s+(\d+\.\d+)\s+(\w+)\((.*?)\s*<unfinished \.\.\.>$/;
const RESUMED = /^(\d+)\s+(\d+\.\d+)\s+<\.\.\. (\w+) resumed>(.*)\)\s+=\s+(-?\d+)(?:\s+\w+\s+\(.*\))?\s+<(\d+\.\d+)>$/;
/** `-y` prints a descriptor with its path: `12</var/lib/postgresql/data/pg_wal/000000010000000000000001>`. */
const DESCRIPTOR = /^(\d+)<([^>]*)>/;

/** A regular file, not a socket, pipe, device or anonymous inode. */
const isFile = (path) => path?.startsWith('/') && !path.startsWith('/dev/') && !path.startsWith('/proc/');

function call(pid, name, args, startMs, endMs, returned) {
	const descriptor = args.match(DESCRIPTOR);
	return {
		pid: Number(pid),
		call: name,
		fd: descriptor ? Number(descriptor[1]) : null,
		path: descriptor?.[2] ?? null,
		args,
		startMs,
		endMs,
		ok: WRITE_CALLS.includes(name) ? Number(returned) > 0 : returned === '0',
	};
}

/** Traced calls from an `strace -f -ttt -T -y` log, as `{ pid, call, fd, path, args, startMs, endMs, ok }`. */
export function parseStrace(text) {
	const calls = [];
	const pending = new Map();
	for (const line of text.split('\n')) {
		let match;
		if ((match = line.match(COMPLETE))) {
			const [, pid, timestamp, name, args, returned, duration] = match;
			if (!TRACED.includes(name)) continue;
			const startMs = Number(timestamp) * 1000;
			calls.push(call(pid, name, args, startMs, startMs + Number(duration) * 1000, returned));
		} else if ((match = line.match(UNFINISHED))) {
			const [, pid, timestamp, name, args] = match;
			if (TRACED.includes(name)) pending.set(pid, { name, args, startMs: Number(timestamp) * 1000 });
		} else if ((match = line.match(RESUMED))) {
			const [, pid, timestamp, name, , returned] = match;
			const started = pending.get(pid);
			if (!started || started.name !== name) continue;
			pending.delete(pid);
			calls.push(call(pid, name, started.args, started.startMs, Number(timestamp) * 1000, returned));
		}
	}
	return calls;
}

/** Why a successful sync-family call is, or is not, a barrier for writes before it. */
function barrierKind(sync) {
	if (sync.call === 'fsync' || sync.call === 'fdatasync') return 'file';
	if (sync.call === 'syncfs' || sync.call === 'sync') return 'filesystem';
	if (sync.call === 'msync' && /\bMS_SYNC\b/.test(sync.args)) return 'mapped';
	return null;
}

/**
 * Judge sequential writes `{ sentMs, ackedMs }` against the calls traced over them.
 * `durableFds` names the descriptors opened `O_DSYNC` or `O_SYNC`, as `pid:fd:path`.
 * Holds only if every write's own interval carries durability evidence.
 */
export function judgeDurability(writes, calls, durableFds = new Set()) {
	const fileWrites = calls.filter((c) => WRITE_CALLS.includes(c.call) && c.ok && isFile(c.path));
	const syncs = calls.filter((c) => SYNC_CALLS.includes(c.call) && c.ok);
	const within = (c, w) => c.startMs >= w.sentMs && c.endMs <= w.ackedMs + 1;
	const evidence = (w) => {
		const written = fileWrites.filter((c) => within(c, w));
		if (written.some((c) => durableFds.has(`${c.pid}:${c.fd}:${c.path}`))) return 'O_DSYNC write';
		for (const sync of syncs.filter((c) => within(c, w))) {
			const kind = barrierKind(sync);
			const before = written.filter((c) => c.endMs <= sync.startMs);
			if (kind === 'file' && before.some((c) => c.path === sync.path)) return `${sync.call} of the written file`;
			if (kind === 'filesystem' && before.length) return sync.call;
			if (kind === 'mapped') return 'msync MS_SYNC';
		}
		return null;
	};
	const judged = writes.map((w) => ({ ...w, evidence: evidence(w) }));
	const unsynced = judged.filter((w) => !w.evidence);

	const first = writes[0]?.sentMs ?? 0;
	const last = writes.at(-1)?.ackedMs ?? 0;
	const inWindow = (c) => c.startMs >= first && c.endMs <= last + 1;
	const byEvidence = {};
	for (const w of judged) if (w.evidence) byEvidence[w.evidence] = (byEvidence[w.evidence] ?? 0) + 1;
	const ignored = syncs.filter((c) => inWindow(c) && !barrierKind(c)).length;
	const writtenPaths = {};
	for (const c of fileWrites.filter(inWindow)) writtenPaths[c.path] = (writtenPaths[c.path] ?? 0) + 1;
	const detail = [
		`${writes.length} sequential acknowledged writes, ${writes.length - unsynced.length} made durable before acknowledgement${Object.keys(byEvidence).length ? ` (${Object.entries(byEvidence).map(([e, n]) => `${e} ${n}`).join(', ')})` : ''}`,
		`${syncs.filter(inWindow).length} successful sync-family calls in the window${ignored ? `, ${ignored} of them not durability barriers (sync_file_range, msync without MS_SYNC)` : ''}`,
		`file writes in the window:${Object.keys(writtenPaths).length ? '' : ' none'}`,
		...Object.entries(writtenPaths).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path, n]) => `  ${n} to ${path}`),
	];
	return { holds: writes.length > 0 && unsynced.length === 0, unsynced, detail };
}
