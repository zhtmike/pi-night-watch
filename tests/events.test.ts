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

const dStream = [ev("tool_execution_start", { toolName: "bash", args: { command: "ls" } }), ev("agent_settled", { aborted: false })].join("\n") + "\n";
const uStream =
	[
		ev("message_update", { usage: { totalTokens: 1200, cost: { total: 0.01 } } }),
		ev("message_update", { usage: { totalTokens: 2000, cost: { total: 0.02 } } }),
		ev("message_end", { message: { role: "assistant", content: [] } }),
		ev("message_update", { usage: { totalTokens: 500, cost: { total: 0.03 } } }),
		ev("message_end", { message: { role: "assistant", content: [] } }),
		ev("agent_settled", {}),
	].join("\n") + "\n";
check(
	"parseEvents: usage = latest cumulative snapshot per response, accumulated at message_end",
	(() => {
		const p = parseEvents(uStream);
		return p.usage.tokens === 2500 && Math.abs(p.usage.cost - 0.05) < 1e-9;
	})(),
);
check("parseEvents: no usage events ⇒ zero", parseEvents(dStream).usage.tokens === 0 && parseEvents(dStream).usage.cost === 0);
finish("events");
