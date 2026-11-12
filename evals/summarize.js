// promptfoo's own report shows individual results, not whether one model is
// actually better than another. With ~15 cases a few points of pass rate is
// noise, so this works out confidence intervals and per-case consistency
// across repeats to show which differences are real. report.js renders it.

import { caseSpec, executedToolCalls, neededTools } from "./tool-calls.js";

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

function caseStatus(c) {
  if (c.n === 0) return "ungraded";
  if (c.passes === c.n) return "passed";
  return c.passes === 0 ? "failed" : "inconsistent";
}

// knownTools are listed even if no case names them and no model calls them.
export function summarize(data, knownTools = []) {
  const rows = data.results?.results ?? data.results ?? [];
  const models = new Map();
  const cases = new Map();
  let lastRepeat = 0;

  for (const r of rows) {
    const label = r.provider?.label ?? r.provider?.id;
    const id = modelId(r.provider?.id);
    const desc = r.testCase?.description ?? r.description ?? `test ${r.testIdx}`;
    lastRepeat = Math.max(lastRepeat, r.repeatIndex ?? 0);
    // promptfoo reports hitting max_tool_calls as a provider error, but it means
    // the model kept calling tools, so it's graded as a failure.
    const hitToolLimit = /exceeded max_tool_calls/.test(r.error ?? r.response?.error ?? "");
    const isError =
      !hitToolLimit && (r.failureReason === FAILURE_ERROR || Boolean(r.error && !r.gradingResult));

    let m = models.get(label);
    if (!m) {
      m = { id, graded: 0, passes: 0, errors: 0, calls: 0, input: 0, output: 0, latencies: [] };
      models.set(label, m);
    }
    const usage = r.response?.tokenUsage ?? r.tokenUsage ?? {};
    m.input += usage.prompt ?? 0;
    m.output += usage.completion ?? 0;
    if (Number.isFinite(r.latencyMs)) m.latencies.push(r.latencyMs);

    if (!cases.has(desc)) {
      const spec = caseSpec(r.testCase?.metadata);
      cases.set(desc, {
        query: r.vars?.query ?? null,
        spec,
        needed: neededTools(spec),
        perModel: new Map(),
      });
    }
    const { perModel } = cases.get(desc);
    if (!perModel.has(label)) {
      perModel.set(label, {
        passes: 0,
        n: 0,
        errors: 0,
        calls: 0,
        reasons: new Set(),
        tools: new Set(),
      });
    }
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
    const executed = executedToolCalls(r.response);
    const calls = executed.length;
    m.calls += calls;
    c.calls += calls;
    for (const call of executed) c.tools.add(call.name);
    if (r.success) {
      m.passes++;
      c.passes++;
    } else if (hitToolLimit) {
      c.reasons.add("hit max_tool_calls");
    } else if (r.gradingResult?.reason) {
      c.reasons.add(r.gradingResult.reason);
    }
  }

  const modelStats = [...models].map(([label, m]) => {
    const price = PRICES[m.id];
    const sorted = [...m.latencies].sort((a, b) => a - b);
    return {
      label,
      graded: m.graded,
      passes: m.passes,
      errors: m.errors,
      // No graded runs means no data, not a certain 0%.
      rate: m.graded ? m.passes / m.graded : null,
      interval: m.graded ? wilson(m.passes, m.graded) : null,
      callsPerRun: m.graded ? m.calls / m.graded : null,
      input: m.input,
      output: m.output,
      cost: price ? (m.input * price.input + m.output * price.output) / 1e6 : null,
      p50Ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    };
  });

  const caseStats = [...cases].map(([desc, { query, spec, perModel }]) => ({
    desc,
    query,
    spec,
    results: Object.fromEntries(
      [...perModel].map(([label, c]) => [
        label,
        {
          passes: c.passes,
          graded: c.n,
          errors: c.errors,
          callsPerRun: c.n ? c.calls / c.n : null,
          status: caseStatus(c),
          reasons: [...c.reasons],
        },
      ]),
    ),
  }));

  const labels = [...models.keys()];
  const everyCase = [...cases.values()];
  const toolNames = new Set([
    ...knownTools,
    ...everyCase.flatMap((c) => [...c.needed, ...[...c.perModel.values()].flatMap((m) => [...m.tools])]),
  ]);
  const casesWhere = (test) => everyCase.filter(test).length;
  const toolStats = [...toolNames]
    .map((name) => ({
      name,
      neededBy: casesWhere((c) => c.needed.has(name)),
      calledIn: Object.fromEntries(
        labels.map((label) => [label, casesWhere((c) => c.perModel.get(label)?.tools.has(name))]),
      ),
    }))
    .sort((a, b) => b.neededBy - a.neededBy || a.name.localeCompare(b.name));

  return {
    run: {
      title: data.config?.description ?? "Eval report",
      timestamp: data.results?.timestamp ?? null,
      promptfooVersion: data.metadata?.promptfooVersion ?? null,
      repeats: lastRepeat + 1,
    },
    models: modelStats,
    cases: caseStats,
    tools: toolStats,
    totalCost: modelStats.reduce((sum, m) => sum + (m.cost ?? 0), 0),
  };
}
