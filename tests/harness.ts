/** Shared check harness — no framework, plain node. */
let failures = 0;
export function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`ok   ${name}`);
	else {
		failures++;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}
export function finish(scope: string) {
	if (failures === 0) {
		console.log(`${scope}: all checks passed`);
		process.exit(0);
	}
	console.error(`${scope}: ${failures} FAILURES`);
	process.exit(1);
}
