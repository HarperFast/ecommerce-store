/**
 * WRITE-005's evidence: was each acknowledged write synced before it was acknowledged?
 *
 * The source of truth's processes are traced with `strace -f -ttt -T -y` for the sync family
 * while writes go through the write surface ONE AT A TIME, each awaited. Sequential writes
 * cannot share a sync, so group commit, which WRITE-005 permits, cannot hide a missing one:
 * every write needs a successful sync that started after it was sent and finished before it
 * was acknowledged. A count over the whole window is not enough, since a background flush or
 * a checkpoint can sync once for reasons that have nothing to do with the writes.
 *
 * Client times are `Date.now()` milliseconds and strace's are the same wall clock, to the
 * microsecond. A sync may finish up to 1 ms after the recorded acknowledgement, because
 * `Date.now()` truncates; the request's own transit makes the matching slack at the send
 * side harmless.
 */
export const SYNC_CALLS = ['fsync', 'fdatasync', 'sync_file_range', 'sync_file_range2', 'syncfs', 'sync', 'msync'];

const COMPLETE = /^(\d+)\s+(\d+\.\d+)\s+(\w+)\((.*)\)\s+=\s+(-?\d+)(?:\s+\w+\s+\(.*\))?\s+<(\d+\.\d+)>$/;
const UNFINISHED = /^(\d+)\s+(\d+\.\d+)\s+(\w+)\((.*?)\s*<unfinished \.\.\.>$/;
const RESUMED = /^(\d+)\s+(\d+\.\d+)\s+<\.\.\. (\w+) resumed>(.*)\)\s+=\s+(-?\d+)(?:\s+\w+\s+\(.*\))?\s+<(\d+\.\d+)>$/;
/** `-y` prints a descriptor with its path: `12</var/lib/postgresql/data/pg_wal/000000010000000000000001>`. */
const PATH = /^\d+<([^>]*)>/;

/** Sync calls from an `strace -f -ttt -T -y` log, as `{ pid, call, path, startMs, endMs, ok }`. */
export function parseStrace(text) {
	const syncs = [];
	const pending = new Map();
	for (const line of text.split('\n')) {
		let m;
		if ((m = line.match(COMPLETE))) {
			const [, pid, ts, call, args, ret, dur] = m;
			if (!SYNC_CALLS.includes(call)) continue;
			const startMs = Number(ts) * 1000;
			syncs.push({ pid: Number(pid), call, path: args.match(PATH)?.[1] ?? null, startMs, endMs: startMs + Number(dur) * 1000, ok: ret === '0' });
		} else if ((m = line.match(UNFINISHED))) {
			const [, pid, ts, call, args] = m;
			if (SYNC_CALLS.includes(call)) pending.set(pid, { call, args, startMs: Number(ts) * 1000 });
		} else if ((m = line.match(RESUMED))) {
			const [, pid, ts, call, , ret] = m;
			const started = pending.get(pid);
			if (!started || started.call !== call) continue;
			pending.delete(pid);
			syncs.push({ pid: Number(pid), call, path: started.args.match(PATH)?.[1] ?? null, startMs: started.startMs, endMs: Number(ts) * 1000, ok: ret === '0' });
		}
	}
	return syncs;
}

/**
 * Judge sequential writes `{ sentMs, ackedMs }` against the syncs traced over them.
 * Holds only if every write has a successful sync inside its own interval.
 */
export function judgeDurability(writes, syncs) {
	const good = syncs.filter((s) => s.ok);
	const unsynced = writes.filter((w) => !good.some((s) => s.startMs >= w.sentMs && s.endMs <= w.ackedMs + 1));
	const first = writes[0]?.sentMs ?? 0;
	const last = writes.at(-1)?.ackedMs ?? 0;
	const inWindow = good.filter((s) => s.startMs >= first && s.endMs <= last + 1);
	const byCall = {};
	const byPath = {};
	for (const s of inWindow) {
		byCall[s.call] = (byCall[s.call] ?? 0) + 1;
		if (s.path) byPath[s.path] = (byPath[s.path] ?? 0) + 1;
	}
	const detail = [
		`${writes.length} sequential acknowledged writes, ${writes.length - unsynced.length} synced before acknowledgement`,
		`${inWindow.length} successful sync calls in the window${inWindow.length ? `: ${Object.entries(byCall).map(([c, n]) => `${c} ${n}`).join(', ')}` : ''}`,
		...Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path, n]) => `  ${n} on ${path}`),
	];
	return { holds: writes.length > 0 && unsynced.length === 0, unsynced, detail };
}
