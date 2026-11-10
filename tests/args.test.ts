import { ConfigError } from "../src/config.ts";
import { parseStartArgs, tokenize } from "../src/args.ts";
import { check, finish } from "./harness.ts";

check("quoted segments preserved", JSON.stringify(tokenize('--criteria "npm test" fix the bug')) === JSON.stringify(["--criteria", "npm test", "fix", "the", "bug"]));
check("single quotes + adjacency", tokenize("'a b'c").join("|") === "a bc");
try {
	tokenize('"unterminated');
	check("unterminated quote throws", false);
} catch (e) {
	check("unterminated quote throws", e instanceof ConfigError);
}
const ps = parseStartArgs('--criteria "node test/run.js && node test/hidden.js" --criteria-files test/a.js,test/b.js --slug fix-it Make the suite pass');
check("multi-word criteria", ps.criteria === "node test/run.js && node test/hidden.js");
check("criteria files split", JSON.stringify(ps.criteriaFiles) === JSON.stringify(["test/a.js", "test/b.js"]));
check("slug + goal", ps.slug === "fix-it" && ps.goal === "Make the suite pass");
const pr = parseStartArgs('--review "no + operator" Make it pass');
check("review rubric flag", pr.reviewRubric === "no + operator" && pr.goal === "Make it pass");
finish("args");
