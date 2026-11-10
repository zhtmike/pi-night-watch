/**
 * pi extension — env-gated three-mode factory:
 *
 *   NIGHTWATCH_REVIEWER=1    → reviewer child: registers `submit_verdict` only
 *   NIGHTWATCH_TASK_DIR set  → worker child:   registers `review_gate` only
 *   otherwise                → interactive session: `/watch` commands
 *
 * Children load this file via `-e <abs path>`; the env markers are the
 * recursion guard. Tool execute signature: (toolCallId, params, signal, onUpdate, ctx).
 */

import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateVerdictArgs } from "./events.ts";
import { advanceTask, latestSlug, parseStartArgs, runReviewGate, startTask, statusText, stopTask } from "./driver.ts";

const EXT_PATH = fileURLToPath(import.meta.url);
const text = (s: string): AgentToolResult => ({ content: [{ type: "text", text: s }], details: {} });

const submitVerdictTool = defineTool({
	name: "submit_verdict",
	label: "Submit verdict",
	description: "Submit the review verdict. Call exactly once, as your final act. passed: whether the goal is met; notes: what you verified and what remains (≤500 chars); evidence: commands you ran and what they showed.",
	parameters: Type.Object({
		passed: Type.Boolean({ description: "True only if the goal is verifiably met" }),
		notes: Type.String({ description: "Findings summary, ≤500 chars" }),
		evidence: Type.Array(Type.String({ description: "A command and what it showed" })),
	}),
	async execute(_toolCallId: string, params: unknown) {
		const v = validateVerdictArgs(params);
		if ("error" in v) return { content: [{ type: "text", text: `verdict rejected: ${v.error}. Call submit_verdict again with a valid shape.` }], details: {} };
		return { content: [{ type: "text", text: `verdict recorded (passed=${v.passed}). You may now finish.` }], details: {} };
	},
});

const reviewGateTool = defineTool({
	name: "review_gate",
	label: "Review gate",
	description:
		"Send the current state to an independent fresh-context reviewer and get its verdict. Call this when you believe the goal is met — never claim completion without it. Takes no arguments; the reviewer sees the goal, criteria, and prior findings itself.",
	parameters: Type.Object({}),
	async execute() {
		const dir = process.env.NIGHTWATCH_TASK_DIR;
		const round = Number(process.env.NIGHTWATCH_ROUND ?? "0");
		if (!dir || !Number.isInteger(round) || round < 1) {
			return text("review_gate unavailable: NIGHTWATCH_TASK_DIR/NIGHTWATCH_ROUND not set (this tool only exists inside night-watch worker rounds)");
		}
		const verdict = await runReviewGate(dir, round, EXT_PATH);
		const ev = verdict.evidence.length > 0 ? "\n" + verdict.evidence.map((e) => `- ${e}`).join("\n") : "";
		return text(`REVIEWER VERDICT: ${verdict.passed ? "PASSED" : "REJECTED"}\n${verdict.notes}${ev}`);
	},
});

const USAGE = "usage: /watch start [--criteria cmd] [--criteria-files a,b] [--slug s] [--review rubric] <goal> | /watch status [slug] | /watch advance [slug] | /watch stop [slug]";

export default function (pi: ExtensionAPI) {
	const reviewer = process.env.NIGHTWATCH_REVIEWER === "1";
	const worker = !reviewer && Boolean(process.env.NIGHTWATCH_TASK_DIR);

	if (reviewer) {
		pi.registerTool(submitVerdictTool);
		return;
	}
	if (worker) {
		pi.registerTool(reviewGateTool);
		return;
	}

	pi.registerCommand("watch", {
		description: "Long-horizon worker/reviewer loop — /watch start|status|advance|stop",
		getArgumentCompletions: (arg: string) => {
			const first = (arg.split(/\s+/)[0] ?? "").trim();
			if (!arg.includes(" ")) {
				return ["start ", "status ", "advance ", "stop "].filter((s) => first === "" || s.startsWith(first)).map((value) => ({ label: value.trim(), value, description: value.trim() }));
			}
			return null;
		},
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0];
			const slugArg = parts[1];
			try {
				if (cmd === "start") {
					const o = parseStartArgs(args.slice("start".length));
					if (!o.goal) {
						ctx.ui.notify(USAGE, "warning");
						return;
					}
					const { slug } = startTask(ctx.cwd, o.goal, { criteriaFiles: o.criteriaFiles, slug: o.slug, criteria: o.criteria, reviewRubric: o.reviewRubric });
					const rep = advanceTask(ctx.cwd, slug, EXT_PATH);
					ctx.ui.notify([`task ${slug} started`, ...rep.lines].join("\n"), "info");
				} else if (cmd === "status") {
					const t = statusText(ctx.cwd, slugArg ?? latestSlug(ctx.cwd));
					ctx.ui.notify(t, "info");
					if (ctx.hasUI) ctx.ui.setStatus("night-watch", t.split("\n").slice(0, 2).join(" · "));
				} else if (cmd === "advance") {
					const rep = advanceTask(ctx.cwd, slugArg ?? latestSlug(ctx.cwd), EXT_PATH);
					ctx.ui.notify(rep.lines.join("\n"), "info");
				} else if (cmd === "stop") {
					const lines = await stopTask(ctx.cwd, slugArg ?? latestSlug(ctx.cwd));
					ctx.ui.notify(lines.join("\n"), "info");
				} else {
					ctx.ui.notify(USAGE, "warning");
				}
			} catch (err) {
				ctx.ui.notify(`night-watch error: ${(err as Error).message}`, "error");
			}
		},
	});
}
