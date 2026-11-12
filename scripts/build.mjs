#!/usr/bin/env node
/**
 * Build dist/ for the kicker bin: node refuses type stripping under
 * node_modules, so the published package carries compiled JS. Pure node
 * (module.stripTypeScriptTypes, in the engines floor since 22.13) — no
 * toolchain; tsc stays typecheck-only. src/index.ts is excluded: it is
 * the only file importing the pi host, ships as TS for pi's -e loader,
 * and the bin must not depend on the host — a host import reaching the
 * compiled graph breaks this script's smoke import, loudly.
 */
import { stripTypeScriptTypes } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const distDir = path.resolve(srcDir, "..", "dist");
const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "index.ts");

// Relative .ts import specifiers become .js in the emitted graph.
const rewriteSpecifiers = (js) => js.replace(/(from\s*|import\s*)(["'])(\.[^"']+)\.ts\2/g, "$1$2$3.js$2");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir);
for (const f of sources) {
	const js = rewriteSpecifiers(stripTypeScriptTypes(fs.readFileSync(path.join(srcDir, f), "utf8"), { mode: "strip" }));
	fs.writeFileSync(path.join(distDir, f.replace(/\.ts$/, ".js")), js);
}
await import(pathToFileURL(path.join(distDir, "driver.js")));
console.log(`dist: ${sources.length} modules, driver smoke-imported`);
