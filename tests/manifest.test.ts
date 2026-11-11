import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WatchError, readManifest, readVerdicts, writeManifest, type Manifest } from "../src/manifest.ts";
import { check, finish } from "./harness.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nw-manifest-"));
const file = path.join(tmp, "a", "manifest.json");
const m: Manifest = {
	version: 1,
	slug: "t",
	goal: "g",
	reviewRubric: null,
	config: { piBin: "pi", timeoutBin: "timeout", maxRounds: 2, roundDeadlineMin: 3, reviewerDeadlineMin: 4, killGraceSec: 5, criteriaTimeoutMs: 6, lockGraceMs: 7, preflightTimeoutMs: 8, pollJitterMs: 9, waitRetryBaseMs: 10, waitRetryMaxMs: 11, waitMaxAttempts: 12 },
	criteriaFiles: [],
	criteriaHash: "",
	owner: { host: "h", startedAt: "t" },
	rounds: [{ id: 1, headPid: null, headStart: null, startedAt: "t", spawnedAt: null, endedAt: null, outcome: null }],
	terminal: null,
};
writeManifest(file, m);
writeManifest(file, m);
check("round-trips and rewrites atomically", readManifest(file).slug === "t");
check("no tmp leftovers", fs.readdirSync(path.dirname(file)).every((f) => !f.includes(".tmp")));
const old = { ...m, config: { piBin: "pi", timeoutBin: "timeout", maxRounds: 2, roundDeadlineMin: 3, reviewerDeadlineMin: 4, killGraceSec: 5, criteriaTimeoutMs: 6, lockGraceMs: 7, preflightTimeoutMs: 8 } } as unknown as Manifest;
const oldFile = file.replace("manifest.json", "old.json");
writeManifest(oldFile, old);
check("old config snapshot gains new-key defaults on read", readManifest(oldFile).config.waitRetryBaseMs === 60_000 && readManifest(oldFile).config.waitMaxAttempts === 5);
fs.writeFileSync(file.replace("manifest.json", "bad.json"), '{"version":2}');
try {
	readManifest(file.replace("manifest.json", "bad.json"));
	check("version guard throws", false);
} catch (e) {
	check("version guard throws", e instanceof WatchError);
}
const vFile = path.join(tmp, "v.jsonl");
fs.writeFileSync(vFile, JSON.stringify({ at: "t", round: 1, passed: true, notes: "n", evidence: [] }) + "\n" + '{"torn');
check("verdicts: torn tail skipped", readVerdicts(vFile).length === 1);
fs.writeFileSync(vFile, "not json\n".repeat(2));
try {
	readVerdicts(vFile);
	check("verdicts: mid-file corruption throws", false);
} catch {
	check("verdicts: mid-file corruption throws", true);
}
finish("manifest");
