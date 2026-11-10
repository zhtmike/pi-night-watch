import { ConfigError, DEFAULT_WATCH_CONFIG, normalizeConfig } from "../src/config.ts";
import { check, finish } from "./harness.ts";

check("defaults", normalizeConfig(undefined, "t").maxRounds === DEFAULT_WATCH_CONFIG.maxRounds && normalizeConfig(undefined, "t").reviewerDeadlineMin === DEFAULT_WATCH_CONFIG.reviewerDeadlineMin);
check("piBin defaults to \"pi\"", normalizeConfig(undefined, "t").piBin === "pi");
check("thinking level accepted", normalizeConfig({ reviewerThinkingLevel: "max" }, "t").reviewerThinkingLevel === "max");
check("partial overrides, rest defaulted", (() => { const c = normalizeConfig({ maxRounds: 3 }, "t"); return c.maxRounds === 3 && c.killGraceSec === DEFAULT_WATCH_CONFIG.killGraceSec; })());
for (const bad of [{ maxRounds: "x" }, { maxRounds: 0 }, { criteria: "" }, { workerThinkingLevel: "ultra" }, { bogus: 1 }, "str"] as unknown[]) {
	try {
		normalizeConfig(bad, "t");
		check(`rejects ${JSON.stringify(bad)}`, false);
	} catch (e) {
		check(`rejects ${JSON.stringify(bad)}`, e instanceof ConfigError);
	}
}
finish("config");
