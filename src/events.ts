/**
 * pi `--mode json` event-stream parsing. The authoritative record is the
 * event stream — verdicts are tool calls, never free-form final text.
 */

export interface ParsedEvents {
	/** last agent_settled seen (an aborted run still counts as settled) */
	settled: boolean;
	/** submit_verdict tool_execution_start args, in call order */
	verdictCalls: { args: unknown }[];
	/** last assistant message_end text */
	finalAssistantText: string | null;
	lineCount: number;
}

/** A torn trailing line (no newline) is truncation and is skipped; any other malformed line throws. */
export function parseEvents(text: string): ParsedEvents {
	const out: ParsedEvents = { settled: false, verdictCalls: [], finalAssistantText: null, lineCount: 0 };
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
		} else if (ev.type === "tool_execution_start") {
			if (ev.toolName === "submit_verdict") out.verdictCalls.push({ args: ev.args });
		} else if (ev.type === "message_end") {
			const msg = ev.message as Record<string, unknown> | undefined;
			if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
				const parts = (msg.content as Array<Record<string, unknown>>).filter((p) => p.type === "text").map((p) => String(p.text ?? ""));
				out.finalAssistantText = parts.join("");
			}
		}
	}
	return out;
}

/** Verdict field caps (schema contract). */
export const VERDICT_NOTES_MAX = 500;
export const VERDICT_EVIDENCE_MAX = 500;

export type ValidatedVerdict = { passed: boolean; notes: string; evidence: string[] };

/** Validate submit_verdict args; returns the verdict fields or an error string. */
export function validateVerdictArgs(args: unknown): ValidatedVerdict | { error: string } {
	if (typeof args !== "object" || args === null) return { error: "verdict args must be an object" };
	const r = args as Record<string, unknown>;
	if (typeof r.passed !== "boolean") return { error: `"passed" must be a boolean` };
	if (typeof r.notes !== "string") return { error: `"notes" must be a string` };
	if (!Array.isArray(r.evidence)) return { error: `"evidence" must be an array of strings` };
	for (const e of r.evidence) if (typeof e !== "string") return { error: `"evidence" entries must be strings` };
	return { passed: r.passed, notes: r.notes.slice(0, VERDICT_NOTES_MAX), evidence: r.evidence.map((e) => String(e).slice(0, VERDICT_EVIDENCE_MAX)) };
}
