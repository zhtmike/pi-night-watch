import { slugify, taskDir, workerEventsPath } from "../src/manifest.ts";
import { check, finish } from "./harness.ts";

check("slugify: kebab + cap", slugify("Make `node test/run.js` exit 0!!") === "make-node-test-run-js-ex");
check("slugify: too-short falls back", slugify("a") === "task");
check("paths: task + round events", workerEventsPath(taskDir("/r", "s"), 2).endsWith(".pi/night-watch/s/rounds/2/worker.events.jsonl"));
finish("paths");
