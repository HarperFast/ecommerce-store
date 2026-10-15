/**
 * Readiness probe, run from OUTSIDE the target.
 *
 * Probing with `compose exec <target> node -e fetch(...)` spawned a Node process inside the
 * target's container — charged to the budget under measurement, adding its own startup to the
 * cold-start figure, at one-second resolution. This polls the published port from the host
 * every 25 ms instead and prints the milliseconds from --since (the moment the orchestrator
 * started the target) to the first accepted response.
 *
 *   node containers/wait-ready.mjs --url http://localhost:9926/... [--accept ok|any] [--since <epoch ms>]
 *
 * `--accept ok` (cold start) wants a 2xx: "time to first successful response" in the run
 * lifecycle. `--accept any` (before seeding) wants any HTTP status below 500, because an
 * empty target answers 404.
 */
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const URL_TO_PROBE = argOf('url', 'http://localhost:9926/product/product-000000?tier=standard&region=us-east');
const ACCEPT = argOf('accept', 'ok');
const SINCE = Number(argOf('since', String(Date.now())));
const INTERVAL_MS = Number(argOf('interval', '25'));
const TIMEOUT_MS = Number(argOf('timeout', '600000'));

const accepted = (status) => (ACCEPT === 'any' ? status < 500 : status >= 200 && status < 300);
const deadline = Date.now() + TIMEOUT_MS;
let last = 'no response';

while (Date.now() < deadline) {
	try {
		const response = await fetch(URL_TO_PROBE, { signal: AbortSignal.timeout(2000) });
		await response.arrayBuffer();
		if (accepted(response.status)) {
			console.log(Date.now() - SINCE);
			process.exit(0);
		}
		last = `HTTP ${response.status}`;
	} catch (error) {
		last = error.cause?.code ?? error.name ?? String(error);
	}
	await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
console.error(`target not ready after ${TIMEOUT_MS} ms (last: ${last})`);
process.exit(1);
