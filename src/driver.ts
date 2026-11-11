/**
 * Host-free orchestration: start/advance/stop/status + the review gate.
 * Composes config/manifest/decision/briefs/events; imports no pi surfaces.
 *
 * Process topology: the worker head is a detached `timeout` —
 * session + process-group leader, so the leash holds even if every night-watch
 * process dies. The reviewer runs `timeout --foreground` inside the worker's
 * group (plain `timeout` self-groups and would escape a group kill).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";
import { parseStartArgs } from "./args.ts";
import type { StartOpts } from "./args.ts";
import { type WatchConfig, normalizeConfig } from "./config.ts";
import { crashOutcome, decideOutcome, roundWaitState, sha256, terminalFromOutcomes, waitRetryDelayMs } from "./decision.ts";
import { reviewerBrief, workerBrief } from "./briefs.ts";
import { parseEvents, validateVerdictArgs } from "./events.ts";
import {
	appendVerdict,
	manifestPath,
	readManifest,
	readVerdicts,
	reviewerBriefPath,
	reviewerEventsPath,
	roundErrPath,
	briefPath,
	configPath,
	lockPath,
	slugify,
	taskDir,
	verdictsPath,
	watchRoot,
	workerEventsPath,
	writeManifest,
	type Manifest,
	type Verdict,
	WatchError,
} from "./manifest.ts";

export { parseStartArgs };
export type { StartOpts };

/** Reviewer attempts per gate call: one, plus one bounded repair retry. */
export const REVIEWER_ATTEMPTS = 2;

// --- child argv ------------------------------------------------------------------------

export interface ChildArgs {
	piBin: string;
	timeoutBin: string;
	extPath: string;
	model?: string;
	thinking?: string;
	deadlineSec: number;
	killGraceSec: number;
	briefPath: string;
	foreground: boolean;
}

export function childArgv(o: ChildArgs): string[] {
	const head = o.foreground ? [o.timeoutBin, "--foreground"] : [o.timeoutBin];
	const tail = [...(o.model ? ["--model", o.model] : []), ...(o.thinking ? ["--thinking", o.thinking] : []), `@${o.briefPath}`];
	return [...head, "-k", String(o.killGraceSec), String(o.deadlineSec), o.piBin, "--mode", "json", "--no-session", "--approve", "-e", o.extPath, ...tail];
}

// --- liveness ----------------------------------------------------------------------------

/** Process start-time per `ps -o lstart=`; empty string means the pid is dead. */
function psLstart(pid: number): string {
	try {
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
}

/** A pid counts as ours only while its start time matches the spawn-time capture (PID-reuse guard). */
function pidAlive(pid: number | null, expectedStart: string | null): boolean {
	if (pid === null) return false;
	const now = psLstart(pid);
	if (now === "") return false;
	if (expectedStart === null || expectedStart === "") return true;
	return now === expectedStart;
}

// --- config / start -------------------------------------------------------------------------

export function readConfig(cwd: string): WatchConfig {
	const p = configPath(cwd);
	if (!fs.existsSync(p)) return normalizeConfig(undefined, p);
	return normalizeConfig(JSON.parse(fs.readFileSync(p, "utf-8")), p);
}

export function startTask(cwd: string, goal: string, opts: { criteriaFiles?: string[]; slug?: string; criteria?: string; reviewRubric?: string }): { dir: string; slug: string } {
	const cfg = readConfig(cwd);
	if (opts.criteria) cfg.criteria = opts.criteria;
	const base = opts.slug ?? slugify(goal);
	let slug = base;
	let dir = taskDir(cwd, slug);
	for (let n = 2; fs.existsSync(manifestPath(dir)); n++) {
		slug = `${base}-${n}`;
		dir = taskDir(cwd, slug);
	}
	const criteriaFiles = opts.criteriaFiles ?? [];
	const m: Manifest = {
		version: 1,
		slug,
		goal,
		reviewRubric: opts.reviewRubric ?? null,
		config: cfg,
		criteriaFiles,
		criteriaHash: hashCriteriaFiles(cwd, criteriaFiles),
		owner: { host: hostname(), startedAt: new Date().toISOString() },
		rounds: [{ id: 1, headPid: null, headStart: null, startedAt: new Date().toISOString(), spawnedAt: null, endedAt: null, outcome: null }],
		terminal: null,
	};
	writeManifest(manifestPath(dir), m);
	return { dir, slug };
}

// --- goal resolution --------------------------------------------------------------------------

/** The goal from inline text or `--goal-file` (contents verbatim, trailing whitespace trimmed). */
export function resolveGoal(cwd: string, opts: { goal?: string; goalFile?: string }): string {
	if (opts.goalFile === undefined) {
		if (!opts.goal) throw new WatchError("no goal given");
		return opts.goal;
	}
	if (opts.goal) throw new WatchError("inline goal and --goal-file are mutually exclusive");
	const p = path.resolve(cwd, opts.goalFile);
	let text: string;
	try {
		text = fs.readFileSync(p, "utf-8");
	} catch (err) {
		throw new WatchError(`--goal-file unreadable: ${p} (${(err as Error).message})`);
	}
	const body = text.trimEnd();
	if (body === "") throw new WatchError(`--goal-file is empty: ${p}`);
	return body;
}

// --- spawning ---------------------------------------------------------------------------------

function spawnHead(argv: string[], env: NodeJS.ProcessEnv, outFile: string, errFile: string, detached: boolean, cwd: string): ChildProcess {
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	const out = fs.openSync(outFile, "a");
	const err = fs.openSync(errFile, "a");
	try {
		return spawn(argv[0], argv.slice(1), { detached, stdio: ["ignore", out, err], env, cwd });
	} finally {
		fs.closeSync(out);
		fs.closeSync(err);
	}
}

/** A bad child binary must HALT_ERROR at spawn — the timeout wrapper would otherwise absorb it as an opaque CRASHED round later. */
function preflight(bin: string, timeoutMs: number, what: string): void {
	const pf = spawnSync(bin, ["--version"], { timeout: timeoutMs });
	if (pf.error || pf.status === 127) throw new WatchSpawnError(`${what} not runnable: ${bin} (${pf.error?.message ?? "exit 127"})`);
}

class WatchSpawnError extends WatchError {}

function spawnWorkerRound(cwd: string, dir: string, m: Manifest, round: number, extPath: string): { headPid: number; headStart: string } {
	preflight(m.config.piBin, m.config.preflightTimeoutMs, "pi binary");
	preflight(m.config.timeoutBin, m.config.preflightTimeoutMs, "timeout binary");
	const brief = workerBrief(m, readVerdicts(verdictsPath(dir)), round, lastRoundText(dir, m, round));
	fs.mkdirSync(path.dirname(briefPath(dir, round)), { recursive: true });
	fs.writeFileSync(briefPath(dir, round), brief);
	const argv = childArgv({
		piBin: m.config.piBin,
		timeoutBin: m.config.timeoutBin,
		extPath,
		model: m.config.workerModel,
		thinking: m.config.workerThinkingLevel,
		deadlineSec: m.config.roundDeadlineMin * 60,
		killGraceSec: m.config.killGraceSec,
		briefPath: briefPath(dir, round),
		foreground: false,
	});
	const child = spawnHead(argv, { ...process.env, NIGHTWATCH_TASK_DIR: dir, NIGHTWATCH_ROUND: String(round) }, workerEventsPath(dir, round), roundErrPath(dir, round, "worker"), true, cwd);
	if (child.pid === undefined) throw new WatchSpawnError("worker head failed to spawn (check worker.err)");
	const headStart = psLstart(child.pid);
	if (headStart === "") {
		// Never record an unmatchable identity — stop now rather than mis-kill later.
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
		throw new WatchSpawnError("worker head died immediately (check worker.err)");
	}
	child.unref();
	return { headPid: child.pid, headStart };
}

function lastRoundText(dir: string, m: Manifest, round: number): string | null {
	if (round <= 1) return null;
	if (!m.rounds.some((r) => r.id === round - 1)) return null;
	try {
		return parseEvents(fs.readFileSync(workerEventsPath(dir, round - 1), "utf-8")).finalAssistantText;
	} catch {
		return null;
	}
}

// --- review gate (runs inside the worker process) -------------------------------------------

/** Spawn a fresh-context reviewer, parse its verdict tool call, append it. Bounded repair retry, then a FAIL verdict. */
export async function runReviewGate(dir: string, round: number, extPath: string): Promise<Verdict> {
	const m = readManifest(manifestPath(dir));
	const verdicts = readVerdicts(verdictsPath(dir));
	const k = verdicts.filter((v) => v.round === round).length + 1;
	let verdict: Verdict | null = null;
	for (let attempt = 0; attempt < REVIEWER_ATTEMPTS && verdict === null; attempt++) {
		const brief = reviewerBrief(m, verdicts, attempt > 0);
		fs.mkdirSync(path.dirname(brief), { recursive: true });
		fs.writeFileSync(reviewerBriefPath(dir, round, k, attempt), brief);
		const argv = childArgv({
			piBin: m.config.piBin,
			timeoutBin: m.config.timeoutBin,
			extPath,
			model: m.config.reviewerModel,
			thinking: m.config.reviewerThinkingLevel,
			deadlineSec: m.config.reviewerDeadlineMin * 60,
			killGraceSec: m.config.killGraceSec,
			briefPath: reviewerBriefPath(dir, round, k, attempt),
			foreground: true,
		});
		const outFile = reviewerEventsPath(dir, round, k, attempt); // one stream per attempt: a torn tail stays a tail
		await new Promise<void>((resolve) => {
			const child = spawnHead(
				argv,
				{ ...process.env, NIGHTWATCH_TASK_DIR: dir, NIGHTWATCH_ROUND: String(round), NIGHTWATCH_REVIEWER: "1" },
				outFile,
				roundErrPath(dir, round, `review-${k}-${attempt}`),
				false, // --foreground keeps the reviewer inside the worker's process group
				process.cwd(), // the worker's cwd is the task workspace
			);
			child.on("exit", () => resolve());
			child.on("error", () => resolve());
		});
		const calls = parseEvents(fs.readFileSync(outFile, "utf-8")).verdictCalls;
		const call = calls[calls.length - 1];
		if (call) {
			const v = validateVerdictArgs(call.args);
			if (!("error" in v)) verdict = { at: new Date().toISOString(), round, passed: v.passed, notes: v.notes, evidence: v.evidence, wait: v.wait ?? null };
		}
	}
	if (verdict === null) {
		verdict = { at: new Date().toISOString(), round, passed: false, notes: "REVIEWER_OUTPUT_UNPARSEABLE: reviewer never called submit_verdict with valid arguments", evidence: [] };
	}
	appendVerdict(verdictsPath(dir), verdict);
	return verdict;
}

// --- criteria / hashes -------------------------------------------------------------------------

/** Lines of shell-command output kept for notes. */
const CRITERIA_TAIL_LINES = 5;

function runShell(cwd: string, cmd: string, timeoutMs: number): { exit: number | null; tail: string } {
	const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf-8", timeout: timeoutMs });
	if (r.error) return { exit: null, tail: `spawn error: ${r.error.message}` };
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd();
	return { exit: r.status, tail: out.split("\n").slice(-CRITERIA_TAIL_LINES).join("\n") };
}

export function runCriteria(cwd: string, cfg: WatchConfig): { exit: number | null; tail: string } {
	if (!cfg.criteria) return { exit: null, tail: "" };
	return runShell(cwd, cfg.criteria, cfg.criteriaTimeoutMs);
}

/** Driver-side wait check; a null exit (spawn error/timeout) counts as a failed check. */
export function runWaitCheck(cwd: string, checkCmd: string, cfg: WatchConfig): { exit: number | null; tail: string } {
	return runShell(cwd, checkCmd, cfg.criteriaTimeoutMs);
}

export function hashCriteriaFiles(cwd: string, files: string[]): string {
	const parts = files.map((f) => `${f}:${sha256(fs.readFileSync(path.join(cwd, f), "utf-8"))}`);
	return sha256(parts.join("|"));
}

/** An unreadable or changed criteria file is tampering's likeliest shape — never a wedge. */
function criteriaTampered(cwd: string, m: Manifest): boolean {
	try {
		const current = m.criteriaFiles.length > 0 ? hashCriteriaFiles(cwd, m.criteriaFiles) : m.criteriaHash;
		return current !== m.criteriaHash;
	} catch {
		return true;
	}
}

// --- single-flight lock -----------------------------------------------------------------------------

function acquireLock(dir: string, cfg: WatchConfig): () => void {
	fs.mkdirSync(dir, { recursive: true });
	const p = lockPath(dir);
	for (let attempt = 0; ; attempt++) {
		try {
			const fd = fs.openSync(p, "wx", 0o600);
			fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), lstart: psLstart(process.pid) }), "utf-8");
			fs.closeSync(fd);
			return () => fs.rmSync(p, { force: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (attempt > 0 || !staleLock(p, cfg)) throw new WatchError("advance is single-flight: another live advance holds the lock");
			const tmp = `${p}.takeover.${process.pid}`;
			try {
				fs.renameSync(p, tmp);
				fs.rmSync(tmp, { force: true });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // lost the takeover race - retry
			}
		}
	}
}

/** Same-host claims go by pid+lstart; foreign hosts fail closed; torn writes need the grace window. */
function staleLock(p: string, cfg: WatchConfig): boolean {
	try {
		const rec = JSON.parse(fs.readFileSync(p, "utf-8")) as { pid?: number; host?: string; lstart?: string };
		if (rec.host === hostname() && typeof rec.pid === "number" && typeof rec.lstart === "string" && rec.lstart !== "") return !pidAlive(rec.pid, rec.lstart);
		if (rec.host !== hostname()) return false;
		return true;
	} catch {
		return Date.now() - fs.statSync(p).mtimeMs > cfg.lockGraceMs;
	}
}

// --- advance -----------------------------------------------------------------------------------------

export interface AdvanceReport {
	slug: string;
	lines: string[];
}

/**
 * The stateless driver step: decide settled rounds, apply terminal rules,
 * spawn the next round with write-ahead intent. Idempotent, single-flight.
 */
export function advanceTask(cwd: string, slug: string, extPath: string): AdvanceReport {
	const dir = taskDir(cwd, slug);
	const m = readManifest(manifestPath(dir));
	const release = acquireLock(dir, m.config);
	try {
		if (m.terminal) return { slug, lines: [`terminal: ${m.terminal.state} — ${m.terminal.note}`] };
		if (m.owner.host !== hostname()) throw new WatchError(`task owned by ${m.owner.host}: fail-closed, hand-delete to retry elsewhere`);

		// 1. Decide every settled-but-undecided round (oldest first).
		let parked: { round: number; cmd: string; next: string; attempts: number } | null = null;
		for (const r of m.rounds) {
			if (r.outcome !== null || r.headPid === null) continue;
			if (pidAlive(r.headPid, r.headStart)) continue;
			const eventsText = safeRead(workerEventsPath(dir, r.id));
			const parsed = eventsText === null ? null : parseEvents(eventsText);
			if (parsed === null || !parsed.settled) {
				r.outcome = crashOutcome();
				r.endedAt = new Date().toISOString();
				writeManifest(manifestPath(dir), m);
				continue;
			}
			const verdicts = readVerdicts(verdictsPath(dir));
			const verdict = [...verdicts].reverse().find((v) => v.round === r.id) ?? null;
			// A last-verdict wait parks the round — it never takes the normal decide path while parked.
			const wait = roundWaitState(r, verdict);
			if (wait !== null) {
				if (Date.now() < Date.parse(wait.nextCheckAt)) {
					parked = { round: r.id, cmd: wait.check_cmd, next: wait.nextCheckAt, attempts: wait.attempts };
					continue;
				}
				if (criteriaTampered(cwd, m)) {
					r.outcome = { what: "FAIL", sig: "tamper", note: "criteria files changed since task start (tamper guard)" };
					r.endedAt = new Date().toISOString();
					writeManifest(manifestPath(dir), m);
					continue;
				}
				const check = runWaitCheck(cwd, wait.check_cmd, m.config);
				if (check.exit === 0) {
					// The wait was a conditional attestation: check exit 0 + criteria (if any) green decides the round PASS outright.
					const criteriaRun = m.config.criteria ? runCriteria(cwd, m.config) : { exit: null as number | null, tail: "" };
					r.outcome =
						m.config.criteria && criteriaRun.exit !== 0
							? { what: "FAIL", sig: "wait-criteria-red", note: `wait satisfied but criteria exited ${criteriaRun.exit}` }
							: { what: "PASS", sig: "wait-ok", note: `wait satisfied; ${m.config.criteria ? "criteria exit 0" : "no criteria configured"}` };
					r.endedAt = new Date().toISOString();
					writeManifest(manifestPath(dir), m);
					continue;
				}
				const attempts = wait.attempts + 1;
				r.waitAttempts = attempts;
				if (attempts >= m.config.waitMaxAttempts) {
					// Retry-in-place never burns worker rounds per poll; only exhaustion decides the round.
					r.outcome = { what: "FAIL", sig: "wait-exhausted", note: `check_cmd failed ${attempts} times` };
					r.endedAt = new Date().toISOString();
					writeManifest(manifestPath(dir), m);
					continue;
				}
				r.waitNextCheckAt = new Date(Date.now() + waitRetryDelayMs(attempts, m.config.waitRetryBaseMs, m.config.waitRetryMaxMs)).toISOString();
				writeManifest(manifestPath(dir), m);
				parked = { round: r.id, cmd: wait.check_cmd, next: r.waitNextCheckAt, attempts };
				continue;
			}
			// A rejected verdict fails the round without burning a criteria run.
			const criteriaRun = verdict !== null && !verdict.passed ? { exit: null, tail: "" } : runCriteria(cwd, m.config);
			const decision = decideOutcome({
				tampered: criteriaTampered(cwd, m),
				verdict,
				criteriaConfigured: Boolean(m.config.criteria),
				criteriaExit: criteriaRun.exit,
			});
			r.outcome = decision ?? { what: "FAIL", sig: "criteria-pending", note: "criteria run never returned" };
			r.endedAt = new Date().toISOString();
			writeManifest(manifestPath(dir), m);
		}

		// 2. Terminal rules over decided outcomes.
		if (m.rounds.every((r) => r.outcome !== null)) {
			const term = terminalFromOutcomes(
				m.rounds.map((r) => r.outcome as NonNullable<typeof r.outcome>),
				m.config.maxRounds,
			);
			if (term) {
				m.terminal = { state: term.state, at: new Date().toISOString(), note: term.note };
				writeManifest(manifestPath(dir), m);
				return { slug, lines: [`terminal: ${term.state} — ${term.note}`] };
			}
		}

		// 3. Any live round is RUNNING.
		const live = m.rounds.find((r) => r.headPid !== null && pidAlive(r.headPid, r.headStart) && r.outcome === null);
		if (live) return { slug, lines: [`round ${live.id} RUNNING (head pid ${live.headPid})`] };

		// 3.5 A parked round holds the watch in WAITING — no spawn, no terminal.
		if (parked) {
			return { slug, lines: [`round ${parked.round} WAITING on \`${parked.cmd}\` — next check ${parked.next} (attempt ${parked.attempts + 1} of ${m.config.waitMaxAttempts})`] };
		}

		// 4. Append the write-ahead PENDING record, then spawn. A PENDING round
		// that already has an event stream was spawned but never recorded —
		// decide it as crashed (inspect its events) instead of spawning a duplicate.
		let next = m.rounds.find((r) => r.headPid === null);
		if (next && safeRead(workerEventsPath(dir, next.id)) !== null) {
			next.outcome = { ...crashOutcome(), note: "spawn record lost; decided from existing event stream" };
			next.endedAt = new Date().toISOString();
			writeManifest(manifestPath(dir), m);
			return { slug, lines: [`round ${next.id} spawn record lost — decided CRASHED from its event stream; advance again to continue`] };
		}
		if (!next) {
			next = { id: m.rounds.length + 1, headPid: null, headStart: null, startedAt: new Date().toISOString(), spawnedAt: null, endedAt: null, outcome: null };
			m.rounds.push(next);
			writeManifest(manifestPath(dir), m);
		}
		try {
			const head = spawnWorkerRound(cwd, dir, m, next.id, extPath);
			next.headPid = head.headPid;
			next.headStart = head.headStart;
			next.spawnedAt = new Date().toISOString();
			writeManifest(manifestPath(dir), m);
			return { slug, lines: [`round ${next.id} SPAWNED (head pid ${head.headPid})`] };
		} catch (err) {
			if (!(err instanceof WatchSpawnError)) throw err;
			m.terminal = { state: "HALT_ERROR", at: new Date().toISOString(), note: `spawn failed: ${(err as Error).message}` };
			writeManifest(manifestPath(dir), m);
			return { slug, lines: [`terminal: HALT_ERROR — ${(err as Error).message}`] };
		}
	} finally {
		release();
	}
}

function safeRead(p: string): string | null {
	try {
		return fs.readFileSync(p, "utf-8");
	} catch {
		return null;
	}
}

// --- stop / status -------------------------------------------------------------------------------------

/** Stop: TERM to head pid + TERM to its group, KILL to the group after the grace window. */
export async function stopTask(cwd: string, slug: string): Promise<string[]> {
	const dir = taskDir(cwd, slug);
	const m = readManifest(manifestPath(dir));
	const release = acquireLock(dir, m.config);
	try {
		if (m.terminal) return [`terminal already: ${m.terminal.state}`];
		const live = [...m.rounds].reverse().find((r) => r.headPid !== null && pidAlive(r.headPid, r.headStart) && r.outcome === null);
		if (!live) {
			// Nothing to kill — but a parked round would otherwise wait forever: record the stop.
			const verdicts = readVerdicts(verdictsPath(dir));
			const parkedRound = m.rounds.find((r) => r.outcome === null && r.headPid !== null && roundWaitState(r, [...verdicts].reverse().find((v) => v.round === r.id) ?? null) !== null);
			if (!parkedRound) return ["no live round"];
			parkedRound.endedAt = new Date().toISOString();
			m.terminal = { state: "STOPPED", at: new Date().toISOString(), note: `stopped by user while round ${parkedRound.id} was WAITING` };
			writeManifest(manifestPath(dir), m);
			return [`round ${parkedRound.id} was WAITING — terminal STOPPED`];
		}
		const pid = live.headPid as number;
		const lines = [`stopping round ${live.id}: TERM head ${pid} + group -${pid}`];
		for (const target of [pid, -pid]) {
			try {
				process.kill(target, "SIGTERM");
			} catch (e) {
				lines.push(`TERM ${target}: ${(e as Error).message}`);
			}
		}
		await new Promise((r) => setTimeout(r, m.config.killGraceSec * 1000));
		try {
			process.kill(-pid, "SIGKILL");
			lines.push("group KILL sent");
		} catch {
			lines.push("group gone before KILL");
		}
		live.endedAt = new Date().toISOString();
		m.terminal = { state: "STOPPED", at: new Date().toISOString(), note: `stopped by user during round ${live.id}` };
		writeManifest(manifestPath(dir), m);
		return lines;
	} finally {
		release();
	}
}

export function statusText(cwd: string, slug: string): string {
	const dir = taskDir(cwd, slug);
	const m = readManifest(manifestPath(dir));
	const verdicts = readVerdicts(verdictsPath(dir));
	const lines = [`watch ${m.slug}: ${m.goal}`, `config: maxRounds=${m.config.maxRounds} deadline=${m.config.roundDeadlineMin}m criteria=${m.config.criteria ?? "(verdict-only)"}`];
	if (m.terminal) lines.push(`TERMINAL: ${m.terminal.state} — ${m.terminal.note}`);
	for (const r of m.rounds) {
		let state: string;
		if (r.outcome) state = `${r.outcome.what} (${r.outcome.note})`;
		else if (r.headPid === null) state = "PENDING";
		else if (pidAlive(r.headPid, r.headStart)) state = `RUNNING pid ${r.headPid}`;
		else {
			const last = [...verdicts].reverse().find((v) => v.round === r.id) ?? null;
			const wait = roundWaitState(r, last);
			state = wait ? `WAITING on \`${wait.check_cmd}\` (attempt ${wait.attempts + 1} of ${m.config.waitMaxAttempts}, next check ${wait.nextCheckAt})` : "dead";
		}
		lines.push(`round ${r.id}: ${state}`);
	}
	for (const v of verdicts) {
		const note = v.notes.split("\n")[0];
		const head = v.passed ? "PASS" : v.wait ? `WAIT (until ${v.wait.due_at} on \`${v.wait.check_cmd}\`)` : "REJECT";
		lines.push(`verdict r${v.round}: ${head} — ${note}`);
	}
	return lines.join("\n");
}

/** Most recent task by manifest mtime (alphabetical order breaks at task-10). */
export function latestSlug(cwd: string): string {
	const root = watchRoot(cwd);
	if (!fs.existsSync(root)) throw new WatchError("no tasks in this workspace (start one first)");
	const entries = fs
		.readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => ({ d: e.name, mtime: fs.statSync(manifestPath(taskDir(cwd, e.name))).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	const last = entries[0];
	if (!last) throw new WatchError("no tasks in this workspace (start one first)");
	return last.d;
}
