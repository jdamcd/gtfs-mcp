import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module used by promptfoo
import {
  assertToolCalls,
  describeExpectations,
  executedToolCalls,
  gradeToolCalls,
  neededTools,
} from "../evals/tool-calls.js";
// @ts-expect-error -- plain JS module used by promptfoo
import { summarize, wilson } from "../evals/summarize.js";
// @ts-expect-error -- plain JS module used by promptfoo
import { renderHtml, renderText } from "../evals/report.js";

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

  it("matches null only when the argument is left out", () => {
    const spec = { require: [{ tool: "get_route", input: { route_id: "1", direction_id: null } }] };
    expect(gradeToolCalls([call("get_route", { route_id: "1" })], spec).pass).toBe(true);
    expect(gradeToolCalls([call("get_route", { route_id: "1", direction_id: 0 })], spec).pass).toBe(false);
  });

  it("supports anyOf and noTools", () => {
    const calls = [call("list_routes"), call("get_stop")];
    expect(gradeToolCalls(calls, { require: [{ anyOf: [{ tool: "get_route" }, { tool: "list_routes" }] }] }).pass).toBe(true);
    expect(gradeToolCalls(calls, { noTools: true }).pass).toBe(false);
    expect(gradeToolCalls([], { noTools: true }).pass).toBe(true);
  });

  it("supports only", () => {
    const spec = { only: ["list_systems"] };
    expect(gradeToolCalls([], spec).pass).toBe(true);
    expect(gradeToolCalls([call("list_systems")], spec).pass).toBe(true);

    const wandered = gradeToolCalls([call("list_systems"), call("search_stops"), call("search_stops")], spec);
    expect(wandered.pass).toBe(false);
    expect(wandered.reason).toContain("also called search_stops.");
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

describe("neededTools", () => {
  it("needs a tool named by a requirement, or by every alternative of one", () => {
    const needed = neededTools({
      require: [
        { tool: "get_alerts" },
        { anyOf: [{ tool: "get_route", input: { direction_id: 0 } }, { tool: "get_route" }] },
        { anyOf: [{ tool: "search_stops" }, { tool: "find_nearby_stops" }] },
      ],
    });
    expect([...needed].sort()).toEqual(["get_alerts", "get_route"]);
  });

  it("follows order rules back from a needed tool, however they are listed", () => {
    const needed = neededTools({
      require: [{ tool: "get_trip" }],
      order: [
        ["list_systems", "search_stops"],
        ["get_arrivals", "get_trip"],
        ["search_stops", "get_arrivals"],
        ["list_routes", "get_route"],
      ],
    });
    expect([...needed].sort()).toEqual(["get_arrivals", "get_trip", "list_systems", "search_stops"]);
  });

  it("needs nothing when the case has no requirements", () => {
    expect(neededTools({ noTools: true }).size).toBe(0);
    expect(neededTools(undefined).size).toBe(0);
  });
});

describe("describeExpectations", () => {
  it("phrases each rule of a case's spec", () => {
    expect(
      describeExpectations({
        only: ["list_systems", "get_route"],
        require: [
          { tool: "get_alerts" },
          { anyOf: [{ tool: "get_route", input: { route_id: "1", direction_id: 0 } }, { tool: "get_route", input: { direction_id: null } }] },
        ],
        order: [["list_routes", "get_route"]],
      }),
    ).toEqual([
      "calls nothing but list_systems, get_route",
      "calls get_alerts",
      'calls get_route with route_id "1", direction_id 0, or get_route with no direction_id',
      "doesn't call get_route before list_routes",
    ]);
    expect(describeExpectations({ noTools: true })).toEqual(["calls no tools"]);
    expect(describeExpectations({ system: "test", require: [{ tool: "get_stop" }] })).toEqual([
      "calls get_stop",
      'uses system "test" for those calls',
    ]);
    // The system only qualifies required calls, so alone it checks nothing.
    expect(describeExpectations({ system: "test", only: ["list_systems"] })).toEqual([
      "calls nothing but list_systems",
    ]);
    expect(describeExpectations(null)).toEqual([]);
  });
});

const evalRow = ({
  label = "haiku",
  desc = "A",
  success = true,
  reason = "",
  tools = [] as string[],
  expect = undefined as object | undefined,
} = {}) => ({
  provider: { id: `anthropic:messages:claude-${label}-5-5`, label },
  testCase: { description: desc, metadata: { expect } },
  success,
  failureReason: success ? 0 : 1,
  gradingResult: success ? { pass: true } : { pass: false, reason },
  response: {
    tokenUsage: { prompt: 1000, completion: 100 },
    metadata: { toolCalls: tools.map((name) => ({ name, input: {} })) },
  },
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
    const summary = summarize({
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
    const model = (label: string) => summary.models.find((m: { label: string }) => m.label === label);
    expect(model("haiku")).toMatchObject({ rate: 0.5, graded: 2, errors: 1 });
    // No graded runs means no data, not a certain 0%.
    expect(model("sonnet")).toMatchObject({ rate: null, interval: null, graded: 0, errors: 1 });
    expect(summary.cases[0].results.haiku).toMatchObject({
      passes: 1,
      graded: 2,
      errors: 1,
      status: "inconsistent",
      reasons: ["missing get_stop"],
    });
  });

  it("reports mean tool calls over graded runs", () => {
    const row = (calls: number, error?: string) => ({
      provider: { id: "anthropic:messages:claude-haiku-5-5", label: "haiku" },
      testCase: { description: "A" },
      success: !error,
      failureReason: error ? 2 : 0,
      gradingResult: error ? null : { pass: true },
      error,
      response: {
        tokenUsage: { prompt: 1000, completion: 100 },
        ...(calls ? { metadata: { toolCalls: Array.from({ length: calls }, () => ({ name: "get_stop", input: {} })) } } : {}),
      },
    });
    const summary = summarize({
      results: { results: [row(3), row(0), row(9, "429")] },
    });
    // Exclude errored runs
    expect(summary.models[0]).toMatchObject({ rate: 1, graded: 2, errors: 1, callsPerRun: 1.5 });
    expect(summary.cases[0].results.haiku).toMatchObject({ passes: 2, graded: 2, errors: 1, callsPerRun: 1.5 });
  });

  it("grades hitting max_tool_calls as a failure, not an error", () => {
    const summary = summarize({
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
    expect(summary.models[0]).toMatchObject({ rate: 0, graded: 1, errors: 0 });
    expect(summary.cases[0].results.haiku).toMatchObject({
      status: "failed",
      reasons: ["hit max_tool_calls"],
    });
  });

  it("counts the cases that need each tool and the cases where it was called", () => {
    const viaRoutes = { require: [{ tool: "get_route" }], order: [["list_routes", "get_route"]] };
    const summary = summarize(
      {
        results: {
          results: [
            evalRow({ desc: "A", tools: ["list_systems", "list_routes", "get_route"], expect: viaRoutes }),
            evalRow({ desc: "A", tools: ["list_systems", "get_route"], expect: viaRoutes }),
            evalRow({ desc: "B", tools: ["list_systems", "get_stop"], expect: { require: [{ tool: "get_stop" }] } }),
          ],
        },
      },
      ["get_trip"],
    );
    expect(summary.tools).toEqual([
      { name: "get_route", neededBy: 1, calledIn: { haiku: 1 } },
      { name: "get_stop", neededBy: 1, calledIn: { haiku: 1 } },
      { name: "list_routes", neededBy: 1, calledIn: { haiku: 1 } },
      { name: "get_trip", neededBy: 0, calledIn: { haiku: 0 } },
      { name: "list_systems", neededBy: 0, calledIn: { haiku: 2 } },
    ]);
  });
});

describe("report", () => {
  const failed = (desc: string, reason: string) => evalRow({ desc, success: false, reason });
  const summary = summarize({
    config: { description: "Tools <eval>" },
    results: {
      results: [
        failed("Stops & routes", 'Called: search_stops {"query":"<b>"}'),
        failed("Stops & routes", 'Called: search_stops {"query":"<b>"}'),
        evalRow({ desc: "Alerts" }),
        failed("Alerts", "missing get_alerts"),
        evalRow({ label: "opus", desc: "Stops & routes" }),
        evalRow({ label: "opus", desc: "Alerts" }),
      ],
    },
  });

  it("keeps the terminal output to a line per model and per failing case", () => {
    expect(renderText(summary).split("\n")).toEqual([
      "haiku  1/4 passed (25.0%)",
      "opus   2/2 passed (100.0%)",
      "Failed every run: Stops & routes (haiku)",
      "Inconsistent: Alerts (haiku, 1/2)",
      "Estimated cost: $0.01",
    ]);
  });

  it("escapes text taken from the results file", () => {
    const html = renderHtml(summary);
    expect(html).toContain("<title>Tools &lt;eval&gt;</title>");
    expect(html).toContain('<th scope="row">Stops &amp; routes</th>');
    expect(html).toContain("<dd>Called: search_stops {&quot;query&quot;:&quot;&lt;b&gt;&quot;}</dd>");
    expect(html).not.toContain("<b>");
  });

  it("shows a whole mean of tool calls without a decimal", () => {
    const calls = (desc: string, n: number) => evalRow({ desc, tools: Array(n).fill("get_stop") });
    const html = renderHtml(
      summarize({
        results: {
          results: [calls("A", 1), calls("A", 1), calls("B", 4), calls("B", 4), calls("C", 1), calls("C", 2)],
        },
      }),
    );
    expect(html).toContain(">1 call<");
    expect(html).toContain(">4 calls<");
    expect(html).toContain(">1.5 calls<");
  });

  it("lets a case open to show its query and what it checks", () => {
    const html = renderHtml(
      summarize({
        results: {
          results: [
            { ...evalRow({ desc: "A & B", expect: { require: [{ tool: "get_stop" }] } }), vars: { query: "Where is <here>?" } },
          ],
        },
      }),
    );
    expect(html).toContain(
      '<details><summary>A &amp; B</summary><div class="about"><div class="aside">Query</div><p>Where is &lt;here&gt;?</p><div class="aside">Passes when the model</div><ul><li>calls get_stop</li></ul></div></details>',
    );
  });

  it("flags a tool that no case needs", () => {
    const html = renderHtml(summarize({ results: { results: [evalRow()] } }, ["get_trip"]));
    expect(html).toMatch(/<code>get_trip<\/code><\/th>\s*<td class="num"><span class="badge warning" role="img" aria-label="No case needs it"/);
  });

  it("marks failed and inconsistent cells and leaves passed ones plain", () => {
    const html = renderHtml(summary);
    expect(html).toMatch(/<td class="critical">.*aria-label="Failed every run".*?0\/2/);
    expect(html).toMatch(/<td class="warning">.*aria-label="Passed some runs".*?1\/2/);
    expect(html).toMatch(/<td><div class="cell"><span class="mark"><\/span>/);
  });
});
