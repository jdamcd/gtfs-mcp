#!/usr/bin/env node
// Prints the summary even when cases fail, but keeps promptfoo's exit status.
// The results file is removed first so a run that dies before writing one
// can't be summarised from the previous run's file.
//
// Usage: node evals/run.js <results.json> [promptfoo eval args...]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { summarize } from "./summarize.js";

// The project's own promptfoo, not whichever one is first on PATH.
const PROMPTFOO = fileURLToPath(new URL("../node_modules/.bin/promptfoo", import.meta.url));

const [out, ...args] = process.argv.slice(2);
if (!out) {
  console.error("Usage: node evals/run.js <results.json> [promptfoo eval args...]");
  process.exit(1);
}

rmSync(out, { force: true });
const run = spawnSync(PROMPTFOO, ["eval", ...args, "-o", out], { stdio: "inherit" });
if (run.error) {
  console.error(run.error.message);
  process.exit(1);
}
if (existsSync(out)) {
  console.log(summarize(JSON.parse(readFileSync(out, "utf8"))));
}
process.exit(run.status ?? 1);
