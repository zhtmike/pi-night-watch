import type { RoundOutcome, Verdict } from "../src/manifest.ts";
import { crashOutcome, decideOutcome, sha256, terminalFromOutcomes } from "../src/decision.ts";
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
finish("decision");
