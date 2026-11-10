import { childArgv as childArgvForTest } from "../src/driver.ts";
import { check, finish } from "./harness.ts";

const base = { piBin: "pi", timeoutBin: "timeout", extPath: "/x/src/index.ts", deadlineSec: 60, killGraceSec: 10, briefPath: "/b.md" };
const w = childArgvForTest({ ...base, model: "zai/glm-5.3:high" });
check("worker: detached timeout leash shape", w[0] === "timeout" && w.slice(1, 4).join(" ") === "-k 10 60" && w[4] === "pi");
check("worker: json + no-session + approve + -e + model + brief", w.includes("--mode") && w.includes("json") && w.includes("--no-session") && w.includes("--approve") && w.includes("/x/src/index.ts") && w.includes("zai/glm-5.3:high") && w.includes("@/b.md"));
check("worker: NOT --foreground (own group)", !w.includes("--foreground"));
const r = childArgvForTest({ ...base, thinking: "high", foreground: true });
check("reviewer: --foreground (joins worker group)", r[1] === "--foreground" && r.includes("--approve"));
check("reviewer: model omitted when unset", !r.includes("--model"));
check("reviewer: thinking pin appended", r.includes("--thinking") && r.includes("high"));
check("worker: thinking pin appended", childArgvForTest({ ...base, thinking: "max" }).includes("--thinking"));
check("timeout bin from config", childArgvForTest({ ...base, timeoutBin: "gtimeout" })[0] === "gtimeout");
finish("argv");
