/**
 * Kicker bin integration — free: the bin is invoked as a child process against
 * fabricated WAITING tasks (bad piBin, no agent ever spawns). Scheduling recipes
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

const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf-8", timeout: 30_000 });

// A parked task: round 1 settled, wait verdict due in the future.
const future = new Date(Date.now() + 3_600_000).toISOString();
const { slug } = startTask(root, "kicker waits unattended", {});
const dir = taskDir(root, slug);
const m = readManifest(manifestPath(dir));
m.rounds[0].headPid = 999_999;
m.rounds[0].headStart = "";
writeManifest(manifestPath(dir), m);
fs.mkdirSync(path.dirname(workerEventsPath(dir, 1)), { recursive: true });
fs.writeFileSync(workerEventsPath(dir, 1), JSON.stringify({ type: "agent_settled" }) + "\n");
appendVerdict(verdictsPath(dir), { at: new Date().toISOString(), round: 1, passed: false, notes: "CI pending", evidence: [], wait: { check_cmd: "exit 0", due_at: future } });

const bad = run([]);
check("no subcommand ⇒ usage, exit 1", bad.status === 1 && bad.stderr.includes("usage"));

const st = run(["status", root, slug]);
check("status renders WAITING state", st.status === 0 && st.stdout.includes("WAITING") && st.stdout.includes(`round 1: WAITING on \`exit 0\``));

const adv = run(["advance", root, slug]);
check("advance before due ⇒ WAITING, spawns nothing", adv.status === 0 && adv.stdout.includes("WAITING") && readManifest(manifestPath(dir)).rounds.length === 1);

// The same advance idempotently re-reports (a missed schedule collapses into one catch-up).
const adv2 = run(["advance", root, slug]);
check("repeated advance is idempotent WAITING", adv2.status === 0 && adv2.stdout === adv.stdout);

// Explicit slug works; slug omission picks latest by mtime.
const { slug: other } = startTask(root, "a second task parks too", {});
const dirOther = taskDir(root, other);
const m2 = readManifest(manifestPath(dirOther));
m2.rounds[0].headPid = 999_999;
m2.rounds[0].headStart = "";
writeManifest(manifestPath(dirOther), m2);
fs.mkdirSync(path.dirname(workerEventsPath(dirOther, 1)), { recursive: true });
fs.writeFileSync(workerEventsPath(dirOther, 1), JSON.stringify({ type: "agent_settled" }) + "\n");
appendVerdict(verdictsPath(dirOther), { at: new Date().toISOString(), round: 1, passed: false, notes: "deploy pending", evidence: [], wait: { check_cmd: "exit 0", due_at: future } });
fs.utimesSync(manifestPath(dirOther), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
const adv3 = run(["advance", root]);
check("slug defaults to latest by mtime", adv3.status === 0 && adv3.stdout.includes("deploy pending") === false && readManifest(manifestPath(dirOther)).rounds[0].outcome === null);

// An absent task fails loudly.
const missing = run(["status", root, "no-such-task"]);
check("unknown slug ⇒ loud failure, exit 1", missing.status === 1 && missing.stderr.includes("no-such-task"));

finish("kicker");
