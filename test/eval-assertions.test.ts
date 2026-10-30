import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module used by promptfoo
import { assertToolCalls, executedToolCalls, gradeToolCalls } from "../evals/tool-calls.js";
// @ts-expect-error -- plain JS module used by promptfoo
import { summarize, wilson } from "../evals/summarize.js";

const call = (name: string, input: object = {}, isError = false) => ({ name, input, isError });

describe("executedToolCalls", () => {
  it("reads the calls promptfoo recorded on the response, in order", () => {
    const providerResponse = {
      output: "The next 1 train is due now.",
      metadata: {
        toolCalls: [
          { id: "t1", name: "search_stops", input: { query: "Fulton" }, output: "[]", is_error: false },
          { id: "t2", name: "get_trip", input: { trip_id: "x" }, output: "Trip not found", is_error: true },
        ],
      },
    };
    expect(executedToolCalls(providerResponse)).toEqual([
      call("search_stops", { query: "Fulton" }),
      call("get_trip", { trip_id: "x" }, true),
    ]);
  });

  it("returns no calls when the model answered without tools", () => {
    expect(executedToolCalls({ output: "It's sunny." })).toEqual([]);
    expect(executedToolCalls(undefined)).toEqual([]);
  });
});

describe("gradeToolCalls", () => {
  it("requires matching tool and input", () => {
    const result = gradeToolCalls([call("get_stop", { stop_id: "127S" })], {
      require: [{ tool: "get_stop", input: { stop_id: "127N" } }],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("missing get_stop");
  });

  it("counts a call the tool rejected, and marks it in the reason", () => {
    const result = gradeToolCalls([call("get_trip", { trip_id: "x" }, true)], { require: [{ tool: "get_trip" }] });
    expect(result.pass).toBe(true);
    expect(result.reason).toContain("(error)");
  });

  it("compares numbers with a tolerance and accepts numeric strings", () => {
    const calls = [call("find_nearby_stops", { lat: "40.7580", lon: -73.98551 })];
    const spec = { require: [{ tool: "find_nearby_stops", input: { lat: 40.758, lon: -73.9855 } }] };
    expect(gradeToolCalls(calls, spec).pass).toBe(true);
  });

  it("supports anyOf and noTools", () => {
    const calls = [call("list_routes"), call("get_stop")];
    expect(gradeToolCalls(calls, { require: [{ anyOf: [{ tool: "get_route" }, { tool: "list_routes" }] }] }).pass).toBe(true);
    expect(gradeToolCalls(calls, { noTools: true }).pass).toBe(false);
    expect(gradeToolCalls([], { noTools: true }).pass).toBe(true);
  });

  it("checks order across the whole loop", () => {
    const spec = { order: [["search_stops", "get_stop"]] };
    expect(gradeToolCalls([call("search_stops"), call("get_stop")], spec).pass).toBe(true);
    expect(gradeToolCalls([call("search_stops")], spec).pass).toBe(true);

    const guessed = gradeToolCalls([call("get_stop"), call("search_stops"), call("get_stop")], spec);
    expect(guessed.pass).toBe(false);
    expect(guessed.reason).toContain("get_stop before search_stops");
    expect(gradeToolCalls([call("get_stop")], spec).pass).toBe(false);
  });
});

describe("assertToolCalls", () => {
  it("grades the recorded calls, not tool names in the answer text", () => {
    const context = {
      test: { metadata: { expect: { require: [{ tool: "get_alerts" }] } } },
      providerResponse: { output: "I would call get_alerts, but I won't." },
    };
    expect(assertToolCalls("I would call get_alerts, but I won't.", context).pass).toBe(false);
  });

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

  it("names max_tokens truncation instead of reporting a wrong tool", () => {
    const context = {
      test: { metadata: { expect: { require: [{ tool: "get_alerts" }] } } },
      providerResponse: { finishReason: "length" },
    };
    expect(assertToolCalls("", context).reason).toContain("max_tokens");
  });

  it("passes when only the final answer was truncated", () => {
    const context = {
      test: { metadata: { expect: { require: [{ tool: "get_alerts" }] } } },
      providerResponse: {
        finishReason: "length",
        metadata: { toolCalls: [{ name: "get_alerts", input: { system: "mta-subway" } }] },
      },
    };
    expect(assertToolCalls("", context).pass).toBe(true);
  });

  it("doesn't count a required call made with a guessed system", () => {
    const context = (toolCalls: object[]) => ({
      test: { metadata: { system: "mta-subway", expect: { require: [{ tool: "get_arrivals", input: { stop_id: "127N" } }] } } },
      providerResponse: { metadata: { toolCalls } },
    });
    const guessed = { name: "get_arrivals", input: { system: "nyc", stop_id: "127N" }, is_error: true };
    const found = { name: "get_arrivals", input: { system: "mta-subway", stop_id: "127N" } };
    expect(assertToolCalls("", context([guessed])).pass).toBe(false);
    expect(assertToolCalls("", context([guessed, { name: "list_systems", input: {} }, found])).pass).toBe(true);
  });

  it("doesn't apply the system check to tools without a system argument", () => {
    const context = {
      test: { metadata: { system: "mta-subway", expect: { require: [{ tool: "list_systems" }] } } },
      providerResponse: { metadata: { toolCalls: [{ name: "list_systems", input: {} }] } },
    };
    expect(assertToolCalls("", context).pass).toBe(true);
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
          { ...row("sonnet", "A", false, 2), gradingResult: null, error: "429" },
        ],
      },
    });
    expect(report).toContain("| haiku | 50.0% |");
    // No graded runs means no data, not a certain 0%.
    expect(report).toContain("| sonnet | - | - | 0 | 1 |");
    expect(report).toContain("1/2 ⚠️ (+1 err)");
    expect(report).toContain("missing get_stop");
  });

  it("grades hitting max_tool_calls as a failure, not an error", () => {
    const report = summarize({
      results: {
        results: [
          {
            provider: { id: "anthropic:messages:claude-haiku-5-5", label: "haiku" },
            testCase: { description: "A" },
            success: false,
            failureReason: 2,
            gradingResult: null,
            error: "Anthropic MCP tool execution exceeded max_tool_calls=8. Increase provider config.max_tool_calls if this evaluation legitimately needs more tool calls.",
            response: { tokenUsage: { prompt: 1000, completion: 100 } },
          },
        ],
      },
    });
    expect(report).toContain("| haiku | 0.0% |");
    expect(report).toContain("0/1 ❌");
    expect(report).toContain("hit max_tool_calls");
  });
});
