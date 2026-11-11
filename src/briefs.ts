/**
 * Round briefs: pure state sheets — goal, round, outcomes, findings, wait
 * bookkeeping. No methodology prose: working style and instructions ride the
 * goal text (which reaches both roles verbatim) and the tool descriptions.
 */

import type { Decision, Manifest, Verdict } from "./manifest.ts";
import { firstLine } from "./decision.ts";

/** Characters of a previous round's report kept in the next brief. */
export const BRIEF_TAIL_CHARS = 2000;

/** Prior decisions kept in a decision brief — contextual judgment, bounded page. */
export const DECISIONS_IN_BRIEF_MAX = 8;

const decisionLine = (d: Decision): string => `decision r${d.round}: ${d.choice ?? "unanswered"} — ${firstLine(d.question)}`;

export function workerBrief(m: Manifest, verdicts: Verdict[], round: number, lastRoundText: string | null, decisions: Decision[] = []): string {
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
		for (const d of decisions.filter((d) => d.round === round - 1)) lines.push(decisionLine(d));
		if (lastRoundText) lines.push("", "Your previous round's final report:", "```", tail(lastRoundText), "```");
	}
	return lines.join("\n") + "\n";
}

/** The goal/criteria/rubric header shared by every fresh-context child role. */
function headerLines(m: Manifest): string[] {
	const lines: string[] = [`Goal under review: ${m.goal}`];
	if (m.config.criteria) lines.push(`Stated criteria command: \`${m.config.criteria}\``);
	if (m.reviewRubric) lines.push(`Reviewer rubric (verify against this): ${m.reviewRubric}`);
	if (m.criteriaFiles.length > 0) lines.push(`Criteria files: ${m.criteriaFiles.join(", ")}`);
	return lines;
}

export function reviewerBrief(m: Manifest, verdicts: Verdict[], repair: boolean): string {
	const lines: string[] = ["# Independent review", "", ...headerLines(m)];
	const last = verdicts[verdicts.length - 1];
	if (last) lines.push("", `## Prior findings`, `Previous notes: ${last.notes}`);
	if (repair) lines.push("", "**Your previous reply did not produce a parseable verdict.** You MUST end by calling the `submit_verdict` tool exactly once.");
	return lines.join("\n") + "\n";
}

export function decisionBrief(m: Manifest, decisions: Decision[], ask: { question: string; options: string[]; recommendation: string | null }, repair: boolean): string {
	const lines: string[] = ["# Decision consultation", "", ...headerLines(m)];
	const prior = decisions.slice(-DECISIONS_IN_BRIEF_MAX);
	if (prior.length > 0) {
		lines.push("", "## Prior decisions");
		for (const d of prior) lines.push(decisionLine(d));
	}
	lines.push("", "## Question", ask.question, "", "Options:");
	for (const o of ask.options) lines.push(`- ${o}`);
	if (ask.recommendation !== null) lines.push("", `Worker recommendation: ${ask.recommendation}`);
	if (repair) lines.push("", "**Your previous reply did not produce a parseable decision.** You MUST end by calling the `submit_decision` tool exactly once with a choice from the stated options.");
	return lines.join("\n") + "\n";
}

const tail = (s: string): string => s.slice(-BRIEF_TAIL_CHARS);
