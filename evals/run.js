#!/usr/bin/env node
// Prints the summary even when cases fail, but keeps promptfoo's exit status.
// The results file is removed first so a run that dies before writing one
// can't be summarised from the previous run's file.
//
// Usage: node evals/run.js <results.json> [promptfoo eval args...]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { summarize } from "./summarize.js";

// Not a devDependency: npm 10 and 11 resolve its optional peers differently,
// and CI runs both. The exact version keeps runs comparable; eval:view in
// package.json uses the same one.
const PROMPTFOO = ["--yes", "promptfoo@0.125.1"];

const [out, ...args] = process.argv.slice(2);
if (!out) {
  console.error("Usage: node evals/run.js <results.json> [promptfoo eval args...]");
  process.exit(1);
}

rmSync(out, { force: true });
const run = spawnSync("npx", [...PROMPTFOO, "eval", ...args, "-o", out], { stdio: "inherit" });
if (run.error) {
  console.error(run.error.message);
  process.exit(1);
}
if (existsSync(out)) {
  console.log(summarize(JSON.parse(readFileSync(out, "utf8"))));
}
process.exit(run.status ?? 1);
