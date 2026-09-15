/**
 * Measure scrypt cost so SPEC.md AUTH-002 is pinned to a number we measured rather than a
 * number we copied.
 *
 * Node's crypto.scrypt defaults `maxmem` to 32 MiB and THROWS at OWASP-recommended
 * parameters unless maxmem is passed explicitly — a failure that does not appear until a
 * real login runs. This script makes that visible.
 *
 * Approximate memory per hash is 128 * N * r bytes.
 *
 *   node scripts/measure-kdf.mjs [concurrency]
 *
 * Run it on the TARGET tier (a 1 GB Fabric node), not only a workstation: the parameter
 * choice is a memory-pressure decision, and a laptop will not show the pressure.
 */
import { scrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { cpus, totalmem } from 'node:os';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

// These four are the commonly cited scrypt parameter sets, ordered by memory cost. They are
// intended to be roughly equivalent in work: lowering N is compensated by raising p.
// VERIFY the set against the current OWASP Password Storage Cheat Sheet before the spec
// freezes — do not take these labels as authoritative.
const CANDIDATES = [
	{ label: 'N=2^17 r=8 p=1', N: 2 ** 17, r: 8, p: 1 },
	{ label: 'N=2^16 r=8 p=2', N: 2 ** 16, r: 8, p: 2 },
	{ label: 'N=2^15 r=8 p=3', N: 2 ** 15, r: 8, p: 3 },
	{ label: 'N=2^14 r=8 p=5', N: 2 ** 14, r: 8, p: 5 },
	{ label: 'N=2^13 r=8 p=10', N: 2 ** 13, r: 8, p: 10 },
];

/** Memory a node can give to concurrent hashing before it is in trouble. */
const BUDGET_MIB = Number(process.env.KDF_BUDGET_MIB ?? 512);

const bytesPerHash = ({ N, r }) => 128 * N * r;
const mib = (b) => (b / 1024 / 1024).toFixed(1);

async function timeOne({ N, r, p }, maxmem) {
	const salt = randomBytes(16);
	const t0 = process.hrtime.bigint();
	await scryptAsync('correct horse battery staple', salt, KEYLEN, { N, r, p, maxmem });
	return Number(process.hrtime.bigint() - t0) / 1e6;
}

const concurrency = Number(process.argv[2] ?? 8);

console.log(`node ${process.version} · ${cpus().length} cpus · ${mib(totalmem())} MiB total memory`);
console.log(`concurrency under test: ${concurrency}\n`);
console.log(`hashing memory budget assumed: ${BUDGET_MIB} MiB (KDF_BUDGET_MIB to change)\n`);
console.log('params            mem/hash  default maxmem  serial ms  p95 ms  max concurrent in budget');
console.log('─'.repeat(92));

for (const candidate of CANDIDATES) {
	const need = bytesPerHash(candidate);
	// Reproduce the trap: no explicit maxmem.
	let defaultOk = true;
	try {
		await scryptAsync('x', randomBytes(16), KEYLEN, { N: candidate.N, r: candidate.r, p: candidate.p });
	} catch {
		defaultOk = false;
	}

	const maxmem = need * 2;
	const serial = await timeOne(candidate, maxmem);

	const runs = Array.from({ length: concurrency }, () => timeOne(candidate, maxmem));
	const t0 = process.hrtime.bigint();
	const times = await Promise.all(runs);
	const wall = Number(process.hrtime.bigint() - t0) / 1e6;
	times.sort((a, b) => a - b);
	const p95 = times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)];

	const fits = Math.floor((BUDGET_MIB * 1024 * 1024) / need);
	console.log(
		`${candidate.label.padEnd(16)}${mib(need).padStart(7)}M  ${(defaultOk ? 'ok' : 'THROWS').padStart(14)}  ` +
			`${serial.toFixed(0).padStart(9)}  ${p95.toFixed(0).padStart(6)}  ${String(fits).padStart(24)}`
	);
}

console.log(
	'\nThe deciding column is the last one. Concurrent logins each hold their own scrypt' +
		'\nbuffer simultaneously, so memory per hash — not time per hash — is what caps a small' +
		'\nnode. "THROWS" means Node\'s 32 MiB default maxmem rejects these parameters outright' +
		'\nunless maxmem is passed explicitly.'
);
