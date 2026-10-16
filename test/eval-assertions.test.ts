import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module used by promptfoo
import { assertToolCalls, gradeToolCalls, parseToolCalls } from "../evals/tool-calls.js";
// @ts-expect-error -- plain JS module used by promptfoo
import { summarize, wilson } from "../evals/summarize.js";

// Mirrors how promptfoo's Anthropic provider renders a response with tool use:
// text blocks verbatim, tool_use blocks as JSON, joined by blank lines.
function render(...blocks: Array<string | { name: string; input: object }>): string {
  return blocks
    .map((b) =>
      typeof b === "string"
        ? b
        : JSON.stringify({ type: "tool_use", id: "toolu_1", name: b.name, input: b.input }),
    )
    .join("\n\n");
}

describe("parseToolCalls", () => {
  it("extracts tool_use blocks and ignores text", () => {
    const output = render(
      "Let me check get_stop for you.",
      { name: "get_arrivals", input: { system: "mta-subway", stop_id: "127N" } },
    );
    expect(parseToolCalls(output)).toEqual([
      { name: "get_arrivals", input: { system: "mta-subway", stop_id: "127N" } },
    ]);
  });

  it("handles escaped characters in tool inputs", () => {
    const output = '{"type":"tool_use","id":"t","name":"search_stops","input":{"query":"Times Sq\\u002f42 St"}}';
    expect(parseToolCalls(output)[0].input.query).toBe("Times Sq/42 St");
  });

  it("returns no calls for non-string output", () => {
    expect(parseToolCalls(undefined)).toEqual([]);
  });
});

describe("gradeToolCalls", () => {
  it("requires matching tool and input", () => {
    const output = render({ name: "get_stop", input: { stop_id: "127S" } });
    const result = gradeToolCalls(output, { require: [{ tool: "get_stop", input: { stop_id: "127N" } }] });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("missing get_stop");
  });

  it("does not pass on a tool name that only appears in text", () => {
    const output = "I would call get_alerts, but I won't.";
    expect(gradeToolCalls(output, { require: [{ tool: "get_alerts" }] }).pass).toBe(false);
  });

  it("compares numbers with a tolerance and accepts numeric strings", () => {
    const output = render({ name: "find_nearby_stops", input: { lat: "40.7580", lon: -73.98551 } });
    const spec = { require: [{ tool: "find_nearby_stops", input: { lat: 40.758, lon: -73.9855 } }] };
    expect(gradeToolCalls(output, spec).pass).toBe(true);
  });

  it("supports anyOf, forbid and noTools", () => {
    const output = render({ name: "list_routes", input: {} }, { name: "get_stop", input: {} });
    expect(gradeToolCalls(output, { require: [{ anyOf: [{ tool: "get_route" }, { tool: "list_routes" }] }] }).pass).toBe(true);
    expect(gradeToolCalls(output, { forbid: ["get_stop"] }).pass).toBe(false);
    expect(gradeToolCalls(output, { noTools: true }).pass).toBe(false);
    expect(gradeToolCalls("It's sunny.", { noTools: true }).pass).toBe(true);
  });
});

describe("assertToolCalls", () => {
  it("fails a case with no spec instead of passing vacuously", () => {
    expect(assertToolCalls("", { test: {} }).pass).toBe(false);
  });

  it("fails refusals", () => {
    const context = {
      test: { metadata: { expect: { noTools: true } } },
      providerResponse: { finishReason: "content_filter" },
    };
    expect(assertToolCalls("", context).pass).toBe(false);
  });
});

describe("summarize", () => {
  it("computes a Wilson interval", () => {
    const [lo, hi] = wilson(9, 10);
    expect(lo).toBeCloseTo(0.596, 2);
    expect(hi).toBeCloseTo(0.982, 2);
  });

  it("excludes provider errors from pass rates and flags inconsistent cases", () => {
    const row = (label: string, desc: string, success: boolean, failureReason = success ? 0 : 1) => ({
      provider: { id: `anthropic:messages:claude-${label}-5-5`, label },
      testCase: { description: desc },
      success,
      failureReason,
      gradingResult: success ? { pass: true } : { pass: false, reason: "missing get_stop" },
      response: { tokenUsage: { prompt: 1000, completion: 100 } },
      latencyMs: 1000,
    });
    const report = summarize({
      results: {
        results: [
          row("haiku", "A", true),
          row("haiku", "A", false),
          { ...row("haiku", "A", false, 2), gradingResult: null, error: "429" },
          row("opus", "A", true),
        ],
      },
    });
    expect(report).toContain("| haiku | 50.0% |");
    expect(report).toContain("1/2 ⚠️ (+1 err)");
    expect(report).toContain("missing get_stop");
  });
});
