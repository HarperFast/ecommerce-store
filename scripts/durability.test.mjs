/**
 * WRITE-005's evidence (durability.mjs), on synthetic strace logs: a database that syncs each
 * commit, the reference on Harper 5.3.2, which syncs none, and syncs that do not belong to a write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeDurability, parseStrace } from './durability.mjs';

const T0 = 1_760_000_000_000;
const sec = (ms) => ((T0 + ms) / 1000).toFixed(6);
/** Ten sequential writes, each sent at 10i ms and acknowledged 4 ms later. */
const writes = Array.from({ length: 10 }, (_, i) => ({ sentMs: T0 + i * 10, ackedMs: T0 + i * 10 + 4 }));
const WAL = '12</var/lib/postgresql/data/pg_wal/000000010000000000000001>';

test('a commit synced inside every write holds', () => {
	const log = writes.map((_, i) => `431 ${sec(i * 10 + 2)} fdatasync(${WAL}) = 0 <0.000800>`).join('\n');
	const result = judgeDurability(writes, parseStrace(log));
	assert.equal(result.holds, true);
	assert.match(result.detail[0], /10 sequential acknowledged writes, 10 synced/);
	assert.match(result.detail[2], /10 on \/var\/lib\/postgresql\/data\/pg_wal\//);
});

test('no sync at all fails every write, as on Harper 5.3.2 with RocksDB', () => {
	const result = judgeDurability(writes, parseStrace(''));
	assert.equal(result.holds, false);
	assert.equal(result.unsynced.length, 10);
});

test('a background sync covers only the write it lands in', () => {
	const log = `77 ${sec(31)} fsync(9</data/000123.sst>) = 0 <0.001000>`;
	const result = judgeDurability(writes, parseStrace(log));
	assert.equal(result.holds, false);
	assert.equal(result.unsynced.length, 9);
});

test('a sync must finish before the acknowledgement, and must succeed', () => {
	const late = writes.map((_, i) => `431 ${sec(i * 10 + 3)} fdatasync(${WAL}) = 0 <0.003000>`).join('\n');
	assert.equal(judgeDurability(writes, parseStrace(late)).holds, false, 'finishing 2 ms after the acknowledgement');
	const failed = writes.map((_, i) => `431 ${sec(i * 10 + 2)} fsync(5</dev/null>) = -1 EINVAL (Invalid argument) <0.000010>`).join('\n');
	assert.equal(judgeDurability(writes, parseStrace(failed)).holds, false, 'EINVAL is not a sync');
});

test('a sync interrupted by another thread is joined across its unfinished and resumed lines', () => {
	const log = writes.flatMap((_, i) => [
		`501 ${sec(i * 10 + 1)} fdatasync(${WAL} <unfinished ...>`,
		`502 ${sec(i * 10 + 2)} msync(0xffff0000, 4096, MS_SYNC) = 0 <0.000100>`,
		`501 ${sec(i * 10 + 3)} <... fdatasync resumed>) = 0 <0.002000>`,
	]).join('\n');
	const syncs = parseStrace(log);
	assert.equal(syncs.filter((s) => s.call === 'fdatasync').length, 10);
	assert.equal(syncs.find((s) => s.call === 'fdatasync').path, '/var/lib/postgresql/data/pg_wal/000000010000000000000001');
	assert.equal(judgeDurability(writes, syncs.filter((s) => s.call === 'fdatasync')).holds, true);
});

test('calls outside the sync family are ignored', () => {
	const log = writes.map((_, i) => `9 ${sec(i * 10 + 2)} writev(14</db/transaction_logs/local/1.txnlog>, [{iov_base="x", iov_len=1}], 1) = 1 <0.000020>`).join('\n');
	assert.equal(parseStrace(log).length, 0);
});
