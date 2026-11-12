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
  if (expected === null) return actual == null;
  if (typeof expected === "number") {
    const n = typeof actual === "number" ? actual : Number(actual);
    return Number.isFinite(n) && Math.abs(n - expected) <= COORD_TOLERANCE;
  }
  return actual === expected;
}

function callMatches(call, spec, system) {
  if (call.name !== spec.tool) return false;
  if (system !== undefined && "system" in call.input && call.input.system !== system) return false;
  return Object.entries(spec.input ?? {}).every(([key, expected]) =>
    valueMatches(call.input[key], expected),
  );
}

const optionsOf = (requirement) => requirement.anyOf ?? [requirement];

// The tools a case can't pass without calling. An anyOf only needs a tool
// when every alternative is that tool, and an order rule makes its first tool
// needed once its second is.
export function neededTools(spec) {
  const needed = new Set();
  for (const req of spec?.require ?? []) {
    const [tool, ...others] = new Set(optionsOf(req).map((option) => option.tool));
    if (!others.length) needed.add(tool);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [first, then] of spec?.order ?? []) {
      if (needed.has(then) && !needed.has(first)) {
        needed.add(first);
        grew = true;
      }
    }
  }
  return needed;
}

function describeOption({ tool, input }) {
  const args = Object.entries(input ?? {}).map(([key, value]) =>
    value === null ? `no ${key}` : `${key} ${JSON.stringify(value)}`,
  );
  return args.length ? `${tool} with ${args.join(", ")}` : tool;
}

// What a case checks, as phrases that each complete "The model ...".
export function describeExpectations(spec) {
  const lines = [];
  if (spec?.noTools) lines.push("calls no tools");
  if (spec?.only) lines.push(`calls nothing but ${spec.only.join(", ")}`);
  for (const req of spec?.require ?? []) {
    lines.push(`calls ${optionsOf(req).map(describeOption).join(", or ")}`);
  }
  if (spec?.system && spec.require?.length) {
    lines.push(`uses system ${JSON.stringify(spec.system)} for those calls`);
  }
  for (const [first, then] of spec?.order ?? []) {
    lines.push(`doesn't call ${then} before ${first}`);
  }
  return lines;
}

// The spec a case is graded against: its expectations plus the system that
// defaultTest sets once for every case.
export function caseSpec(metadata) {
  return metadata?.expect ? { system: metadata.system, ...metadata.expect } : null;
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
 *   `null` means the argument must be left out.
 *   A call the tool rejected still counts: the model chose correctly.
 * spec.system: if set, a call made with a different `system` doesn't satisfy
 *   a requirement, so a guessed system ID can't pass. caseSpec fills it
 *   from metadata.system, which defaultTest sets once for every case.
 * spec.order: list of [first, then] tool-name pairs. `then` must not be called
 *   before `first` has been, e.g. to check an ID was looked up, not guessed.
 *   Holds trivially if `then` is never called; use require to make it required.
 * spec.noTools: if true, the response must not call any tool.
 * spec.only: list of tool names. Every call must be to one of them.
 *
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
export function gradeToolCalls(calls, spec) {
  const called = calls.length ? calls.map(describeCall).join(" → ") : "(none)";
  const failures = [];

  if (spec.noTools && calls.length > 0) {
    failures.push("expected no tool calls");
  }
  if (spec.only) {
    const unexpected = [...new Set(calls.map((call) => call.name))].filter((name) => !spec.only.includes(name));
    if (unexpected.length) failures.push(`only ${spec.only.join(", ")} expected, also called ${unexpected.join(", ")}`);
  }
  for (const req of spec.require ?? []) {
    const options = optionsOf(req);
    if (!calls.some((call) => options.some((opt) => callMatches(call, opt, spec.system)))) {
      failures.push(`missing ${options.map(describeOption).join(", or ")}`);
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
  const spec = caseSpec(context?.test?.metadata);
  if (!spec) {
    // Fail loudly: a case without a spec would otherwise pass vacuously.
    return { pass: false, score: 0, reason: "Test case has no metadata.expect" };
  }
  const finishReason = context?.providerResponse?.finishReason;
  if (finishReason === "content_filter") {
    return { pass: false, score: 0, reason: "Model refused the request" };
  }
  const result = gradeToolCalls(executedToolCalls(context?.providerResponse), spec);
  // Running out of tokens while writing the final answer doesn't matter if
  // the calls were right. When they weren't, name it so it isn't mistaken for
  // a wrong tool choice.
  if (!result.pass && finishReason === "length") {
    return { ...result, reason: `Response hit max_tokens before finishing. ${result.reason}` };
  }
  return result;
}
