/**
 * Driver-level checks — free (no models): spawn-failure terminal, the tamper
 * wedge, the lost-spawn-record guard, latest-by-mtime, and liveness guards.
 * The full loop is exercised by observed runs recorded in CHANGELOG.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { advanceTask, latestSlug, overlayText, resolveGoal, runShell, startTask, statusLine, statusText, stopTask } from "../src/driver.ts";
import { manifestPath, taskDir, workerEventsPath, WatchError, appendVerdict, verdictsPath } from "../src/manifest.ts";
import { readManifest, writeManifest } from "../src/manifest.ts";
import { check, finish } from "./harness.ts";
import { sha256 } from "../src/decision.ts";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nw-driver-"));
fs.writeFileSync(path.join(repo, "spec.txt"), "spec v1\n");
const EXT = "/dev/null"; // no test path ever spawns a worker
fs.mkdirSync(path.join(repo, ".pi", "night-watch"), { recursive: true });
fs.writeFileSync(path.join(repo, ".pi", "night-watch", "config.json"), JSON.stringify({ piBin: "/nonexistent/pi-bin" }));

/** A settled-task fixture: round 1 settled with the given verdict, head dead, undecided until an advance. */
function settledTask(goal: string, verdict: { passed: boolean; notes: string; evidence?: string[] }, cfgExtra: Record<string, unknown> = {}): { root: string; slug: string } {
	const root = path.join(os.tmpdir(), `nw-settled-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(path.join(root, ".pi", "night-watch"), { recursive: true });
	fs.writeFileSync(path.join(root, ".pi", "night-watch", "config.json"), JSON.stringify({ piBin: "/nonexistent/pi-bin", pollJitterMs: 1, ...cfgExtra }));
	const { slug } = startTask(root, goal, {});
	const dir = taskDir(root, slug);
	const m = readManifest(manifestPath(dir));
	m.rounds[0].headPid = 999_999; // dead
	m.rounds[0].headStart = "";
	writeManifest(manifestPath(dir), m);
	fs.mkdirSync(path.dirname(workerEventsPath(dir, 1)), { recursive: true });
	fs.writeFileSync(workerEventsPath(dir, 1), JSON.stringify({ type: "agent_settled" }) + "\n");
	appendVerdict(verdictsPath(dir), { at: new Date().toISOString(), round: 1, passed: verdict.passed, notes: verdict.notes, evidence: verdict.evidence ?? [] });
	return { root, slug };
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
const rep3b = advanceTask(repo, s3, EXT);
const m3b = readManifest(manifestPath(d3));
check("guard does not re-fire: next advance moves on to round 2", m3b.rounds[0].outcome?.what === "CRASHED" && m3b.rounds.length === 2 && rep3b.lines.some((l) => l.includes("SPAWNED") || l.includes("HALT_ERROR")));

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

// --- decide path over settled rounds ----------------------------------------------------------------------

// Rejected verdict ⇒ FAIL with the hashed-notes signature; budget terminal, no spawn.
{
	const { root, slug } = settledTask("rejected round", { passed: false, notes: "still broken\nmore" }, { maxRounds: 1 });
	const rep = advanceTask(root, slug, EXT);
	const m = readManifest(manifestPath(taskDir(root, slug)));
	check("rejected verdict ⇒ FAIL with hashed sig", m.rounds[0].outcome?.what === "FAIL" && m.rounds[0].outcome?.sig === sha256("still broken") && m.terminal?.state === "HALT_BUDGET" && rep.lines[0].includes("HALT_BUDGET"));
}

// Passing verdict, verdict-only mode ⇒ PASS → terminal DONE, no confirmation round.
{
	const { root, slug } = settledTask("passed round", { passed: true, notes: "done" });
	const rep = advanceTask(root, slug, EXT);
	const m = readManifest(manifestPath(taskDir(root, slug)));
	check("passing verdict (verdict-only) ⇒ PASS → DONE", m.rounds[0].outcome?.what === "PASS" && m.terminal?.state === "DONE" && m.rounds.length === 1 && rep.lines[0].includes("DONE"));
}

// Passing verdict but criteria red ⇒ FAIL criteria-exit with the output tail in the note.
{
	const { root, slug } = settledTask("criteria red", { passed: true, notes: "looks done" }, { criteria: "echo 'AssertionError: expected 3 to be 4' >&2; exit 7", maxRounds: 1 });
	advanceTask(root, slug, EXT);
	const m = readManifest(manifestPath(taskDir(root, slug)));
	check("pass + criteria red ⇒ FAIL with tail in note", m.rounds[0].outcome?.sig === "criteria-exit-7" && m.rounds[0].outcome?.note.includes("exited 7") && m.rounds[0].outcome?.note.includes("AssertionError"));
}

// statusText renders the verdict chain (audit after the fact is the point).
{
	const { root, slug } = settledTask("status verdict chain", { passed: false, notes: "healthcheck 502\nsecond line", evidence: ["curl → 502"] });
	const st = statusText(root, slug);
	check("status: round settling + verdict chain", st.includes("round 1: settling") && st.includes("verdict r1: REJECT — healthcheck 502"));
}

// statusLine: one footer line while live, null at terminal.
{
	const { root, slug } = settledTask("statusline live", { passed: false, notes: "n" });
	const line = statusLine(root, slug);
	check("statusLine: settling footer with counts", line !== null && line.includes("settling") && line.includes("1 verdict") && line.includes("rounds 1/"));
	const dir = taskDir(root, slug);
	const mT = readManifest(manifestPath(dir));
	mT.terminal = { state: "DONE", at: "t", note: "n" };
	writeManifest(manifestPath(dir), mT);
	check("statusLine: null at terminal", statusLine(root, slug) === null);
}

// statusLine decided branch.
{
	const { root, slug } = settledTask("statusline decided", { passed: true, notes: "n" });
	const dir = taskDir(root, slug);
	const mD = readManifest(manifestPath(dir));
	mD.rounds[0].outcome = { what: "FAIL", sig: "x", note: "n" };
	writeManifest(manifestPath(dir), mD);
	check("statusLine: decided (not yet terminal)", statusLine(root, slug)?.includes("decided") === true);
}

// overlayText: status + task-wide usage + live-round tail, zero model tokens.
{
	const { root, slug } = settledTask("overlay", { passed: true, notes: "done" });
	const before = overlayText(root, slug);
	check("overlay: verdict chain + usage + tail present", before.includes("verdict r1: PASS") && before.includes("usage:") && before.includes("Round 1 tail"));
	advanceTask(root, slug, EXT);
	const after = overlayText(root, slug);
	check("overlay: terminal + PASS after advance", after.includes("TERMINAL: DONE") && after.includes("round 1: PASS"));
}

// Durable stop: in the round-transition window (nothing live, not terminal)
// a stop must still be recorded — the next kicker advance must not spawn against it.
{
	const dir0 = path.join(os.tmpdir(), `nw-stopwin-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(path.join(dir0, ".pi", "night-watch"), { recursive: true });
	fs.writeFileSync(path.join(dir0, ".pi", "night-watch", "config.json"), JSON.stringify({ piBin: "/nonexistent/pi-bin", pollJitterMs: 1 }));
	const { slug } = startTask(dir0, "stop in window", {});
	const dir = taskDir(dir0, slug);
	const mW = readManifest(manifestPath(dir));
	mW.rounds[0].headPid = 999_999; // dead, settled stream, verdict pass, no criteria: decided only on next advance
	mW.rounds[0].headStart = "";
	writeManifest(manifestPath(dir), mW);
	fs.mkdirSync(path.dirname(workerEventsPath(dir, 1)), { recursive: true });
	fs.writeFileSync(workerEventsPath(dir, 1), JSON.stringify({ type: "agent_settled" }) + "\n");
	appendVerdict(verdictsPath(dir), { at: new Date().toISOString(), round: 1, passed: true, notes: "done", evidence: [] });
	const lines = await stopTask(dir0, slug);
	const mS = readManifest(manifestPath(dir));
	check("stop in transition window ⇒ terminal STOPPED", mS.terminal?.state === "STOPPED" && lines.some((l) => l.includes("terminal: STOPPED")));
	const after = advanceTask(dir0, slug, EXT);
	check("advance after window-stop ⇒ terminal, no spawn", after.lines[0].includes("terminal: STOPPED") && readManifest(manifestPath(dir)).rounds.length === 1);
}

// runShell under the timeout leash: descendant trees die with the group; timeout exits nonzero.
{
	const t0 = Date.now();
	const cfg = readManifest(manifestPath(taskDir(repo, s1))).config;
	const r = runShell(repo, "sleep 5", { ...cfg, criteriaTimeoutMs: 700, killGraceSec: 1 });
	const elapsed = Date.now() - t0;
	check("runShell: timeout kills the tree fast, nonzero exit", r.exit !== 0 && r.exit !== null && elapsed < 4_000);
}

finish("driver");
