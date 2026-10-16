// promptfoo's Anthropic provider renders a response containing tool_use blocks
// as its content blocks joined by blank lines, with each tool_use block as a
// single-line JSON object. We parse those blocks rather than substring-matching
// the raw output: newer models may escape tool inputs differently, and a
// substring match can also hit text the model wrote about a tool it never
// actually called.

/**
 * @param {unknown} output
 * @returns {{ name: string, input: Record<string, unknown> }[]}
 */
export function parseToolCalls(output) {
  if (typeof output !== "string") return [];
  const calls = [];
  for (const chunk of output.split("\n\n")) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith("{")) continue;
    let block;
    try {
      block = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (block?.type === "tool_use" && typeof block.name === "string") {
      calls.push({ name: block.name, input: block.input ?? {} });
    }
  }
  return calls;
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

/**
 * Spec format (the source of truth for promptfooconfig.yaml's metadata.expect):
 *
 * spec.require: list of requirements, all of which must hold. Each is either
 *   { tool, input? } or { anyOf: [{ tool, input? }, ...] }. `input` lists
 *   argument values that must match exactly (numbers within a small tolerance).
 * spec.forbid: tool names that must not be called.
 * spec.noTools: if true, the response must not call any tool.
 *
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
export function gradeToolCalls(output, spec) {
  const calls = parseToolCalls(output);
  const called = calls.length
    ? calls.map((c) => `${c.name} ${JSON.stringify(c.input)}`).join("; ")
    : "(none)";
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
  for (const name of spec.forbid ?? []) {
    if (calls.some((call) => call.name === name)) {
      failures.push(`unexpected ${name}`);
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
    // Thinking used up max_tokens before the model got to its tool calls.
    // Name it so it isn't mistaken for a wrong tool choice.
    return { pass: false, score: 0, reason: "Response hit max_tokens before finishing" };
  }
  return gradeToolCalls(output, spec);
}
