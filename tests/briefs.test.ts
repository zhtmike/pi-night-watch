import type { Decision, Manifest, Verdict } from "../src/manifest.ts";
import { DEFAULT_WATCH_CONFIG } from "../src/config.ts";
import { crashOutcome } from "../src/decision.ts";
import { DECISIONS_IN_BRIEF_MAX, decisionBrief, reviewerBrief, workerBrief } from "../src/briefs.ts";
import { check, finish } from "./harness.ts";

const cfg = { ...DEFAULT_WATCH_CONFIG };
const mk = (rounds: Manifest["rounds"]): Manifest => ({ version: 1, slug: "t", goal: "g", reviewRubric: null, config: cfg, criteriaFiles: [], criteriaHash: "", owner: { host: "h", startedAt: "t" }, rounds, terminal: null });
const m1 = mk([{ id: 1, headPid: null, headStart: null, startedAt: "t", spawnedAt: null, endedAt: null, outcome: null }]);
const mR = { ...m1, reviewRubric: "no + operator in src" };
const rej: Verdict = { at: "t", round: 1, passed: false, notes: "healthcheck 502", evidence: ["curl → 502"] };

check("round 1: state only — goal, no teaching prose", (() => { const b = workerBrief(m1, [], 1, null); return b.includes("Goal: g") && !b.includes("review_gate") && !b.includes("re-flagged") && !b.includes("Never") && !b.includes("Work toward"); })());
const b2 = workerBrief(mk([{ id: 1, headPid: 1, headStart: "s", startedAt: "t", spawnedAt: "t", endedAt: "t", outcome: { what: "FAIL", sig: "x", note: "service on :8080 still 502" } }, { id: 2, headPid: null, headStart: null, startedAt: "t", spawnedAt: null, endedAt: null, outcome: null }]), [rej], 2, "prev report text");
check("round 2: outcome + verdict state + prior report", b2.includes("service on :8080 still 502") && b2.includes("Reviewer verdict: REJECTED") && b2.includes("curl → 502") && b2.includes("prev report text"));
const b3 = workerBrief(mk([{ id: 1, headPid: 1, headStart: "s", startedAt: "t", spawnedAt: "t", endedAt: "t", outcome: crashOutcome() }, { id: 2, headPid: null, headStart: null, startedAt: "t", spawnedAt: null, endedAt: null, outcome: null }]), [], 2, "i was mid-edit when i died");
check("crash round: last words carried as state", b3.includes("round crashed") && b3.includes("i was mid-edit when i died"));
const waitV: Verdict = { at: "t", round: 1, passed: false, notes: "CI pending", evidence: [] , wait: { check_cmd: "gh run watch", due_at: "t2" } };
const b4 = workerBrief(mk([{ id: 1, headPid: 1, headStart: "s", startedAt: "t", spawnedAt: "t", endedAt: "t", outcome: { what: "FAIL", sig: "wait-exhausted", note: "check_cmd failed 2 times" }, waitAttempts: 2 }, { id: 2, headPid: null, headStart: null, startedAt: "t", spawnedAt: null, endedAt: null, outcome: null }]), [waitV], 2, null);
check("wait-exhausted: park state + decision stated", b4.includes("parked waiting on `gh run watch`; the check failed 2 times") && b4.includes("fresh due_at, or change course"));
check("wait verdict state in round brief", workerBrief(mk([{ id: 1, headPid: 1, headStart: "s", startedAt: "t", spawnedAt: "t", endedAt: "t", outcome: null }, { id: 2, headPid: null, headStart: null, startedAt: "t", spawnedAt: null, endedAt: null, outcome: null }]), [waitV], 2, null).includes("WAITING (until t2 on `gh run watch`)"));
check("reviewer: goal + repair contract, no lecture", (() => { const b = reviewerBrief(m1, [], false); return b.includes("Goal under review: g") && !b.includes("fresh-context") && !b.includes("Do not trust") && !b.includes("End by calling"); })());
check("reviewer: repair demands the call", reviewerBrief(m1, [], true).includes("MUST end by calling"));
check("reviewer: prior findings state included", reviewerBrief(m1, [rej], false).includes("healthcheck 502"));
check("rubric: worker sees the bar", workerBrief(mR, [], 1, null).includes("the bar your work must clear): no + operator in src"));
check("rubric: reviewer verifies against it", reviewerBrief(mR, [], false).includes("verify against this): no + operator in src"));
check("rubric: omitted when null", !workerBrief(m1, [], 1, null).includes("rubric") && !reviewerBrief(m1, [], false).includes("rubric"));

const dec = (round: number, choice: string | null): Decision => ({ at: "t", round, question: `fork ${round}`, options: ["a", "b"], recommendation: "a", choice, reasoning: "r" });
const m2r = mk([{ id: 1, headPid: 1, headStart: "s", startedAt: "t", spawnedAt: "t", endedAt: "t", outcome: { what: "FAIL", sig: "x", note: "n" } }, { id: 2, headPid: null, headStart: null, startedAt: "t", spawnedAt: null, endedAt: null, outcome: null }]);
check("worker brief: previous round's decisions as state", (() => { const b = workerBrief(m2r, [], 2, null, [dec(1, "a"), dec(1, null), dec(2, "b")]); return b.includes("decision r1: a — fork 1") && b.includes("decision r1: unanswered — fork 1") && !b.includes("fork 2"); })());
check("worker brief: no decision lines when none exist", !workerBrief(m2r, [], 2, null, []).includes("decision r"));
const ask = { question: "Tabs or spaces?", options: ["tabs", "spaces"], recommendation: "tabs" };
check("decision brief: goal + question + options + recommendation state", (() => { const b = decisionBrief(m1, [], ask, false); return b.includes("Goal under review: g") && b.includes("Tabs or spaces?") && b.includes("- tabs") && b.includes("Worker recommendation: tabs") && !b.includes("You are"); })());
check("decision brief: prior decisions tail-capped", (() => { const many = Array.from({ length: DECISIONS_IN_BRIEF_MAX + 3 }, (_, i) => dec(i + 1, "a")); const b = decisionBrief(m1, many, ask, false); return b.includes(`fork ${DECISIONS_IN_BRIEF_MAX + 3}`) && !b.includes("fork 1\n") && b.split("decision r").length - 1 === DECISIONS_IN_BRIEF_MAX; })());
check("decision brief: repair demands the call", decisionBrief(m1, [], ask, true).includes("MUST end by calling the `submit_decision` tool"));
const mCrit = { ...m1, config: { ...cfg, criteria: "npm test" } };
check("decision brief: criteria command included", decisionBrief(mCrit, [], ask, false).includes("Stated criteria command: `npm test`"));
finish("briefs");
