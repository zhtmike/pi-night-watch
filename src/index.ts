/**
 * pi extension — env-gated three-mode factory (decider gate first: a decider
 * child carries TASK_DIR/ROUND too, and a mis-ordered gate would silently
 * register the wrong tools):
 *
 *   NIGHTWATCH_DECIDER=1     → decision child: registers `submit_decision` only
 *   NIGHTWATCH_REVIEWER=1    → reviewer child: registers `submit_verdict` only
 *   NIGHTWATCH_TASK_DIR set  → worker child:   registers `review_gate` + `consult_reviewer`
 *   otherwise                → interactive session: `/watch` commands
 *
 * Children load this file via `-e <abs path>`; the env markers are the
 * recursion guard. Tool execute signature: (toolCallId, params, signal, onUpdate, ctx).
 */

import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateVerdictArgs, validateConsultArgs, validateDecisionArgs } from "./events.ts";
import { advanceTask, latestSlug, overlayText, parseStartArgs, resolveGoal, runConsultation, runReviewGate, startTask, statusLine, statusText, stopTask } from "./driver.ts";

const EXT_PATH = fileURLToPath(import.meta.url);
const text = (s: string): AgentToolResult => ({ content: [{ type: "text", text: s }], details: {} });

const submitVerdictTool = defineTool({
	name: "submit_verdict",
	label: "Submit verdict",
	description:
		"Submit the review verdict. Call exactly once, as your final act. passed: whether the goal is met; notes: what you verified and what remains (≤500 chars); evidence: commands you ran and what they showed; wait: {check_cmd, due_at} only with passed:false, when one external condition outside any worker's control is all that remains — the driver re-checks it and completes the round when it holds.",
	parameters: Type.Object({
		passed: Type.Boolean({ description: "True only if the goal is verifiably met" }),
		notes: Type.String({ description: "Findings summary, ≤500 chars" }),
		evidence: Type.Array(Type.String({ description: "A command and what it showed" })),
		wait: Type.Optional(
			Type.Object({
				check_cmd: Type.String({ description: "Shell command that exits 0 once the awaited condition holds (≤500 chars)" }),
				due_at: Type.String({ description: "Earliest recheck, ISO-8601 timestamp" }),
			}),
		),
	}),
	async execute(_toolCallId: string, params: unknown) {
		const v = validateVerdictArgs(params);
		if ("error" in v) return { content: [{ type: "text", text: `verdict rejected: ${v.error}. Call submit_verdict again with a valid shape.` }], details: {} };
		return { content: [{ type: "text", text: `verdict recorded (passed=${v.passed}${v.wait ? `, waiting until ${v.wait.due_at}` : ""}). You may now finish.` }], details: {} };
	},
});

const submitDecisionTool = defineTool({
	name: "submit_decision",
	label: "Submit decision",
	description:
		"Submit the decision for the worker's question. Call exactly once, as your final act. choice: one of the stated options; reasoning: why that option, ≤500 chars.",
	parameters: Type.Object({
		choice: Type.String({ description: "Exactly one of the options stated in the brief" }),
		reasoning: Type.String({ description: "Why this option, ≤500 chars" }),
	}),
	async execute(_toolCallId: string, params: unknown) {
		const v = validateDecisionArgs(params);
		if ("error" in v) return { content: [{ type: "text", text: `decision rejected: ${v.error}. Call submit_decision again with a valid shape.` }], details: {} };
		return { content: [{ type: "text", text: `decision recorded (${v.choice}). You may now finish.` }], details: {} };
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
		const wait = verdict.wait ? ` — waiting until ${verdict.wait.due_at} on \`${verdict.wait.check_cmd}\`; finish this round, the driver re-checks` : "";
		return text(`REVIEWER VERDICT: ${verdict.passed ? "PASSED" : "REJECTED"}${wait}\n${verdict.notes}${ev}`);
	},
});

const consultReviewerTool = defineTool({
	name: "consult_reviewer",
	label: "Consult reviewer",
	description:
		"Ask the decision authority when you face a fork you would otherwise stop and ask the owner about — an ambiguous requirement, a choice between implementations, a risky trade. State the question, the concrete options, and your recommendation; you get a decision back and continue on it. Never stall waiting for a human; never pick silently.",
	parameters: Type.Object({
		question: Type.String({ description: "The decision question, ≤500 chars" }),
		options: Type.Array(Type.String({ description: "A concrete option" }), { minItems: 2 }),
		recommendation: Type.Optional(Type.String({ description: "Your recommended option and why" })),
	}),
	async execute(_toolCallId: string, params: unknown) {
		const dir = process.env.NIGHTWATCH_TASK_DIR;
		const round = Number(process.env.NIGHTWATCH_ROUND ?? "0");
		if (!dir || !Number.isInteger(round) || round < 1) {
			return text("consult_reviewer unavailable: NIGHTWATCH_TASK_DIR/NIGHTWATCH_ROUND not set (this tool only exists inside night-watch worker rounds)");
		}
		const ask = validateConsultArgs(params);
		if ("error" in ask) return text(`consult rejected: ${ask.error}. Call consult_reviewer again with a valid shape.`);
		const d = await runConsultation(dir, round, ask, EXT_PATH);
		return text(
			d.choice === null
				? `DECISION UNAVAILABLE — no parseable answer after retry; proceed on your own judgment (recorded as unanswered). Question: ${ask.question}`
				: `DECISION: ${d.choice}\n${d.reasoning}`,
		);
	},
});

const USAGE = "usage: /watch [slug] (inspector) | /watch start [--criteria cmd] [--criteria-files a,b] [--slug s] [--review rubric] [--goal-file path] [<goal>] | /watch status [slug] | /watch advance [slug] | /watch stop [slug]";

// --- statusbar (interactive sessions only) ------------------------------------------------------

const STATUS_KEY = "night-watch";
const STATUS_POLL_MS = 5_000;

type SessionCtx = { cwd: string; hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void } };
let sessionCtx: SessionCtx | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function statusBarTick(): void {
	const ctx = sessionCtx;
	if (ctx === null) return;
	let line: string | null = null;
	try {
		line = statusLine(ctx.cwd, latestSlug(ctx.cwd));
	} catch {
		line = null; // no tasks yet or unreadable workspace — nothing to show this tick
	}
	ctx.ui.setStatus(STATUS_KEY, line === null ? undefined : line);
}

function armPolling(): void {
	if (pollTimer === null && sessionCtx !== null && sessionCtx.hasUI) {
		pollTimer = setInterval(statusBarTick, STATUS_POLL_MS);
	}
}

function stopPolling(): void {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

export default function (pi: ExtensionAPI) {
	const decider = process.env.NIGHTWATCH_DECIDER === "1";
	const reviewer = !decider && process.env.NIGHTWATCH_REVIEWER === "1";
	const worker = !decider && !reviewer && Boolean(process.env.NIGHTWATCH_TASK_DIR);

	if (decider) {
		pi.registerTool(submitDecisionTool);
		return;
	}

	if (reviewer) {
		pi.registerTool(submitVerdictTool);
		return;
	}
	if (worker) {
		pi.registerTool(reviewGateTool);
		pi.registerTool(consultReviewerTool);
		return;
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = { cwd: ctx.cwd, hasUI: ctx.hasUI, ui: ctx.ui };
		armPolling();
	});
	pi.on("session_shutdown", () => {
		stopPolling();
		sessionCtx = null;
	});

	pi.registerCommand("watch", {
		description: "Long-horizon worker/reviewer loop — bare /watch inspects; start|status|advance|stop manage",
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
					if (!o.goal && !o.goalFile) {
						ctx.ui.notify(USAGE, "warning");
						return;
					}
					const goal = resolveGoal(ctx.cwd, { goal: o.goal || undefined, goalFile: o.goalFile });
					const { slug } = startTask(ctx.cwd, goal, { criteriaFiles: o.criteriaFiles, slug: o.slug, criteria: o.criteria, reviewRubric: o.reviewRubric });
					const rep = advanceTask(ctx.cwd, slug, EXT_PATH);
					ctx.ui.notify([`task ${slug} started`, ...rep.lines].join("\n"), "info");
				} else if (cmd === "status") {
					const t = statusText(ctx.cwd, slugArg ?? latestSlug(ctx.cwd));
					ctx.ui.notify(t, "info");
				} else if (cmd === "advance") {
					const rep = advanceTask(ctx.cwd, slugArg ?? latestSlug(ctx.cwd), EXT_PATH);
					ctx.ui.notify(rep.lines.join("\n"), "info");
				} else if (cmd === "stop") {
					const lines = await stopTask(ctx.cwd, slugArg ?? latestSlug(ctx.cwd));
					ctx.ui.notify(lines.join("\n"), "info");
				} else if (parts.length <= 1) {
					// Bare /watch or /watch <slug>: the inspector — chains, rounds, live tail, usage. Zero model tokens.
					ctx.ui.notify(overlayText(ctx.cwd, cmd === undefined ? latestSlug(ctx.cwd) : cmd), "info");
				} else {
					ctx.ui.notify(USAGE, "warning");
				}
			} catch (err) {
				ctx.ui.notify(`night-watch error: ${(err as Error).message}`, "error");
			}
		},
	});
}
