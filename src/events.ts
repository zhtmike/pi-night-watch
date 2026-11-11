/**
 * pi `--mode json` event-stream parsing. The authoritative record is the
 * event stream — verdicts are tool calls, never free-form final text.
 */

export interface ParsedEvents {
	/** last agent_settled seen (an aborted run still counts as settled) */
	settled: boolean;
	/** submit_verdict tool_execution_start args, in call order */
	verdictCalls: { args: unknown }[];
	/** submit_decision tool_execution_start args, in call order */
	decisionCalls: { args: unknown }[];
	/** last assistant message_end text */
	finalAssistantText: string | null;
	/** tokens/cost accumulated at each message_end from the response's latest cumulative usage snapshot */
	usage: { tokens: number; cost: number };
	lineCount: number;
}

/** A torn trailing line (no newline) is truncation and is skipped; any other malformed line throws. */
export function parseEvents(text: string): ParsedEvents {
	const out: ParsedEvents = { settled: false, verdictCalls: [], decisionCalls: [], finalAssistantText: null, usage: { tokens: 0, cost: 0 }, lineCount: 0 };
	// message_update carries the response's running total, not a delta — the latest snapshot
	// is accumulated once, at the message_end that closes the response.
	let pending: { tokens: number; cost: number } | null = null;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === "") continue;
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line) as Record<string, unknown>;
		} catch (err) {
			if (i === lines.length - 1 && !text.endsWith("\n")) continue;
			throw new Error(`corrupt events line ${i + 1}: ${(err as Error).message}`);
		}
		out.lineCount++;
		if (ev.type === "agent_settled") {
			out.settled = true;
		} else if (ev.type === "message_update") {
			const u = ev.usage as Record<string, unknown> | undefined;
			if (u && typeof u === "object") {
				const tokens = typeof u.totalTokens === "number" ? u.totalTokens : 0;
				const c = u.cost as Record<string, unknown> | undefined;
				const cost = c && typeof c.total === "number" ? c.total : 0;
				pending = { tokens, cost };
			}
		} else if (ev.type === "message_end") {
			if (pending !== null) {
				out.usage.tokens += pending.tokens;
				out.usage.cost += pending.cost;
				pending = null;
			}
			const msg = ev.message as Record<string, unknown> | undefined;
			if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
				const parts = (msg.content as Array<Record<string, unknown>>).filter((p) => p.type === "text").map((p) => String(p.text ?? ""));
				out.finalAssistantText = parts.join("");
			}
		} else if (ev.type === "tool_execution_start") {
			if (ev.toolName === "submit_verdict") out.verdictCalls.push({ args: ev.args });
			else if (ev.toolName === "submit_decision") out.decisionCalls.push({ args: ev.args });
		}
	}
	return out;
}

/** Verdict field caps (schema contract). */
export const VERDICT_NOTES_MAX = 500;
export const VERDICT_EVIDENCE_MAX = 500;
export const WAIT_CHECK_CMD_MAX = 500;

export interface VerdictWait {
	check_cmd: string;
	due_at: string;
}

export type ValidatedVerdict = { passed: boolean; notes: string; evidence: string[]; wait?: VerdictWait };

/** Validate submit_verdict args; returns the verdict fields or an error string. */
export function validateVerdictArgs(args: unknown): ValidatedVerdict | { error: string } {
	if (typeof args !== "object" || args === null) return { error: "verdict args must be an object" };
	const r = args as Record<string, unknown>;
	if (typeof r.passed !== "boolean") return { error: `"passed" must be a boolean` };
	if (typeof r.notes !== "string") return { error: `"notes" must be a string` };
	if (!Array.isArray(r.evidence)) return { error: `"evidence" must be an array of strings` };
	for (const e of r.evidence) if (typeof e !== "string") return { error: `"evidence" entries must be strings` };
	let wait: VerdictWait | undefined;
	if (r.wait !== undefined) {
		if (r.passed) return { error: `"wait" is only valid with passed:false (a passing verdict needs no wait)` };
		if (typeof r.wait !== "object" || r.wait === null) return { error: `"wait" must be an object {check_cmd, due_at}` };
		const w = r.wait as Record<string, unknown>;
		if (typeof w.check_cmd !== "string" || w.check_cmd.length === 0 || w.check_cmd.length > WAIT_CHECK_CMD_MAX) {
			return { error: `"wait.check_cmd" must be a non-empty string ≤ ${WAIT_CHECK_CMD_MAX} chars` };
		}
		if (typeof w.due_at !== "string" || !/^\d{4}-\d{2}-\d{2}([Tt]|$)/.test(w.due_at) || !Number.isFinite(Date.parse(w.due_at))) return { error: `"wait.due_at" must be an ISO-8601 timestamp` };
		wait = { check_cmd: w.check_cmd, due_at: w.due_at };
	}
	return { passed: r.passed, notes: r.notes.slice(0, VERDICT_NOTES_MAX), evidence: r.evidence.map((e) => String(e).slice(0, VERDICT_EVIDENCE_MAX)), ...(wait ? { wait } : {}) };
}

// --- decisions -------------------------------------------------------------------------------

/** Decision field caps (schema contract) — storage hygiene, aligned with the verdict caps. */
export const DECISION_QUESTION_MAX = 500;
export const DECISION_OPTIONS_MIN = 2;
export const DECISION_REASONING_MAX = 500;

export interface ConsultAsk {
	question: string;
	options: string[];
	recommendation: string | null;
}

/** Validate consult_reviewer shape (the worker's ask); the ask's quality is the asker's. */
export function validateConsultArgs(args: unknown): ConsultAsk | { error: string } {
	if (typeof args !== "object" || args === null) return { error: "consult args must be an object" };
	const r = args as Record<string, unknown>;
	if (typeof r.question !== "string" || r.question.length === 0 || r.question.length > DECISION_QUESTION_MAX) return { error: `"question" must be a non-empty string ≤ ${DECISION_QUESTION_MAX} chars` };
	if (!Array.isArray(r.options) || r.options.length < DECISION_OPTIONS_MIN) {
		return { error: `"options" must be an array of at least ${DECISION_OPTIONS_MIN} strings` };
	}
	for (const o of r.options) if (typeof o !== "string" || o.length === 0) return { error: `each option must be a non-empty string` };
	let recommendation: string | null = null;
	if (r.recommendation !== undefined && r.recommendation !== null) {
		if (typeof r.recommendation !== "string" || r.recommendation.length === 0) return { error: `"recommendation" must be a non-empty string` };
		recommendation = r.recommendation;
	}
	return { question: r.question, options: [...r.options], recommendation };
}

export type ValidatedDecision = { choice: string; reasoning: string };

/** Validate submit_decision shape only — a called decision is recorded verbatim; judgment of the choice is the agents'. */
export function validateDecisionArgs(args: unknown): ValidatedDecision | { error: string } {
	if (typeof args !== "object" || args === null) return { error: "decision args must be an object" };
	const r = args as Record<string, unknown>;
	if (typeof r.choice !== "string" || r.choice.length === 0) return { error: `"choice" must be a non-empty string` };
	if (typeof r.reasoning !== "string") return { error: `"reasoning" must be a string` };
	return { choice: r.choice, reasoning: r.reasoning.slice(0, DECISION_REASONING_MAX) };
}
