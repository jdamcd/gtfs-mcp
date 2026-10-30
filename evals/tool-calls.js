// promptfoo runs the MCP tool loop itself and records each call it executed,
// in order, on the response metadata. We grade those rather than the output
// text: the final answer only describes what the model did, and a substring
// match can hit text the model wrote about a tool it never actually called.

/**
 * @returns {{ name: string, input: Record<string, unknown>, isError: boolean }[]}
 */
export function executedToolCalls(providerResponse) {
  const calls = providerResponse?.metadata?.toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls
    .filter((c) => typeof c?.name === "string")
    .map((c) => ({ name: c.name, input: c.input ?? {}, isError: Boolean(c.is_error) }));
}

const COORD_TOLERANCE = 1e-4;

function valueMatches(actual, expected) {
  if (typeof expected === "number") {
    const n = typeof actual === "number" ? actual : Number(actual);
    return Number.isFinite(n) && Math.abs(n - expected) <= COORD_TOLERANCE;
  }
  return actual === expected;
}

function callMatches(call, spec) {
  if (call.name !== spec.tool) return false;
  return Object.entries(spec.input ?? {}).every(([key, expected]) =>
    valueMatches(call.input[key], expected),
  );
}

function describeSpec(spec) {
  const input = spec.input ? ` ${JSON.stringify(spec.input)}` : "";
  return `${spec.tool}${input}`;
}

function describeCall(call) {
  return `${call.name} ${JSON.stringify(call.input)}${call.isError ? " (error)" : ""}`;
}

/**
 * Spec format (the source of truth for promptfooconfig.yaml's metadata.expect):
 *
 * spec.require: list of requirements, all of which must hold. Each is either
 *   { tool, input? } or { anyOf: [{ tool, input? }, ...] }. `input` lists
 *   argument values that must match exactly (numbers within a small tolerance).
 *   A call the tool rejected still counts: the model chose correctly.
 * spec.order: list of [first, then] tool-name pairs. `then` must not be called
 *   before `first` has been, e.g. to check an ID was looked up, not guessed.
 *   Holds trivially if `then` is never called; use require to make it required.
 * spec.noTools: if true, the response must not call any tool.
 *
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
export function gradeToolCalls(calls, spec) {
  const called = calls.length ? calls.map(describeCall).join(" → ") : "(none)";
  const failures = [];

  if (spec.noTools && calls.length > 0) {
    failures.push("expected no tool calls");
  }
  for (const req of spec.require ?? []) {
    const options = req.anyOf ?? [req];
    if (!calls.some((call) => options.some((opt) => callMatches(call, opt)))) {
      failures.push(`missing ${options.map(describeSpec).join(" or ")}`);
    }
  }
  for (const [first, then] of spec.order ?? []) {
    const firstAt = calls.findIndex((call) => call.name === first);
    const thenAt = calls.findIndex((call) => call.name === then);
    if (thenAt !== -1 && (firstAt === -1 || thenAt < firstAt)) {
      failures.push(`${then} before ${first}`);
    }
  }

  const pass = failures.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `Called: ${called}`
      : `${failures.join("; ")}. Called: ${called}`,
  };
}

/**
 * Specs live in test metadata rather than per-assertion config so one
 * defaultTest assertion covers every case and each case only declares what it
 * expects.
 */
export function assertToolCalls(output, context) {
  const spec = context?.test?.metadata?.expect;
  if (!spec) {
    // Fail loudly: a case without a spec would otherwise pass vacuously.
    return { pass: false, score: 0, reason: "Test case has no metadata.expect" };
  }
  const finishReason = context?.providerResponse?.finishReason;
  if (finishReason === "content_filter") {
    return { pass: false, score: 0, reason: "Model refused the request" };
  }
  if (finishReason === "length") {
    // Thinking used up max_tokens before the model finished its turn. Name it
    // so it isn't mistaken for a wrong tool choice.
    return { pass: false, score: 0, reason: "Response hit max_tokens before finishing" };
  }
  return gradeToolCalls(executedToolCalls(context?.providerResponse), spec);
}
