#!/usr/bin/env node
// Summarize a promptfoo results file (`promptfoo eval -o results.json`) as a
// per-model comparison: pass rate with a 95% confidence interval, per-case
// pass counts across repeats, token usage and estimated cost.
//
// Usage: node evals/summarize.js evals/results/latest.json

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// USD per million tokens, first-party API list prices as of 2026-10.
// promptfoo has no prices for these models, so cost is computed here.
const PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

// promptfoo ResultFailureReason: 1 = assertion failed, 2 = provider/runtime error.
const FAILURE_ERROR = 2;

/** Wilson score interval: better than the normal approximation at small n. */
export function wilson(passes, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = passes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function modelId(providerId) {
  return providerId?.replace(/^anthropic:messages:/, "") ?? "unknown";
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function summarize(data) {
  const rows = data.results?.results ?? data.results ?? [];
  const models = new Map();
  const cases = new Map();

  for (const r of rows) {
    const label = r.provider?.label ?? r.provider?.id;
    const id = modelId(r.provider?.id);
    const desc = r.testCase?.description ?? r.description ?? `test ${r.testIdx}`;
    const isError = r.failureReason === FAILURE_ERROR || Boolean(r.error && !r.gradingResult);

    let m = models.get(label);
    if (!m) {
      m = { id, graded: 0, passes: 0, errors: 0, input: 0, output: 0, latencies: [] };
      models.set(label, m);
    }
    const usage = r.response?.tokenUsage ?? r.tokenUsage ?? {};
    m.input += usage.prompt ?? 0;
    m.output += usage.completion ?? 0;
    if (Number.isFinite(r.latencyMs)) m.latencies.push(r.latencyMs);

    if (!cases.has(desc)) cases.set(desc, new Map());
    const perModel = cases.get(desc);
    if (!perModel.has(label)) perModel.set(label, { passes: 0, n: 0, errors: 0, reasons: new Set() });
    const c = perModel.get(label);

    // Infrastructure errors (rate limits, timeouts) say nothing about the
    // model's tool selection, so they are reported but kept out of pass rates.
    if (isError) {
      m.errors++;
      c.errors++;
      continue;
    }
    m.graded++;
    c.n++;
    if (r.success) {
      m.passes++;
      c.passes++;
    } else if (r.gradingResult?.reason) {
      c.reasons.add(r.gradingResult.reason);
    }
  }

  const labels = [...models.keys()];
  const lines = [];
  let totalCost = 0;

  lines.push("## Models", "");
  lines.push("| Model | Pass rate | 95% CI | Graded | Errors | Input tok | Output tok | Est. cost | p50 latency |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const [label, m] of models) {
    const [lo, hi] = wilson(m.passes, m.graded);
    const price = PRICES[m.id];
    const cost = price ? (m.input * price.input + m.output * price.output) / 1e6 : NaN;
    if (Number.isFinite(cost)) totalCost += cost;
    const sorted = [...m.latencies].sort((a, b) => a - b);
    const p50 = sorted.length ? `${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)}s` : "-";
    lines.push(
      `| ${label} | ${m.graded ? pct(m.passes / m.graded) : "-"} | ${pct(lo)}–${pct(hi)} | ${m.graded} | ${m.errors} | ${m.input} | ${m.output} | ${Number.isFinite(cost) ? `$${cost.toFixed(3)}` : "unknown"} | ${p50} |`,
    );
  }
  lines.push("", `Total estimated cost: $${totalCost.toFixed(3)}`, "");

  lines.push("## Cases (passes / graded runs)", "");
  lines.push(`| Case | ${labels.join(" | ")} |`);
  lines.push(`|---|${labels.map(() => "---").join("|")}|`);
  const failures = [];
  for (const [desc, perModel] of cases) {
    const cells = labels.map((label) => {
      const c = perModel.get(label);
      if (!c) return "-";
      const flag = c.n > 0 && c.passes > 0 && c.passes < c.n ? " ⚠️" : c.n > 0 && c.passes === 0 ? " ❌" : "";
      const err = c.errors ? ` (+${c.errors} err)` : "";
      if (c.reasons.size) failures.push({ desc, label, reasons: [...c.reasons] });
      return `${c.passes}/${c.n}${flag}${err}`;
    });
    lines.push(`| ${desc} | ${cells.join(" | ")} |`);
  }
  lines.push("", "⚠️ = inconsistent across repeats, ❌ = failed every run", "");

  if (failures.length) {
    lines.push("## Failure reasons", "");
    for (const f of failures) {
      lines.push(`- **${f.desc}** (${f.label})`);
      for (const reason of f.reasons) lines.push(`  - ${reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node evals/summarize.js <promptfoo-results.json>");
    process.exit(1);
  }
  console.log(summarize(JSON.parse(readFileSync(path, "utf8"))));
}
