import { VERDICT_NOTES_MAX, parseEvents, validateVerdictArgs } from "../src/events.ts";
import { check, finish } from "./harness.ts";

const ev = (t: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: t, ...extra });
const stream =
	[
		ev("session"),
		ev("message_end", { message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
		ev("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "ls" } }),
		ev("tool_execution_start", { toolCallId: "2", toolName: "submit_verdict", args: { passed: true, notes: "ok", evidence: ["npm test → 0"] } }),
		ev("message_end", { message: { role: "assistant", content: [{ type: "text", text: "final words" }] } }),
		ev("agent_settled", { aborted: false }),
	].join("\n") + "\n";
const p = parseEvents(stream);
check("settled", p.settled);
check("verdict call extracted", p.verdictCalls.length === 1 && (p.verdictCalls[0].args as { passed: boolean }).passed);
check("final assistant text", p.finalAssistantText === "final words");
check("torn tail skipped", parseEvents(stream.slice(0, -20)).lineCount > 0);
try {
	parseEvents('{"type":"session"}\nnot json\n');
	check("corrupt line throws", false);
} catch {
	check("corrupt line throws", true);
}

const good = validateVerdictArgs({ passed: false, notes: "x".repeat(600), evidence: ["a"] });
check("validate: truncates notes at cap", !("error" in good) && good.notes.length === VERDICT_NOTES_MAX);
check("validate: rejects non-bool passed", "error" in validateVerdictArgs({ passed: "yes", notes: "x", evidence: [] }));
check("validate: rejects non-string evidence", "error" in validateVerdictArgs({ passed: true, notes: "x", evidence: [1] }));

const wv = validateVerdictArgs({ passed: false, notes: "CI pending", evidence: ["gh run view → in_progress"], wait: { check_cmd: "gh run watch && exit 0", due_at: "2026-11-11T12:00:00Z" } });
check("validate: wait round-trips", !("error" in wv) && wv.wait?.check_cmd === "gh run watch && exit 0" && wv.wait.due_at === "2026-11-11T12:00:00Z");
check("validate: wait rejected on a passing verdict", "error" in validateVerdictArgs({ passed: true, notes: "x", evidence: [], wait: { check_cmd: "true", due_at: "2026-11-11T12:00:00Z" } }));
check("validate: wait check_cmd cap", "error" in validateVerdictArgs({ passed: false, notes: "x", evidence: [], wait: { check_cmd: "x".repeat(501), due_at: "2026-11-11T12:00:00Z" } }));
check("validate: wait check_cmd empty", "error" in validateVerdictArgs({ passed: false, notes: "x", evidence: [], wait: { check_cmd: "", due_at: "2026-11-11T12:00:00Z" } }));
check("validate: wait due_at must be ISO-8601", "error" in validateVerdictArgs({ passed: false, notes: "x", evidence: [], wait: { check_cmd: "true", due_at: "tomorrow" } }) && "error" in validateVerdictArgs({ passed: false, notes: "x", evidence: [], wait: { check_cmd: "true", due_at: "March 1, 2030" } }));
check("validate: wait must be an object", "error" in validateVerdictArgs({ passed: false, notes: "x", evidence: [], wait: "later" }));
check("validate: wait needs both fields", "error" in validateVerdictArgs({ passed: false, notes: "x", evidence: [], wait: { check_cmd: "true" } }));
const noWait = validateVerdictArgs({ passed: false, notes: "x", evidence: [] });
check("validate: no wait still valid", !("error" in noWait) && noWait.wait === undefined);
finish("events");
