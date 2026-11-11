import type { RoundOutcome, RoundRec, Verdict } from "../src/manifest.ts";
import { crashOutcome, decideOutcome, roundWaitState, sha256, terminalFromOutcomes, waitRetryDelayMs } from "../src/decision.ts";
import { check, finish } from "./harness.ts";

const V = (passed: boolean, notes: string): Verdict => ({ at: "t", round: 1, passed, notes, evidence: ["cmd: ok"] });

check("pass with criteria exit 0", decideOutcome({ tampered: false, verdict: V(true, "done"), criteriaConfigured: true, criteriaExit: 0 })?.what === "PASS");
check("pass blocked while criteria pending", decideOutcome({ tampered: false, verdict: V(true, "done"), criteriaConfigured: true, criteriaExit: null }) === null);
check("verdict pass but criteria fails", decideOutcome({ tampered: false, verdict: V(true, "done"), criteriaConfigured: true, criteriaExit: 1 })?.what === "FAIL");
check("verdict-only pass", decideOutcome({ tampered: false, verdict: V(true, "done"), criteriaConfigured: false, criteriaExit: null })?.what === "PASS");
check("rejection sig hashes notes", decideOutcome({ tampered: false, verdict: V(false, "still broken\nmore"), criteriaConfigured: false, criteriaExit: null })?.sig === sha256("still broken"));
check("no verdict fails round", decideOutcome({ tampered: false, verdict: null, criteriaConfigured: false, criteriaExit: null })?.sig === "no-verdict");
check("tamper overrides verdict", decideOutcome({ tampered: true, verdict: V(true, "looks done"), criteriaConfigured: true, criteriaExit: 0 })?.sig === "tamper");

const F = (sig: string): RoundOutcome => ({ what: "FAIL", sig, note: "n" });
const P: RoundOutcome = { what: "PASS", sig: "pass", note: "" };
check("first pass wins", terminalFromOutcomes([F("a"), P, F("b")], 10)?.state === "DONE");
check("two identical sigs halt", terminalFromOutcomes([F("a"), F("x"), F("x")], 10)?.state === "HALT_STAGNANT");
check("distinct sigs continue", terminalFromOutcomes([F("a"), F("b")], 10) === null);
check("crash+crash = identical sig halt", terminalFromOutcomes([crashOutcome(), crashOutcome()], 10)?.state === "HALT_STAGNANT");
check("budget at maxRounds", terminalFromOutcomes([F("a"), F("b"), F("c")], 3)?.state === "HALT_BUDGET");
check("under budget continues", terminalFromOutcomes([F("a"), F("b")], 3) === null);

check("wait retry: base then exponential", waitRetryDelayMs(1, 60_000, 900_000) === 60_000 && waitRetryDelayMs(2, 60_000, 900_000) === 120_000 && waitRetryDelayMs(3, 60_000, 900_000) === 240_000);
check("wait retry: capped", waitRetryDelayMs(9, 60_000, 900_000) === 900_000);
try {
	waitRetryDelayMs(0, 60_000, 900_000);
	check("wait retry: rejects retry < 1", false);
} catch {
	check("wait retry: rejects retry < 1", true);
}

const R = (over: Partial<RoundRec>): RoundRec => ({ id: 2, headPid: 999_999, headStart: "", startedAt: "t", spawnedAt: "t", endedAt: null, outcome: null, ...over });
const W = (due: string): Verdict => ({ at: "t", round: 2, passed: false, notes: "CI pending", evidence: [], wait: { check_cmd: "gh run watch", due_at: due } });
check("wait state: null without a wait verdict", roundWaitState(R({}), null) === null && roundWaitState(R({}), { at: "t", round: 2, passed: false, notes: "n", evidence: [] }) === null);
check("wait state: null on a passing verdict", roundWaitState(R({}), { ...W("t"), passed: true, wait: null }) === null);
check("wait state: due_at before any check", roundWaitState(R({}), W("2026-11-11T12:00:00Z"))?.nextCheckAt === "2026-11-11T12:00:00Z");
check("wait state: stored retry slot wins", roundWaitState(R({ waitAttempts: 2, waitNextCheckAt: "2026-11-12T00:00:00Z" }), W("2026-11-11T12:00:00Z"))?.nextCheckAt === "2026-11-12T00:00:00Z" && roundWaitState(R({ waitAttempts: 2 }), W("d"))?.attempts === 2);
finish("decision");
