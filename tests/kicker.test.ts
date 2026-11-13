/**
 * Kicker bin integration — free: the bin is invoked as a child process against
 * fabricated settled tasks (bad piBin, no agent ever spawns). Scheduling recipes
 * and the billed observed runs live in docs + CHANGELOG prose, not here.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startTask } from "../src/driver.ts";
import { appendVerdict, manifestPath, taskDir, verdictsPath, workerEventsPath, writeManifest, readManifest } from "../src/manifest.ts";
import { check, finish } from "./harness.ts";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "night-watch");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nw-kicker-"));
fs.mkdirSync(path.join(root, ".pi", "night-watch"), { recursive: true });
fs.writeFileSync(path.join(root, ".pi", "night-watch", "config.json"), JSON.stringify({ piBin: "/nonexistent/pi-bin", pollJitterMs: 1 }));

const run = (args: string[], opts: { cwd?: string } = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf-8", timeout: 30_000, ...opts });

// A settled task: round 1 settled, passing verdict, head dead — undecided until an advance.
function settledTask(goal: string): { dir: string; slug: string } {
	const { slug } = startTask(root, goal, {});
	const dir = taskDir(root, slug);
	const m = readManifest(manifestPath(dir));
	m.rounds[0].headPid = 999_999;
	m.rounds[0].headStart = "";
	writeManifest(manifestPath(dir), m);
	fs.mkdirSync(path.dirname(workerEventsPath(dir, 1)), { recursive: true });
	fs.writeFileSync(workerEventsPath(dir, 1), JSON.stringify({ type: "agent_settled" }) + "\n");
	appendVerdict(verdictsPath(dir), { at: new Date().toISOString(), round: 1, passed: true, notes: "done", evidence: [] });
	return { dir, slug };
}

const first = settledTask("kicker advances unattended");

const bad = run([]);
check("no subcommand ⇒ usage, exit 1", bad.status === 1 && bad.stderr.includes("usage"));

const st = run(["status", root, first.slug]);
check("status renders settling round + verdict chain", st.status === 0 && st.stdout.includes("round 1: settling") && st.stdout.includes("verdict r1: PASS"));

const adv = run(["advance", root, first.slug]);
check("advance ⇒ PASS → terminal DONE, no second round", adv.status === 0 && adv.stdout.includes("terminal: DONE") && readManifest(manifestPath(first.dir)).rounds.length === 1);

// The same advance idempotently re-reports (a missed schedule collapses into one catch-up).
const adv2 = run(["advance", root, first.slug]);
check("repeated advance is idempotent", adv2.status === 0 && adv2.stdout === adv.stdout);

// Explicit slug works; slug omission picks latest by mtime.
const other = settledTask("a second task settles too");
fs.utimesSync(manifestPath(other.dir), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
const adv3 = run(["advance", root]);
check("slug defaults to latest by mtime", adv3.status === 0 && adv3.stdout.includes("terminal: DONE") && readManifest(manifestPath(other.dir)).rounds[0].outcome?.what === "PASS" && readManifest(manifestPath(first.dir)).rounds.length === 1);

// An absent task fails loudly.
const missing = run(["status", root, "no-such-task"]);
check("unknown slug ⇒ loud failure, exit 1", missing.status === 1 && missing.stderr.includes("no-such-task"));

// start: the explicit-action entry — argv-tokenized flags, task armed, round 1 spawned under stub heads
// that outlive the spawn-time lstart capture (an instantly-exiting stub races ps against reap).
const startRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nw-start-"));
fs.mkdirSync(path.join(startRoot, ".pi", "night-watch"), { recursive: true });
const stubBin = path.join(startRoot, "stub-head");
fs.writeFileSync(stubBin, "#!/bin/sh\n[ \"$1\" = --version ] && exit 0\nsleep 5\n");
fs.chmodSync(stubBin, 0o755);
fs.writeFileSync(path.join(startRoot, ".pi", "night-watch", "config.json"), JSON.stringify({ piBin: stubBin, timeoutBin: stubBin, pollJitterMs: 1 }));

const noGoal = run(["start"], { cwd: startRoot });
check("start without a goal ⇒ usage, exit 1", noGoal.status === 1 && noGoal.stderr.includes("usage"));

const started = run(["start", "--criteria", "true", "make it green"], { cwd: startRoot });
const armed = started.status === 0 && started.stdout.includes("task make-it-green started") && started.stdout.includes("round 1 SPAWNED");
check("start arms the task and spawns round 1", armed);
const m1 = armed ? readManifest(manifestPath(taskDir(startRoot, "make-it-green"))) : null;
check("start records round 1's head in the manifest", m1 !== null && m1.rounds[0].headPid !== null && m1.rounds[0].outcome === null && m1.rounds[0].spawnedAt !== null);

finish("kicker");
