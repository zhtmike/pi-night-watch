/**
 * Driver-level checks — free (no models): spawn-failure terminal, the tamper
 * wedge, the lost-spawn-record guard, latest-by-mtime, and liveness guards.
 * The full loop is exercised by observed runs recorded in CHANGELOG.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { advanceTask, latestSlug, startTask } from "../src/driver.ts";
import { manifestPath, taskDir, workerEventsPath } from "../src/manifest.ts";
import { readManifest, writeManifest } from "../src/manifest.ts";
import { check, finish } from "./harness.ts";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nw-driver-"));
fs.writeFileSync(path.join(repo, "spec.txt"), "spec v1\n");
const EXT = "/dev/null"; // no test path ever spawns a worker
fs.mkdirSync(path.join(repo, ".pi", "night-watch"), { recursive: true });
fs.writeFileSync(path.join(repo, ".pi", "night-watch", "config.json"), JSON.stringify({ piBin: "/nonexistent/pi-bin" }));

// HALT_ERROR: a bad binary fails the preflight at spawn time — never a real spawn.
const { slug: s1 } = startTask(repo, "goal one", { criteriaFiles: ["spec.txt"] });
const rep = advanceTask(repo, s1, EXT);
const m1 = readManifest(manifestPath(taskDir(repo, s1)));
check("bad piBin ⇒ HALT_ERROR", m1.terminal?.state === "HALT_ERROR" && rep.lines[0].includes("HALT_ERROR"));

// Tamper wedge: a settled round whose criteria file is then deleted must
// decide FAIL(tamper) → budget terminal, never throw, never wedge.
const { slug: s2 } = startTask(repo, "goal two", { criteriaFiles: ["spec.txt"] });
const dir = taskDir(repo, s2);
const m2 = readManifest(manifestPath(dir));
m2.rounds[0].headPid = 999_999; // dead
m2.rounds[0].headStart = "";
m2.config.maxRounds = 1; // decide → FAIL(tamper) → budget terminal, no spawn needed
m2.config.piBin = "/nonexistent/pi-bin";
writeManifest(manifestPath(dir), m2);
fs.mkdirSync(path.dirname(workerEventsPath(dir, 1)), { recursive: true });
fs.writeFileSync(workerEventsPath(dir, 1), JSON.stringify({ type: "agent_settled" }) + "\n");
fs.rmSync(path.join(repo, "spec.txt"));
advanceTask(repo, s2, EXT);
const m2b = readManifest(manifestPath(dir));
check("deleted criteria file ⇒ FAIL tamper, not a wedge", m2b.rounds[0].outcome?.sig === "tamper" && m2b.terminal?.state === "HALT_BUDGET");

// Lost spawn record: PENDING round with an existing event stream is decided
// CRASHED, never respawned.
const { slug: s3 } = startTask(repo, "goal three", {});
const d3 = taskDir(repo, s3);
fs.mkdirSync(path.dirname(workerEventsPath(d3, 1)), { recursive: true });
fs.writeFileSync(workerEventsPath(d3, 1), JSON.stringify({ type: "session" }) + "\n"); // no settle
const rep3 = advanceTask(repo, s3, EXT);
const m3 = readManifest(manifestPath(d3));
check("PENDING + existing events ⇒ CRASHED, no duplicate spawn", m3.rounds[0].outcome?.what === "CRASHED" && rep3.lines[0].includes("spawn record lost"));

// latestSlug: most recent by mtime, not alphabetically.
const a = startTask(repo, "alpha task", {});
const b = startTask(repo, "beta task", {});
const ut = new Date(Date.now() + 5_000);
fs.utimesSync(manifestPath(taskDir(repo, a.slug)), ut, ut);
check("latest by mtime", latestSlug(repo) === a.slug);
void b; // beta task exists only so alpha is not the lone entry

finish("driver");
