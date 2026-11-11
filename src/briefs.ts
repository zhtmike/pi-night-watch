/**
 * Round briefs: pure state sheets — goal, round, outcomes, findings, wait
 * bookkeeping. No methodology prose: working style and instructions ride the
 * goal text (which reaches both roles verbatim) and the tool descriptions.
 */

import type { Manifest, Verdict } from "./manifest.ts";

/** Characters of a previous round's report kept in the next brief. */
export const BRIEF_TAIL_CHARS = 2000;

export function workerBrief(m: Manifest, verdicts: Verdict[], round: number, lastRoundText: string | null): string {
	const lines: string[] = [`# Task (round ${round} of ${m.config.maxRounds})`, "", `Goal: ${m.goal}`];
	if (m.config.criteria) lines.push(`Pass criteria (run by the driver, not by you): \`${m.config.criteria}\``);
	if (m.reviewRubric) lines.push(`Reviewer rubric (the bar your work must clear): ${m.reviewRubric}`);
	if (m.criteriaFiles.length > 0) lines.push(`Criteria files (MUST NOT be modified — edits fail the round): ${m.criteriaFiles.join(", ")}`);
	lines.push("");
	if (round > 1) {
		const prev = m.rounds.find((r) => r.id === round - 1);
		const last = [...verdicts].reverse().find((v) => v.round === round - 1) ?? null;
		lines.push(`## Previous round (round ${round - 1})`);
		if (prev?.outcome?.what === "CRASHED") {
			lines.push("The previous round crashed. Its last words follow:");
			if (lastRoundText) lines.push("", "```", tail(lastRoundText), "```");
		} else {
			if (prev?.outcome) lines.push(`Outcome: ${prev.outcome.what} — ${prev.outcome.note}`);
			if (prev?.outcome?.sig === "wait-exhausted" && last?.wait) {
				lines.push(
					`Round ${round - 1} parked waiting on \`${last.wait.check_cmd}\`; the check failed ${prev.waitAttempts ?? "?"} times. Re-inspect and decide: keep waiting with a fresh due_at, or change course.`,
				);
			}
		}
		if (last) {
			lines.push(`Reviewer verdict: ${last.passed ? "PASSED" : last.wait ? `WAITING (until ${last.wait.due_at} on \`${last.wait.check_cmd}\`)` : "REJECTED"}`, `Reviewer notes: ${last.notes}`);
			for (const e of last.evidence) lines.push(`- evidence: ${e}`);
		}
		if (lastRoundText) lines.push("", "Your previous round's final report:", "```", tail(lastRoundText), "```");
	}
	return lines.join("\n") + "\n";
}

export function reviewerBrief(m: Manifest, verdicts: Verdict[], repair: boolean): string {
	const lines: string[] = ["# Independent review", "", `Goal under review: ${m.goal}`];
	if (m.config.criteria) lines.push(`Stated criteria command: \`${m.config.criteria}\``);
	if (m.reviewRubric) lines.push(`Reviewer rubric (verify against this): ${m.reviewRubric}`);
	if (m.criteriaFiles.length > 0) lines.push(`Criteria files: ${m.criteriaFiles.join(", ")}`);
	const last = verdicts[verdicts.length - 1];
	if (last) lines.push("", `## Prior findings`, `Previous notes: ${last.notes}`);
	if (repair) lines.push("", "**Your previous reply did not produce a parseable verdict.** You MUST end by calling the `submit_verdict` tool exactly once.");
	return lines.join("\n") + "\n";
}

const tail = (s: string): string => s.slice(-BRIEF_TAIL_CHARS);
