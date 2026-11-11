/**
 * Driver-level checks — free (no models): spawn-failure terminal, the tamper
 * wedge, the lost-spawn-record guard, latest-by-mtime, and liveness guards.
 * The full loop is exercised by observed runs recorded in CHANGELOG.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type WatchConfig } from "../src/config.ts";
import { advanceTask, latestSlug, overlayText, resolveGoal, startTask, statusLine, statusText, stopTask } from "../src/driver.ts";
import { manifestPath, taskDir, workerEventsPath, WatchError, appendDecision, appendVerdict, decisionsPath, verdictsPath } from "../src/manifest.ts";
import { readManifest, writeManifest } from "../src/manifest.ts";
import { check, finish } from "./harness.ts";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nw-driver-"));
fs.writeFileSync(path.join(repo, "spec.txt"), "spec v1\n");
const EXT = "/dev/null"; // no test path ever spawns a worker
fs.mkdirSync(path.join(repo, ".pi", "night-watch"), { recursive: true });
fs.writeFileSync(path.join(repo, ".pi", "night-watch", "config.json"), JSON.stringify({ piBin: "/nonexistent/pi-bin" }));

/** A parked round fixture: task started, round 1 settled with a wait verdict, head dead. */
function parkedTask(goal: string, checkCmd: string, dueAt: string, cfgExtra: Record<string, unknown> = {}): { root: string; slug: string } {
	const dir0 = path.join(os.tmpdir(), `nw-wait-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(path.join(dir0, ".pi", "night-watch"), { recursive: true });
	fs.writeFileSync(path.join(dir0, ".pi", "night-watch", "config.json"), JSON.stringify({ piBin: "/nonexistent/pi-bin", pollJitterMs: 1, waitRetryBaseMs: 5_000, waitRetryMaxMs: 6_000, waitMaxAttempts: 2, ...cfgExtra }));
	const { slug } = startTask(dir0, goal, {});
	const dir = taskDir(dir0, slug);
	const m = readManifest(manifestPath(dir));
	m.rounds[0].headPid = 999_999; // dead
	m.rounds[0].headStart = "";
	writeManifest(manifestPath(dir), m);
	fs.mkdirSync(path.dirname(workerEventsPath(dir, 1)), { recursive: true });
	fs.writeFileSync(workerEventsPath(dir, 1), JSON.stringify({ type: "agent_settled" }) + "\n");
	appendVerdict(verdictsPath(dir), { at: new Date().toISOString(), round: 1, passed: false, notes: "CI pending", evidence: ["gh run view → in_progress"], wait: { check_cmd: checkCmd, due_at: dueAt } });
	return { root: dir0, slug };
}

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

// Goal resolution: --goal-file carries verbatim multi-line text; bad inputs fail loudly.
const goalFile = path.join(repo, "prompt.md");
fs.writeFileSync(goalFile, "Since https://example.com/pr/878 is ready,\ndraft the PR for https://example.com/issue/850.\n");
check(
	"goal-file contents verbatim (interior newlines kept, trailing whitespace trimmed)",
	resolveGoal(repo, { goalFile: "prompt.md" }) === "Since https://example.com/pr/878 is ready,\ndraft the PR for https://example.com/issue/850.",
);
check("inline goal passes through", resolveGoal(repo, { goal: "plain goal" }) === "plain goal");
try {
	resolveGoal(repo, { goal: "inline", goalFile: "prompt.md" });
	check("resolveGoal rejects inline + goal-file", false);
} catch (e) {
	check("resolveGoal rejects inline + goal-file", e instanceof WatchError);
}
try {
	resolveGoal(repo, { goalFile: "missing.md" });
	check("unreadable goal-file throws", false);
} catch (e) {
	check("unreadable goal-file throws", e instanceof WatchError);
}
fs.writeFileSync(path.join(repo, "empty.md"), "\n");
try {
	resolveGoal(repo, { goalFile: "empty.md" });
	check("empty goal-file throws", false);
} catch (e) {
	check("empty goal-file throws", e instanceof WatchError);
}

// Goal-file tasks: contents land verbatim in the manifest.
const { slug: gf } = startTask(repo, resolveGoal(repo, { goalFile: "prompt.md" }), {});
const mGf = readManifest(manifestPath(taskDir(repo, gf)));
check("goal from file lands verbatim in manifest", mGf.goal.includes("\n") && mGf.goal.startsWith("Since https://example.com/pr/878"));

// --- wait lifecycle -----------------------------------------------------------------------------

const future = new Date(Date.now() + 3_600_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

// Parked, not due: WAITING reported, nothing decided, nothing spawned.
{
	const { root, slug } = parkedTask("wait not due", "exit 0", future);
	const rep = advanceTask(root, slug, EXT);
	const m = readManifest(manifestPath(taskDir(root, slug)));
	check("not due ⇒ WAITING, no decide, no spawn", rep.lines[0].includes("WAITING") && m.rounds.length === 1 && m.rounds[0].outcome === null && m.terminal === null);
}

// Due + check green (verdict-only): PASS wait-ok → terminal DONE, no confirmation round.
{
	const { root, slug } = parkedTask("wait satisfied", "exit 0", past);
	const rep = advanceTask(root, slug, EXT);
	const m = readManifest(manifestPath(taskDir(root, slug)));
	check("check green ⇒ PASS wait-ok → DONE", m.rounds[0].outcome?.what === "PASS" && m.rounds[0].outcome?.sig === "wait-ok" && m.terminal?.state === "DONE" && rep.lines[0].includes("DONE"));
}

// Due + check green but criteria red: FAIL wait-criteria-red.
{
	const { root, slug } = parkedTask("wait but criteria red", "exit 0", past, { criteria: "exit 7", maxRounds: 1 });
	advanceTask(root, slug, EXT);
	const m = readManifest(manifestPath(taskDir(root, slug)));
	check("check green + criteria red ⇒ FAIL wait-criteria-red", m.rounds[0].outcome?.sig === "wait-criteria-red" && m.rounds[0].outcome?.note.includes("exited 7"));
}

// Due + check nonzero: retry in place — attempts recorded, backoff slot stored, round NOT decided, no respawn.
{
	const { root, slug } = parkedTask("wait retry in place", "exit 3", past);
	const rep = advanceTask(root, slug, EXT);
	const m = readManifest(manifestPath(taskDir(root, slug)));
	check("check failed ⇒ retry parked with backoff", rep.lines[0].includes("WAITING") && m.rounds[0].waitAttempts === 1 && typeof m.rounds[0].waitNextCheckAt === "string" && m.rounds[0].outcome === null && m.rounds.length === 1);
	const again = advanceTask(root, slug, EXT);
	check("backoff window holds the park", again.lines[0].includes("WAITING") && readManifest(manifestPath(taskDir(root, slug))).rounds[0].waitAttempts === 1);
	// Force the retry slot past due: second failure exhausts waitMaxAttempts=2 ⇒ FAIL wait-exhausted, next round write-ahead.
	const dir = taskDir(root, slug);
	const m2 = readManifest(manifestPath(dir));
	m2.rounds[0].waitNextCheckAt = past;
	writeManifest(manifestPath(dir), m2);
	const rep3 = advanceTask(root, slug, EXT);
	const m3 = readManifest(manifestPath(dir));
	check("exhaustion ⇒ FAIL wait-exhausted + next round", m3.rounds[0].outcome?.sig === "wait-exhausted" && m3.rounds[0].outcome?.note === "check_cmd failed 2 times" && m3.rounds.length === 2 && rep3.lines.some((l) => l.includes("HALT_ERROR")));
}

// Tamper while parked: the guard decides before any check runs.
{
	const dir0 = path.join(os.tmpdir(), `nw-tamper-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(path.join(dir0, ".pi", "night-watch"), { recursive: true });
	fs.writeFileSync(path.join(dir0, "spec.txt"), "spec v1\n");
	fs.writeFileSync(path.join(dir0, ".pi", "night-watch", "config.json"), JSON.stringify({ piBin: "/nonexistent/pi-bin", pollJitterMs: 1 }));
	const { slug } = startTask(dir0, "tamper while parked", { criteriaFiles: ["spec.txt"] });
	const dir = taskDir(dir0, slug);
	const m = readManifest(manifestPath(dir));
	m.rounds[0].headPid = 999_999;
	m.rounds[0].headStart = "";
	writeManifest(manifestPath(dir), m);
	fs.mkdirSync(path.dirname(workerEventsPath(dir, 1)), { recursive: true });
	fs.writeFileSync(workerEventsPath(dir, 1), JSON.stringify({ type: "agent_settled" }) + "\n");
	appendVerdict(verdictsPath(dir), { at: new Date().toISOString(), round: 1, passed: false, notes: "CI pending", evidence: [], wait: { check_cmd: "exit 0", due_at: past } });
	fs.rmSync(path.join(dir0, "spec.txt"));
	advanceTask(dir0, slug, EXT);
	check("tamper while parked ⇒ FAIL tamper, check never ran", readManifest(manifestPath(dir)).rounds[0].outcome?.sig === "tamper");
}

// Stopping a WAITING task: nothing to kill, but the park must not outlive the user's stop.
{
	const { root, slug } = parkedTask("stop while parked", "exit 0", future);
	const lines = await stopTask(root, slug);
	const m = readManifest(manifestPath(taskDir(root, slug)));
	check("stop while WAITING ⇒ terminal STOPPED", m.terminal?.state === "STOPPED" && lines[0].includes("WAITING"));
}

// 0.1.0 upgrade path: a manifest whose config snapshot predates the wait keys must
// park and retry on defaults, never throw on the first nonzero check.
{
	const { root, slug } = parkedTask("old snapshot retries on defaults", "exit 3", past);
	const dir = taskDir(root, slug);
	const mOld = readManifest(manifestPath(dir));
	const { pollJitterMs, waitRetryBaseMs, waitRetryMaxMs, waitMaxAttempts, ...snapshot } = mOld.config;
	void pollJitterMs;
	void waitRetryBaseMs;
	void waitRetryMaxMs;
	void waitMaxAttempts;
	mOld.config = snapshot as unknown as WatchConfig;
	writeManifest(manifestPath(dir), mOld);
	const rep = advanceTask(root, slug, EXT);
	const mNew = readManifest(manifestPath(dir));
	check("old snapshot: nonzero check parks on defaults, no throw", rep.lines[0].includes("WAITING") && mNew.rounds[0].waitAttempts === 1 && typeof mNew.rounds[0].waitNextCheckAt === "string");
}

// statusText renders the decision chain (audit after the fact is the point).
{
	const { root, slug } = parkedTask("status decision chain", "exit 0", future);
	const dDir = taskDir(root, slug);
	appendDecision(decisionsPath(dDir), { at: "t", round: 1, question: "fork?\nsecond line", options: ["a", "b"], recommendation: "a", choice: "a", reasoning: "r" });
	appendDecision(decisionsPath(dDir), { at: "t", round: 1, question: "other?", options: ["x", "y"], recommendation: null, choice: null, reasoning: "DECIDER_OUTPUT_UNPARSEABLE: no valid submit_decision call" });
	const st = statusText(root, slug);
	check(
		"status: decision chain with recommendation and unanswered",
		st.includes("decision r1: a — fork? (worker recommended: a)") && st.includes("decision r1: unanswered — other?"),
	);
}

// statusLine: one footer line while live, null at terminal.
{
	const { root, slug } = parkedTask("statusline live", "exit 0", future);
	const line = statusLine(root, slug);
	check("statusLine: WAITING footer with counts", line !== null && line.includes("WAITING") && line.includes("1 verdict") && line.includes("rounds 1/"));
	const dir = taskDir(root, slug);
	const mT = readManifest(manifestPath(dir));
	mT.terminal = { state: "DONE", at: "t", note: "n" };
	writeManifest(manifestPath(dir), mT);
	check("statusLine: null at terminal", statusLine(root, slug) === null);
}

// onEventCmd: fired with slug/state/dir in env by whichever code writes the terminal state.
{
	const { root, slug } = parkedTask("onEventCmd done", "exit 0", past, { onEventCmd: "echo \"$NIGHTWATCH_SLUG $NIGHTWATCH_STATE $(basename \"$NIGHTWATCH_DIR\")\" >> events.log" });
	const rep = advanceTask(root, slug, EXT);
	const log = fs.readFileSync(path.join(root, "events.log"), "utf-8").trim();
	check("onEventCmd: fired on DONE with env", rep.lines.some((l) => l.includes("onEventCmd fired")) && log === `${slug} DONE ${slug}`);
}
{
	const { root, slug } = parkedTask("onEventCmd stopped", "exit 0", future, { onEventCmd: "echo \"$NIGHTWATCH_STATE\" >> events.log" });
	await stopTask(root, slug);
	const log = fs.readFileSync(path.join(root, "events.log"), "utf-8").trim();
	check("onEventCmd: fired on STOPPED", log.includes("STOPPED"));
}
{
	const { root, slug } = parkedTask("onEventCmd failure surfaced", "exit 0", past, { onEventCmd: "exit 3" });
	const rep = advanceTask(root, slug, EXT);
	check("onEventCmd: nonzero exit surfaced, terminal still written", rep.lines.some((l) => l.includes("onEventCmd exited 3")) && rep.lines[0].includes("DONE"));
}

// statusLine settling/decided branches.
{
	const { root, slug } = parkedTask("statusline settling", "exit 0", future);
	const dir = taskDir(root, slug);
	const mS = readManifest(manifestPath(dir));
	mS.rounds[0].headStart = "";
	writeManifest(manifestPath(dir), mS);
	const vFile = verdictsPath(dir);
	const noWait = fs.readFileSync(vFile, "utf-8").trim().split("\n").map((l) => { const v = JSON.parse(l); delete v.wait; return JSON.stringify(v); }).join("\n") + "\n";
	fs.writeFileSync(vFile, noWait);
	check("statusLine: settling when dead head and no wait", statusLine(root, slug)?.includes("settling") === true);
	const mD = readManifest(manifestPath(dir));
	mD.rounds[0].outcome = { what: "FAIL", sig: "x", note: "n" };
	writeManifest(manifestPath(dir), mD);
	check("statusLine: decided (not yet terminal)", statusLine(root, slug)?.includes("decided") === true);
}

// overlayText: status + task-wide usage + live-round tail, zero model tokens.
{
	const { root, slug } = parkedTask("overlay", "exit 0", past);
	const before = overlayText(root, slug);
	check("overlay: verdict chain + usage + tail present", before.includes("verdict r1: WAIT") && before.includes("usage:") && before.includes("Round 1 tail"));
	advanceTask(root, slug, EXT);
	const after = overlayText(root, slug);
	check("overlay: terminal + PASS after advance", after.includes("TERMINAL: DONE") && after.includes("round 1: PASS"));
}

finish("driver");
