/**
 * Pure round-outcome and terminal decisions. Every transition is a function of
 * manifest + verdicts + observations; nothing here touches the filesystem.
 */

import { createHash } from "node:crypto";
import type { RoundOutcome, RoundRec, Verdict } from "./manifest.ts";

/** The last verdict recorded for a round — the park derivation must key on exactly this everywhere. */
export function lastVerdictFor(verdicts: Verdict[], round: number): Verdict | null {
	return [...verdicts].reverse().find((v) => v.round === round) ?? null;
}

/** Characters of criteria output kept in a FAIL note — every model-visible string is bounded. */
export const VERDICT_NOTE_TAIL_MAX = 500;

export interface DecideInput {
	/** criteriaFiles hash changed (or became unreadable) since task start */
	tampered: boolean;
	/** last verdict recorded for this round; null = round never called the gate */
	verdict: Verdict | null;
	criteriaConfigured: boolean;
	/** driver-run criteria exit code; null only while a run is still pending */
	criteriaExit: number | null;
	/** last lines of criteria output, when the driver ran it and it failed */
	criteriaTail?: string;
}

export type DecideResult = { what: "PASS" | "FAIL"; sig: string; note: string } | null;

/**
 * Decide a settled round. Returns null only while a criteria run is pending.
 * Tamper ⇒ FAIL regardless of verdict; no verdict ⇒ FAIL.
 */
export function decideOutcome(input: DecideInput): DecideResult {
	if (input.tampered) return { what: "FAIL", sig: "tamper", note: "criteria files changed since task start (tamper guard)" };
	if (input.verdict === null) return { what: "FAIL", sig: "no-verdict", note: "round settled without calling review_gate" };
	if (!input.verdict.passed) {
		return { what: "FAIL", sig: sha256(firstLine(input.verdict.notes)), note: firstLine(input.verdict.notes) || "reviewer rejected" };
	}
	if (input.criteriaConfigured && input.criteriaExit === null) return null;
	if (input.criteriaConfigured && input.criteriaExit !== 0) {
		const first = input.criteriaTail !== undefined ? firstLine(input.criteriaTail).slice(0, VERDICT_NOTE_TAIL_MAX) : "";
		const why = first !== "" ? ` — ${first}` : "";
		return { what: "FAIL", sig: `criteria-exit-${input.criteriaExit}`, note: `reviewer passed but criteria command exited ${input.criteriaExit}${why}` };
	}
	return { what: "PASS", sig: "pass", note: input.criteriaConfigured ? "reviewer passed; criteria exit 0" : "reviewer passed (verdict-only mode)" };
}

/** Outcome for a spawned round whose head died without settling. */
export function crashOutcome(): RoundOutcome {
	return { what: "CRASHED", sig: "crash", note: "round head died before agent_settled" };
}

export type Terminal = { state: "DONE" | "HALT_STAGNANT" | "HALT_BUDGET"; note: string };

/** First PASS wins; two identical trailing failure signatures halt; budget halts at cap. */
export function terminalFromOutcomes(outcomes: RoundOutcome[], maxRounds: number): Terminal | null {
	const firstPass = outcomes.findIndex((o) => o.what === "PASS");
	if (firstPass >= 0) return { state: "DONE", note: `round ${firstPass + 1} passed` };
	if (outcomes.length >= 2) {
		const a = outcomes[outcomes.length - 2];
		const b = outcomes[outcomes.length - 1];
		if (a.sig === b.sig) return { state: "HALT_STAGNANT", note: `identical failure signature "${a.sig}" in rounds ${outcomes.length - 1} and ${outcomes.length}` };
	}
	if (outcomes.length >= maxRounds) return { state: "HALT_BUDGET", note: `${outcomes.length} rounds exhausted (maxRounds ${maxRounds})` };
	return null;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function firstLine(s: string): string {
	const i = s.indexOf("\n");
	return (i === -1 ? s : s.slice(0, i)).trim();
}

// --- waits --------------------------------------------------------------------------------------

export interface WaitState {
	check_cmd: string;
	/** When the next driver-side check may run: due_at until the first check, the stored retry slot after. */
	nextCheckAt: string;
	/** Nonzero checks so far; the round FAILs as wait-exhausted at config.waitMaxAttempts. */
	attempts: number;
}

/** A settled round parks when its last verdict carries a wait; null otherwise. Pure derivation from the round record + verdict. */
export function roundWaitState(round: RoundRec, lastVerdict: Verdict | null): WaitState | null {
	if (lastVerdict === null || !lastVerdict.wait || lastVerdict.passed) return null;
	return {
		check_cmd: lastVerdict.wait.check_cmd,
		nextCheckAt: round.waitNextCheckAt ?? lastVerdict.wait.due_at,
		attempts: round.waitAttempts ?? 0,
	};
}

/** Delay before wait-check retry n (1-based): base × 2^(n-1), capped. */
export function waitRetryDelayMs(retryN: number, baseMs: number, capMs: number): number {
	if (retryN < 1 || baseMs < 1 || capMs < 1) throw new Error(`waitRetryDelayMs: invalid arguments (${retryN}, ${baseMs}, ${capMs})`);
	return Math.min(baseMs * 2 ** (retryN - 1), capMs);
}
