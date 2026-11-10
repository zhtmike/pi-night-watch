/**
 * `/watch start` argument parsing: quoted segments preserved, unknown or
 * valueless flags rejected loudly (they never silently become goal text).
 */

import { ConfigError } from "./config.ts";

export interface StartOpts {
	goal: string;
	criteria?: string;
	criteriaFiles?: string[];
	slug?: string;
	reviewRubric?: string;
}

const FLAGS = new Set(["--criteria", "--criteria-files", "--slug", "--review"]);

/** Tokenize a command tail with single/double-quoted segments preserved. */
export function tokenize(s: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	for (const c of s) {
		if (quote !== null) {
			if (c === quote) quote = null;
			else cur += c;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (/\s/.test(c)) {
			if (cur !== "") out.push(cur);
			cur = "";
		} else {
			cur += c;
		}
	}
	if (quote !== null) throw new ConfigError(`unterminated quote in arguments: ${s}`);
	if (cur !== "") out.push(cur);
	return out;
}

/** `/watch start [--criteria cmd] [--criteria-files a,b] [--slug s] [--review rubric] <goal…>` */
export function parseStartArgs(args: string): StartOpts {
	const tokens = tokenize(args);
	const out: StartOpts = { goal: "" };
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("--")) {
			if (!FLAGS.has(t)) throw new ConfigError(`unknown flag ${t} (known: ${[...FLAGS].join(" ")})`);
			const value = tokens[i + 1];
			if (value === undefined || value.startsWith("--")) throw new ConfigError(`flag ${t} requires a value`);
			i++;
			if (t === "--criteria") out.criteria = value;
			else if (t === "--criteria-files") out.criteriaFiles = value.split(",").map((x) => x.trim()).filter(Boolean);
			else if (t === "--slug") out.slug = value;
			else out.reviewRubric = value;
		} else {
			rest.push(t);
		}
	}
	out.goal = rest.join(" ");
	return out;
}
