/**
 * Configuration: the single source of every tunable. No other module hardcodes
 * a deadline, cap, grace period, or binary name — all flow from WatchConfig.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export class ConfigError extends Error {}

export interface WatchConfig {
	/** pi model spec for worker rounds; may carry a `:thinking` suffix. Unset = pi default. */
	workerModel?: string;
	/** Thinking pin for worker rounds — wins over any `:level` suffix in workerModel. */
	workerThinkingLevel?: ThinkingLevel;
	/** pi model spec for reviewer children. Prefer a different model family than workerModel. */
	reviewerModel?: string;
	/** Thinking pin for reviewer children — wins over any `:level` suffix in reviewerModel. */
	reviewerThinkingLevel?: ThinkingLevel;
	/** pi binary to invoke for children (resolved on PATH). */
	piBin: string;
	/** GNU timeout binary for the process-group leash (macOS: point at gtimeout if coreutils is installed). */
	timeoutBin: string;
	/** Round budget. Wall budget is derived: maxRounds × roundDeadlineMin. */
	maxRounds: number;
	/** Hard leash per worker round (minutes). */
	roundDeadlineMin: number;
	/** Hard leash per reviewer child (minutes). */
	reviewerDeadlineMin: number;
	/** TERM→KILL escalation window for the process-group leash (seconds). */
	killGraceSec: number;
	/** Timeout for the driver-run criteria command (ms). */
	criteriaTimeoutMs: number;
	/** Grace before a torn single-flight lock claim may be taken over (ms). */
	lockGraceMs: number;
	/** Timeout for the child-binary preflight check (ms). */
	preflightTimeoutMs: number;
	/** Upper bound on the random pre-action sleep in the kicker bin (ms). */
	pollJitterMs: number;
	/** First wait-check retry delay; retries back off 2^(n-1) from here (ms). */
	waitRetryBaseMs: number;
	/** Cap on any single wait-check retry delay (ms). */
	waitRetryMaxMs: number;
	/** Nonzero checks a parked round tolerates before FAIL wait-exhausted. */
	waitMaxAttempts: number;
	/** Shell command run by the driver; PASS requires exit 0. Unset = verdict-only mode. */
	criteria?: string;
}

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
	piBin: "pi",
	timeoutBin: "timeout",
	maxRounds: 10,
	roundDeadlineMin: 30,
	reviewerDeadlineMin: 15,
	killGraceSec: 10,
	criteriaTimeoutMs: 300_000,
	lockGraceMs: 60_000,
	preflightTimeoutMs: 15_000,
	pollJitterMs: 5_000,
	waitRetryBaseMs: 60_000,
	waitRetryMaxMs: 900_000,
	waitMaxAttempts: 5,
};

const INT_KEYS = ["maxRounds", "roundDeadlineMin", "reviewerDeadlineMin", "killGraceSec", "criteriaTimeoutMs", "lockGraceMs", "preflightTimeoutMs", "pollJitterMs", "waitRetryBaseMs", "waitRetryMaxMs", "waitMaxAttempts"] as const;
const STR_KEYS = ["workerModel", "reviewerModel", "criteria", "piBin", "timeoutBin"] as const;
const THINKING_KEYS = ["workerThinkingLevel", "reviewerThinkingLevel"] as const;

/** Parse + validate config. Throws ConfigError naming the invalid key; unknown keys are rejected. */
export function normalizeConfig(raw: unknown, origin: string): WatchConfig {
	if (raw === null || raw === undefined) return { ...DEFAULT_WATCH_CONFIG };
	if (typeof raw !== "object") throw new ConfigError(`${origin}: config must be an object`);
	const r = raw as Record<string, unknown>;
	const out: WatchConfig = { ...DEFAULT_WATCH_CONFIG };
	for (const k of STR_KEYS) {
		const v = r[k];
		if (v === undefined) continue;
		if (typeof v !== "string" || v.length === 0) throw new ConfigError(`${origin}: "${k}" must be a non-empty string`);
		out[k] = v;
	}
	for (const k of INT_KEYS) {
		const v = r[k];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ConfigError(`${origin}: "${k}" must be a positive integer`);
		out[k] = v;
	}
	for (const k of THINKING_KEYS) {
		const v = r[k];
		if (v === undefined) continue;
		if (typeof v !== "string" || !THINKING_LEVELS.includes(v as ThinkingLevel)) throw new ConfigError(`${origin}: "${k}" must be one of ${THINKING_LEVELS.join("|")}`);
		out[k] = v as ThinkingLevel;
	}
	const known = new Set<string>([...INT_KEYS, ...STR_KEYS, ...THINKING_KEYS]);
	const unknown = Object.keys(r).filter((k) => !known.has(k));
	if (unknown.length > 0) throw new ConfigError(`${origin}: unknown keys ${unknown.join(", ")}`);
	return out;
}
