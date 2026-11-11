/**
 * The stored-state contract: on-disk layout, state types, and atomic io.
 *
 *   .pi/night-watch/<slug>/manifest.json          the only stored state
 *   .pi/night-watch/<slug>/verdicts.jsonl         append-only reviewer verdicts
 *   .pi/night-watch/<slug>/advance.lock           single-flight claim
 *   .pi/night-watch/<slug>/rounds/<n>/brief.md    write-ahead round brief
 *   .pi/night-watch/<slug>/rounds/<n>/worker.events.jsonl
 *   .pi/night-watch/<slug>/rounds/<n>/review-<k>-<a>.events.jsonl
 *
 * Round outcomes are decided exactly once and then immutable; everything else
 * is derived from manifest + events + pids.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WatchConfig } from "./config.ts";
import { normalizeConfig } from "./config.ts";

export class WatchError extends Error {}

// --- paths --------------------------------------------------------------------

export const WATCH_DIR = ".pi/night-watch";
export const SLUG_MAX_LEN = 24;
export const SLUG_MIN_LEN = 3;

export const watchRoot = (cwd: string): string => path.join(cwd, WATCH_DIR);
export const taskDir = (cwd: string, slug: string): string => path.join(watchRoot(cwd), slug);
export const manifestPath = (dir: string): string => path.join(dir, "manifest.json");
export const verdictsPath = (dir: string): string => path.join(dir, "verdicts.jsonl");
export const lockPath = (dir: string): string => path.join(dir, "advance.lock");
export const configPath = (cwd: string): string => path.join(watchRoot(cwd), "config.json");
export const roundDir = (dir: string, round: number): string => path.join(dir, "rounds", String(round));
export const briefPath = (dir: string, round: number): string => path.join(roundDir(dir, round), "brief.md");
export const workerEventsPath = (dir: string, round: number): string => path.join(roundDir(dir, round), "worker.events.jsonl");
export const reviewerEventsPath = (dir: string, round: number, k: number, attempt: number): string => path.join(roundDir(dir, round), `review-${k}-${attempt}.events.jsonl`);
export const roundErrPath = (dir: string, round: number, stem: string): string => path.join(roundDir(dir, round), `${stem}.err`);
export const reviewerBriefPath = (dir: string, round: number, k: number, attempt: number): string => path.join(roundDir(dir, round), `review-${k}-${attempt}.brief.md`);

export function slugify(goal: string): string {
	const base = goal
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX_LEN)
		.replace(/-+$/, "");
	return base.length >= SLUG_MIN_LEN ? base : "task";
}

// --- types ----------------------------------------------------------------------

export type TerminalState = "DONE" | "HALT_STAGNANT" | "HALT_BUDGET" | "HALT_ERROR" | "STOPPED";
export type OutcomeWhat = "PASS" | "FAIL" | "CRASHED";

export interface RoundOutcome {
	what: OutcomeWhat;
	/** Failure signature — identical consecutive signatures trip the stagnation halt. */
	sig: string;
	note: string;
}

export interface RoundRec {
	id: number; // 1-based
	headPid: number | null; // timeout-head pid; null until spawned
	headStart: string | null; // `ps -o lstart=` at spawn — PID-reuse guard
	startedAt: string;
	spawnedAt: string | null;
	endedAt: string | null;
	outcome: RoundOutcome | null;
}

export interface Verdict {
	at: string;
	round: number;
	passed: boolean;
	notes: string;
	evidence: string[];
}

export interface Manifest {
	version: 1;
	slug: string;
	goal: string;
	/** Optional rubric the reviewer verifies against; sent to worker and reviewer independently. */
	reviewRubric: string | null;
	config: WatchConfig; // snapshot at start
	criteriaFiles: string[]; // repo-relative; hashed for the tamper guard
	criteriaHash: string; // sha256 at start
	owner: { host: string; startedAt: string };
	rounds: RoundRec[];
	terminal: { state: TerminalState; at: string; note: string } | null;
}

// --- io --------------------------------------------------------------------------

export function readManifest(file: string): Manifest {
	const m = JSON.parse(fs.readFileSync(file, "utf-8")) as Manifest;
	if (m.version !== 1) throw new WatchError(`${file}: unsupported version ${m.version}`);
	// Snapshots as old as the manifest may predate config keys — defaults fill on read so new paths never see undefined.
	m.config = normalizeConfig(m.config, `${file} (config snapshot)`);
	return m;
}

/** Exclusive-create tmp → write → fsync → rename → dir-fsync. The rename is the commit point. */
export function writeAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		fs.writeFileSync(fd, content, "utf-8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, file);
	const dirFd = fs.openSync(path.dirname(file), "r");
	try {
		fs.fsyncSync(dirFd);
	} finally {
		fs.closeSync(dirFd);
	}
}

export const writeManifest = (file: string, m: Manifest): void => writeAtomic(file, JSON.stringify(m, null, "\t") + "\n");

export function readVerdicts(file: string): Verdict[] {
	return readLedger<Verdict>(file);
}

/** Newline-terminated append-only ledger; a torn trailing line is truncation (skipped), anything else throws. */
function readLedger<T>(file: string): T[] {
	if (!fs.existsSync(file)) return [];
	const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l !== "");
	const out: T[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			out.push(JSON.parse(lines[i]) as T);
		} catch (err) {
			if (i === lines.length - 1) continue;
			throw new WatchError(`${file}: corrupt ledger line ${i + 1}: ${(err as Error).message}`);
		}
	}
	return out;
}

export const appendVerdict = (file: string, v: Verdict): void => {
	fs.appendFileSync(file, JSON.stringify(v) + "\n");
};
