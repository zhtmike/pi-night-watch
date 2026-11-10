/**
 * Round briefs. Round 1 carries the goal + rules; later rounds additionally
 * carry the previous outcome, the reviewer's findings, and the dispose rule.
 */

import type { Manifest, Verdict } from "./manifest.ts";

/** Characters of a previous round's report kept in the next brief. */
export const BRIEF_TAIL_CHARS = 2000;

const DISPOSE_RULE = "Dispose of EVERY prior reviewer finding: state for each whether fixed, re-flagged, or retracted with evidence.";

export function workerBrief(m: Manifest, verdicts: Verdict[], round: number, lastRoundText: string | null): string {
	const lines: string[] = [`# Task (round ${round} of ${m.config.maxRounds})`, "", `Goal: ${m.goal}`];
	if (m.config.criteria) lines.push(`Pass criteria (run by the driver, not by you): \`${m.config.criteria}\``);
	if (m.reviewRubric) lines.push(`Reviewer rubric (the bar your work must clear): ${m.reviewRubric}`);
	if (m.criteriaFiles.length > 0) lines.push(`Criteria files (MUST NOT be modified — edits fail the round): ${m.criteriaFiles.join(", ")}`);
	lines.push("");
	if (round === 1) {
		lines.push("Work toward the goal. Inspect actual state before acting; before any external side effect (comment, post, push), check whether it already exists.");
	} else {
		const prev = m.rounds.find((r) => r.id === round - 1);
		const last = [...verdicts].reverse().find((v) => v.round === round - 1) ?? null;
		lines.push(`## Previous round (round ${round - 1})`);
		if (prev?.outcome?.what === "CRASHED") {
			lines.push("The previous round crashed. Its last words follow — verify current state before acting; never assume its work completed.");
			if (lastRoundText) lines.push("", "```", tail(lastRoundText), "```");
		} else if (prev?.outcome) {
			lines.push(`Outcome: ${prev.outcome.what} — ${prev.outcome.note}`);
		}
		if (last) {
			lines.push(`Reviewer verdict: ${last.passed ? "PASSED" : "REJECTED"}`, `Reviewer notes: ${last.notes}`);
			for (const e of last.evidence) lines.push(`- evidence: ${e}`);
			lines.push("", DISPOSE_RULE);
		}
		if (lastRoundText) lines.push("", "Your previous round's final report:", "```", tail(lastRoundText), "```");
	}
	lines.push("", "When you believe the goal is met, call the `review_gate` tool to have an independent reviewer verify. Do not claim completion without it.")
	return lines.join("\n") + "\n";
}

export function reviewerBrief(m: Manifest, verdicts: Verdict[], repair: boolean): string {
	const lines: string[] = ["# Independent review", "", `Goal under review: ${m.goal}`];
	if (m.config.criteria) lines.push(`Stated criteria command: \`${m.config.criteria}\``);
	if (m.reviewRubric) lines.push(`Reviewer rubric (verify against this): ${m.reviewRubric}`);
	if (m.criteriaFiles.length > 0) lines.push(`Criteria files: ${m.criteriaFiles.join(", ")}`);
	const last = verdicts[verdicts.length - 1];
	if (last) lines.push("", `## Prior findings ledger (dispose of each: fixed, re-flagged, or retracted)`, `Previous notes: ${last.notes}`);
	lines.push(
		"",
		"You are a fresh-context reviewer. Decide for yourself how to verify: read the repo, run commands, check state. Do not trust the worker's claims — confirm them. A claim you cannot verify is not evidence.",
		"",
		repair
			? "**Your previous reply did not produce a parseable verdict.** You MUST end by calling the `submit_verdict` tool exactly once."
			: "End by calling the `submit_verdict` tool exactly once with: passed (boolean), notes (≤500 chars), evidence (array of strings, each a command and what it showed).",
	);
	return lines.join("\n") + "\n";
}

const tail = (s: string): string => s.slice(-BRIEF_TAIL_CHARS);
