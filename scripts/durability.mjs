/**
 * WRITE-005's evidence: was each acknowledged write made durable before it was acknowledged?
 *
 * The source of truth's processes are traced with `strace -f -ttt -T -y` while writes go
 * through the write surface ONE AT A TIME, each awaited. Sequential writes cannot share a sync,
 * so group commit, which WRITE-005 permits, cannot hide a missing one.
 *
 * A trace cannot tell which file holds a transaction, so the caller names its commit log: a
 * path fragment such as `/pg_wal/` or `/transaction_logs/`. Within each write's own interval,
 * from send to acknowledgement, every log file written must then be made durable after its last
 * write and before the acknowledgement, by one of:
 *
 *   - a successful `fsync` or `fdatasync` of that same file;
 *   - a successful `syncfs` on a log descriptor, or `sync`;
 *   - every write to it going through a descriptor opened `O_DSYNC` or `O_SYNC`.
 *
 * A sync of another file, a background flush, `sync_file_range` (which only starts writeback)
 * and `msync` (which cannot be tied to the log from a trace) are not evidence. An interval with
 * no write to the log, or one whose descriptor flags cannot be established, is inconclusive
 * rather than a failure, and so is the whole run if no interval failed.
 *
 * Client times are `Date.now()` milliseconds and strace's are the same wall clock, to the
 * microsecond. A sync may finish up to 1 ms after the recorded acknowledgement, because
 * `Date.now()` truncates; the request's own transit makes the matching slack at the send side
 * harmless.
 */
export const SYNC_CALLS = ['fsync', 'fdatasync', 'sync_file_range', 'sync_file_range2', 'syncfs', 'sync', 'msync'];
export const WRITE_CALLS = ['write', 'writev', 'pwrite64', 'pwritev', 'pwritev2'];
/** Calls that change what a descriptor refers to, traced so its flags are known at each write. */
export const DESCRIPTOR_CALLS = ['open', 'openat', 'openat2', 'creat', 'close', 'dup', 'dup2', 'dup3', 'fcntl'];
export const TRACED = [...SYNC_CALLS, ...WRITE_CALLS, ...DESCRIPTOR_CALLS];

/** `O_DSYNC`; Linux's `O_SYNC` includes this bit. */
export const O_DSYNC = 0o10000;

// With `-y` a returned descriptor carries its path too: `= 7</var/lib/postgresql/data/pg_wal/…>`.
const RESULT = String.raw`=\s+(-?\d+)(?:<([^>]*)>)?(?:\s+\w+\s+\(.*\))?\s+<(\d+\.\d+)>$`;
const COMPLETE = new RegExp(String.raw`^(\d+)\s+(\d+\.\d+)\s+(\w+)\((.*)\)\s+${RESULT}`);
const UNFINISHED = /^(\d+)\s+(\d+\.\d+)\s+(\w+)\((.*?)\s*<unfinished \.\.\.>$/;
const RESUMED = new RegExp(String.raw`^(\d+)\s+(\d+\.\d+)\s+<\.\.\. (\w+) resumed>(.*)\)\s+${RESULT}`);
/** `-y` prints a descriptor with its path: `12</var/lib/postgresql/data/pg_wal/000000010000000000000001>`. */
const DESCRIPTOR = /^(\d+)<([^>]*)>/;

function traced(tid, name, args, startMs, endMs, returned, returnedPath) {
	const descriptor = args.match(DESCRIPTOR);
	const value = Number(returned);
	return {
		tid: Number(tid),
		call: name,
		fd: descriptor ? Number(descriptor[1]) : null,
		path: descriptor?.[2] ?? null,
		args,
		returned: value,
		returnedPath: returnedPath ?? null,
		startMs,
		endMs,
		ok: WRITE_CALLS.includes(name) ? value > 0 : SYNC_CALLS.includes(name) || name === 'close' ? value === 0 : value >= 0,
	};
}

/** Traced calls from an `strace -f -ttt -T -y` log. */
export function parseStrace(text) {
	const calls = [];
	const pending = new Map();
	for (const line of text.split('\n')) {
		let match;
		if ((match = line.match(COMPLETE))) {
			const [, tid, timestamp, name, args, returned, returnedPath, duration] = match;
			if (!TRACED.includes(name)) continue;
			const startMs = Number(timestamp) * 1000;
			calls.push(traced(tid, name, args, startMs, startMs + Number(duration) * 1000, returned, returnedPath));
		} else if ((match = line.match(UNFINISHED))) {
			const [, tid, timestamp, name, args] = match;
			if (TRACED.includes(name)) pending.set(tid, { name, args, startMs: Number(timestamp) * 1000 });
		} else if ((match = line.match(RESUMED))) {
			const [, tid, timestamp, name, , returned, returnedPath] = match;
			const started = pending.get(tid);
			if (!started || started.name !== name) continue;
			pending.delete(tid);
			calls.push(traced(tid, name, started.args, started.startMs, Number(timestamp) * 1000, returned, returnedPath));
		}
	}
	return calls;
}

/**
 * Whether each write's descriptor was `O_DSYNC` when it ran: `true`, `false`, or `null` when
 * that cannot be established. Starts from `snapshot` (`tgid:fd` → `{ path, dsync }`, read once
 * the tracer was attached, at `snapshotMs`) and replays every later open, dup and close, so a
 * descriptor closed and reopened during the run is judged by the flags it had at each write.
 */
export function descriptorFlags(calls, { tasks, snapshot, snapshotMs }) {
	const table = new Map(snapshot);
	const flags = new Map();
	const tgidOf = (tid) => tasks.get(tid) ?? null;
	const changes = calls.filter((c) => DESCRIPTOR_CALLS.includes(c.call) && c.ok && c.endMs > snapshotMs);
	const writes = calls.filter((c) => WRITE_CALLS.includes(c.call) && c.ok);
	const events = [
		...changes.map((c) => ({ at: c.endMs, change: c })),
		...writes.map((c) => ({ at: c.startMs, write: c })),
	].sort((a, b) => a.at - b.at);
	for (const { change, write } of events) {
		if (write) {
			const tgid = tgidOf(write.tid);
			const entry = tgid === null ? undefined : table.get(`${tgid}:${write.fd}`);
			flags.set(write, entry && entry.path === write.path ? entry.dsync : null);
			continue;
		}
		const tgid = tgidOf(change.tid);
		if (tgid === null) continue;
		if (change.call === 'close') {
			table.delete(`${tgid}:${change.fd}`);
		} else if (change.call === 'fcntl' && !/F_DUPFD/.test(change.args)) {
			// F_SETFL cannot set or clear O_DSYNC on Linux; other commands do not change a descriptor.
		} else if (change.call === 'dup' || change.call === 'dup2' || change.call === 'dup3' || change.call === 'fcntl') {
			const source = table.get(`${tgid}:${change.fd}`);
			table.set(`${tgid}:${change.returned}`, source ? { ...source } : { path: change.returnedPath, dsync: null });
		} else {
			table.set(`${tgid}:${change.returned}`, { path: change.returnedPath, dsync: /\bO_(D)?SYNC\b/.test(change.args) });
		}
	}
	return flags;
}

/**
 * Judge sequential writes `{ sentMs, ackedMs }` against the calls traced over them. `log` is a
 * path fragment naming the commit log; `flags` comes from `descriptorFlags`. The verdict is
 * `holds`, `fails` (some interval wrote the log and did not make it durable) or `inconclusive`.
 */
export function judgeDurability(writes, calls, { log, flags = new Map() }) {
	const inLog = (path) => typeof path === 'string' && path.includes(log);
	const logWrites = calls.filter((c) => WRITE_CALLS.includes(c.call) && c.ok && inLog(c.path));
	const syncs = calls.filter((c) => SYNC_CALLS.includes(c.call) && c.ok);
	const within = (c, w) => c.startMs >= w.sentMs && c.endMs <= w.ackedMs + 1;
	const barrierFor = (sync, path) =>
		((sync.call === 'fsync' || sync.call === 'fdatasync') && sync.path === path) || (sync.call === 'syncfs' && inLog(sync.path)) || sync.call === 'sync';

	const judge = (w) => {
		const written = logWrites.filter((c) => within(c, w));
		if (!written.length) return { result: 'inconclusive', why: 'no write to the log' };
		const results = [...new Set(written.map((c) => c.path))].map((path) => {
			const toPath = written.filter((c) => c.path === path);
			const last = Math.max(...toPath.map((c) => c.endMs));
			const barrier = syncs.find((s) => within(s, w) && s.startMs >= last && barrierFor(s, path));
			if (barrier) return { result: 'holds', why: `${barrier.call} after the log write` };
			const dsync = toPath.map((c) => flags.get(c) ?? null);
			if (dsync.every((d) => d === true)) return { result: 'holds', why: 'O_DSYNC log write' };
			if (dsync.some((d) => d === null)) return { result: 'inconclusive', why: 'descriptor flags unknown' };
			return { result: 'fails', why: 'log written, not synced' };
		});
		return results.find((r) => r.result === 'fails') ?? results.find((r) => r.result === 'inconclusive') ?? results[0];
	};
	const judged = writes.map((w) => ({ ...w, ...judge(w) }));
	const count = (result) => judged.filter((w) => w.result === result).length;
	let verdict = 'holds';
	if (!writes.length || count('inconclusive')) verdict = 'inconclusive';
	if (writes.length && count('fails')) verdict = 'fails';

	const first = writes[0]?.sentMs ?? 0;
	const last = writes.at(-1)?.ackedMs ?? 0;
	const inWindow = (c) => c.startMs >= first && c.endMs <= last + 1;
	const reasons = {};
	for (const w of judged) reasons[w.why] = (reasons[w.why] ?? 0) + 1;
	const logPaths = {};
	for (const c of logWrites.filter(inWindow)) logPaths[c.path] = (logPaths[c.path] ?? 0) + 1;
	const detail = [
		`${writes.length} sequential acknowledged writes: ${count('holds')} durable, ${count('fails')} not, ${count('inconclusive')} inconclusive (${Object.entries(reasons).map(([why, n]) => `${why} ${n}`).join(', ')})`,
		`${syncs.filter(inWindow).length} successful sync-family calls in the window`,
		`writes to the log (paths containing "${log}"):${Object.keys(logPaths).length ? '' : ' none'}`,
		...Object.entries(logPaths).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path, n]) => `  ${n} to ${path}`),
	];
	return { verdict, judged, detail };
}
