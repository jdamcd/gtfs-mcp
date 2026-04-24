/**
 * Multi-system campaign runner for gtfs-mcp. Not in CI — hits real GTFS feeds.
 *
 * Modes:
 *   --smoke                              Phase 0 on every configured system, concurrent
 *   --deep <id,id,...>                   Phase 0-6 on the listed systems, sequentially
 *   --probe <id> --phase <n>             Single phase on a single system
 *   --chain <id> [--anchor "Central"]    Deterministic cross-tool chain for one system
 *
 * Writes per-call JSON to `campaign-results/<system_id>/phase<N>/<tool>.json`,
 * a per-system `invariants.json`, plus a top-level `summary.json` / `invariants-summary.json`.
 * Per-call errors are captured so one bad feed doesn't nuke the run.
 *
 *   GTFS_MCP_CONFIG=./config.testing.json npx tsx scripts/campaign.ts --smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type AppConfig, type SystemConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import {
  createRunContext,
  runInvariants,
  type CallRecord,
  type RunContext,
  type Violation,
} from "./invariants.js";

const RESULTS_ROOT = "campaign-results";
const PHASES = [0, 1, 2, 3, 4, 5, 6] as const;
type Phase = (typeof PHASES)[number];
type Subdir = `phase${Phase}` | "phase_chain";

type TrackedCallRecord = CallRecord & { violations?: Violation[] };
type TrackedViolation = Violation & {
  system_id: string;
  subdir: Subdir;
  tool: string;
  args: Record<string, unknown>;
};

type Tracker = {
  ctx: RunContext | null;
  collected: TrackedViolation[];
};

async function connectClient(config: AppConfig): Promise<Client> {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "campaign", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function extractJson(result: any): unknown {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// 10 minutes — covers cold imports of VBB/Renfe/SNCF/PID on a slow link. The
// MCP SDK default is 60s, which fires mid-import on anything big.
const CALL_TIMEOUT_MS = 600_000;

async function callTool(
  client: Client,
  tool: string,
  args: Record<string, unknown>
): Promise<CallRecord> {
  const start = Date.now();
  try {
    const result = await client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS }
    );
    return {
      tool,
      args,
      ok: true,
      ms: Date.now() - start,
      result: extractJson(result),
    };
  } catch (err) {
    return {
      tool,
      args,
      ok: false,
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function writeCall(systemId: string, subdir: Subdir, name: string, record: CallRecord): void {
  const dir = join(RESULTS_ROOT, systemId, subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(record, null, 2));
}

function dbSize(dataDir: string, systemId: string): number | null {
  const path = join(dataDir, systemId, "gtfs.db");
  return existsSync(path) ? statSync(path).size : null;
}

type PhaseRunner = (
  name: string,
  tool: string,
  args: Record<string, unknown>
) => Promise<TrackedCallRecord>;

function phaseRunner(
  client: Client,
  system: SystemConfig,
  subdir: Subdir,
  tracker: Tracker
): PhaseRunner {
  return async (name, tool, args) => {
    const rec = await callTool(client, tool, args);
    const violations = tracker.ctx ? runInvariants(rec, tracker.ctx) : [];
    const out: TrackedCallRecord =
      violations.length > 0 ? { ...rec, violations } : rec;
    for (const v of violations) {
      tracker.collected.push({ ...v, system_id: system.id, subdir, tool, args });
    }
    writeCall(system.id, subdir, name, out);
    return out;
  };
}

// ---------- Phase 0: smoke / setup sanity ----------

type SmokeRow = {
  system_id: string;
  system_name: string;
  ok: boolean;
  import_ms: number;
  db_bytes: number | null;
  route_count: number | null;
  stop_count: number | null;
  feeds: Record<string, string> | null;
  error: string | null;
};

async function phase0(
  client: Client,
  system: SystemConfig,
  dataDir: string,
  tracker: Tracker
): Promise<SmokeRow> {
  const run = phaseRunner(client, system, "phase0", tracker);
  const record = await run("get_system_status", "get_system_status", { system: system.id });

  // The tool wraps import/fetch errors in a textResponse rather than throwing,
  // so `record.ok=true` isn't enough — only a JSON payload with route_count
  // counts as a real success.
  const payload = record.result;
  const isRealSuccess =
    record.ok && typeof payload === "object" && payload != null && "route_count" in payload;
  const data = isRealSuccess ? (payload as any) : null;
  const toolError = !isRealSuccess && typeof payload === "string" ? payload : null;

  return {
    system_id: system.id,
    system_name: system.name,
    ok: isRealSuccess,
    import_ms: record.ms,
    db_bytes: dbSize(dataDir, system.id),
    route_count: data?.route_count ?? null,
    stop_count: data?.stop_count ?? null,
    feeds: data?.feeds ?? null,
    error: isRealSuccess ? null : (record.error ?? toolError ?? "unknown error"),
  };
}

// ---------- Phase 1: static data shape ----------

async function phase1(client: Client, system: SystemConfig, tracker: Tracker): Promise<void> {
  const run = phaseRunner(client, system, "phase1", tracker);
  const all = await run("list_routes_all", "list_routes", { system: system.id });

  const routes = (all.result as any[] | undefined) ?? [];
  const routeTypes = Array.from(new Set(routes.map((r) => r.type).filter((t) => t != null)));

  for (const routeType of routeTypes) {
    await run(`list_routes_type${routeType}`, "list_routes", {
      system: system.id,
      route_type: routeType,
    });
  }

  await run("search_stops_central", "search_stops", {
    system: system.id,
    query: "Central",
    limit: 10,
  });
}

// ---------- Phase 2: route navigation ----------

async function phase2(client: Client, system: SystemConfig, tracker: Tracker): Promise<void> {
  const run = phaseRunner(client, system, "phase2", tracker);
  const listResult = await run("list_routes", "list_routes", { system: system.id });
  const routes = (listResult.result as any[] | undefined) ?? [];

  // Pick up to 3 routes spanning distinct route_types.
  const seenTypes = new Set<number>();
  const sample: any[] = [];
  for (const r of routes) {
    if (sample.length >= 3) break;
    if (seenTypes.has(r.type)) continue;
    seenTypes.add(r.type);
    sample.push(r);
  }

  for (const r of sample) {
    for (const direction of [0, 1]) {
      const rec = await run(
        `get_route_${safe(r.route_id)}_dir${direction}`,
        "get_route",
        { system: system.id, route_id: r.route_id, direction_id: direction },
      );

      const stops = (rec.result as any)?.stops as any[] | undefined;
      const firstStop = stops?.[0]?.stop_id;
      if (firstStop) {
        await run(
          `get_stop_${safe(firstStop)}_from_${safe(r.route_id)}_dir${direction}`,
          "get_stop",
          { system: system.id, stop_id: firstStop },
        );
      }
    }
  }
}

// ---------- Phase 3: arrivals + realtime fusion ----------

async function phase3(client: Client, system: SystemConfig, tracker: Tracker): Promise<void> {
  const run = phaseRunner(client, system, "phase3", tracker);
  const listResult = await run("list_routes", "list_routes", { system: system.id });
  const routes = (listResult.result as any[] | undefined) ?? [];
  const firstRoute = routes[0];
  if (!firstRoute) {
    writeCall(system.id, "phase3", "skipped_no_routes", {
      tool: "n/a", args: {}, ok: false, ms: 0, error: "no routes in system",
    });
    return;
  }

  const routeRec = await run(
    `get_route_${safe(firstRoute.route_id)}`,
    "get_route",
    { system: system.id, route_id: firstRoute.route_id },
  );

  const stops = (routeRec.result as any)?.stops as any[] | undefined;
  const candidateStops = stops?.slice(0, 3) ?? [];

  for (const s of candidateStops) {
    await run(
      `get_arrivals_${safe(s.stop_id)}_unfiltered`,
      "get_arrivals",
      { system: system.id, stop_id: s.stop_id, limit: 10 },
    );
    await run(
      `get_arrivals_${safe(s.stop_id)}_route_${safe(firstRoute.route_id)}`,
      "get_arrivals",
      { system: system.id, stop_id: s.stop_id, route_id: firstRoute.route_id, limit: 10 },
    );
  }

  // If the first stop has a parent_station, also try the parent to exercise resolveStopIds.
  const firstStopDetail = await run(
    "get_stop_detail_for_parent_check",
    "get_stop",
    { system: system.id, stop_id: candidateStops[0]?.stop_id ?? "" },
  );
  const parent = (firstStopDetail.result as any)?.stop?.parent_station;
  if (parent) {
    await run(
      `get_arrivals_parent_${safe(parent)}`,
      "get_arrivals",
      { system: system.id, stop_id: parent, limit: 10 },
    );
  }
}

// ---------- Phase 4: alerts ----------

async function phase4(client: Client, system: SystemConfig, tracker: Tracker): Promise<void> {
  const run = phaseRunner(client, system, "phase4", tracker);
  const unfiltered = await run("get_alerts_unfiltered", "get_alerts", { system: system.id });

  const alerts = (unfiltered.result as any[] | undefined) ?? [];
  const firstRouteInAlert = alerts
    .flatMap((a) => a.informed_entities ?? [])
    .map((e: any) => e.route_id)
    .find((r: unknown) => typeof r === "string");

  if (firstRouteInAlert) {
    await run(
      `get_alerts_route_${safe(firstRouteInAlert)}`,
      "get_alerts",
      { system: system.id, route_id: firstRouteInAlert },
    );
  }
}

// ---------- Phase 5: vehicles ----------

async function phase5(client: Client, system: SystemConfig, tracker: Tracker): Promise<void> {
  if (system.realtime.vehicle_positions.length === 0) {
    writeCall(system.id, "phase5", "skipped_no_vp_feed", {
      tool: "n/a", args: {}, ok: true, ms: 0, result: "no vehicle_positions configured",
    });
    return;
  }

  const run = phaseRunner(client, system, "phase5", tracker);
  const unfiltered = await run("get_vehicles_unfiltered", "get_vehicles", { system: system.id });

  const vehicles = (unfiltered.result as any[] | undefined) ?? [];
  const firstRouteId = vehicles.map((v) => v.route_id).find((r: unknown) => typeof r === "string");
  if (firstRouteId) {
    await run(
      `get_vehicles_route_${safe(firstRouteId)}`,
      "get_vehicles",
      { system: system.id, route_id: firstRouteId },
    );
  }
}

// ---------- Phase 6: trips ----------

async function phase6(client: Client, system: SystemConfig, tracker: Tracker): Promise<void> {
  const run = phaseRunner(client, system, "phase6", tracker);
  const listResult = await run("list_routes", "list_routes", { system: system.id });
  const routes = (listResult.result as any[] | undefined) ?? [];
  const firstRoute = routes[0];
  if (!firstRoute) return;

  const routeRec = await run(
    `get_route_${safe(firstRoute.route_id)}`,
    "get_route",
    { system: system.id, route_id: firstRoute.route_id },
  );
  const firstStop = (routeRec.result as any)?.stops?.[0]?.stop_id;
  if (!firstStop) return;

  const arrivals = await run(
    "get_arrivals_for_trip_pick",
    "get_arrivals",
    { system: system.id, stop_id: firstStop, limit: 5 },
  );

  const tripId = (arrivals.result as any[] | undefined)?.[0]?.trip_id;
  if (!tripId) {
    writeCall(system.id, "phase6", "skipped_no_trip_id", {
      tool: "n/a", args: {}, ok: false, ms: 0, error: "no arrivals returned a trip_id",
    });
    return;
  }

  await run(`get_trip_${safe(tripId)}`, "get_trip", { system: system.id, trip_id: tripId });
}

// ---------- chain mode: cross-tool flow ----------

async function runChainFlow(
  client: Client,
  system: SystemConfig,
  anchor: string,
  tracker: Tracker
): Promise<void> {
  const run = phaseRunner(client, system, "phase_chain", tracker);

  const search = await run("01_search_stops", "search_stops", {
    system: system.id,
    query: anchor,
    limit: 5,
  });
  const stops = (search.result as any[] | undefined) ?? [];
  if (stops.length === 0) {
    console.error(`  chain: no stops matched anchor "${anchor}", aborting`);
    return;
  }
  const firstStop = stops[0].stop_id;

  await run("02_get_stop", "get_stop", { system: system.id, stop_id: firstStop });
  await run("03_list_routes", "list_routes", { system: system.id });

  const arrivals = await run("04_get_arrivals", "get_arrivals", {
    system: system.id,
    stop_id: firstStop,
    limit: 5,
  });
  const firstArrival = (arrivals.result as any[] | undefined)?.[0];
  const arrTripId: string | undefined = firstArrival?.trip_id;
  const arrRouteId: string | undefined = firstArrival?.route_id;

  if (arrTripId) {
    const trip = await run("05_get_trip", "get_trip", {
      system: system.id,
      trip_id: arrTripId,
    });
    const firstTripStop =
      typeof trip.result === "object" && trip.result
        ? (trip.result as any).stop_times?.[0]?.stop_id
        : null;
    if (typeof firstTripStop === "string") {
      await run("06_get_stop_from_trip", "get_stop", {
        system: system.id,
        stop_id: firstTripStop,
      });
    }
  }

  if (arrRouteId) {
    await run("07_get_route", "get_route", { system: system.id, route_id: arrRouteId });
  }
}

// ---------- phase dispatcher ----------

async function runPhase(
  phase: Phase,
  client: Client,
  system: SystemConfig,
  dataDir: string,
  tracker: Tracker,
): Promise<void> {
  switch (phase) {
    case 0: await phase0(client, system, dataDir, tracker); return;
    case 1: await phase1(client, system, tracker); return;
    case 2: await phase2(client, system, tracker); return;
    case 3: await phase3(client, system, tracker); return;
    case 4: await phase4(client, system, tracker); return;
    case 5: await phase5(client, system, tracker); return;
    case 6: await phase6(client, system, tracker); return;
  }
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

function writeSystemInvariants(systemId: string, violations: TrackedViolation[]): void {
  mkdirSync(join(RESULTS_ROOT, systemId), { recursive: true });
  writeFileSync(
    join(RESULTS_ROOT, systemId, "invariants.json"),
    JSON.stringify(violations, null, 2),
  );
}

function summariseViolations(all: TrackedViolation[]): Array<{
  rule: string;
  severity: string;
  count: number;
  systems: string[];
}> {
  const byRule = new Map<string, TrackedViolation[]>();
  for (const v of all) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule)!.push(v);
  }
  return [...byRule.entries()]
    .map(([rule, vs]) => ({
      rule,
      severity: vs[0].severity,
      count: vs.length,
      systems: [...new Set(vs.map((v) => v.system_id))],
    }))
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
      return b.count - a.count;
    });
}

function printViolationSummary(all: TrackedViolation[]): void {
  if (all.length === 0) {
    console.error("");
    console.error("invariants: 0 violations");
    return;
  }
  const rows = summariseViolations(all);
  console.error("");
  console.error("rule           sev    count  systems");
  console.error("-------------- ------ ------ ----------------------------------");
  for (const r of rows) {
    const systems = r.systems.slice(0, 3).join(", ") + (r.systems.length > 3 ? ", …" : "");
    console.error(
      `${r.rule.padEnd(14)} ${r.severity.padEnd(6)} ${String(r.count).padStart(6)} ${systems}`
    );
  }
}

function errorCount(all: TrackedViolation[]): number {
  return all.filter((v) => v.severity === "error").length;
}

// ---------- modes ----------

async function runSmoke(config: AppConfig): Promise<void> {
  console.error(`[campaign] Smoke pass over ${config.systems.length} systems`);

  // One shared client is fine — createServer builds a systems map internally
  // and each tool call routes by system_id. Cap concurrency to avoid saturating
  // the network pipe; the first smoke run with 22-way parallel pushed most
  // large imports past the gtfs package's internal download timeout.
  const client = await connectClient(config);
  const rows: SmokeRow[] = [];
  const queue = [...config.systems];
  const concurrency = 4;
  const tracker: Tracker = { ctx: null, collected: [] };

  async function worker(): Promise<void> {
    while (queue.length) {
      const s = queue.shift();
      if (!s) return;
      console.error(`[campaign] phase0 start: ${s.id}`);
      try {
        const row = await phase0(client, s, config.data_dir, tracker);
        rows.push(row);
        console.error(`[campaign] phase0 ${row.ok ? "ok" : "fail"}: ${s.id} (${row.import_ms}ms)`);
      } catch (err) {
        rows.push({
          system_id: s.id,
          system_name: s.name,
          ok: false,
          import_ms: 0,
          db_bytes: null,
          route_count: null,
          stop_count: null,
          feeds: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const order = new Map(config.systems.map((s, i) => [s.id, i]));
  rows.sort((a, b) => order.get(a.system_id)! - order.get(b.system_id)!);

  mkdirSync(RESULTS_ROOT, { recursive: true });
  writeFileSync(join(RESULTS_ROOT, "summary.json"), JSON.stringify(rows, null, 2));

  console.error("");
  console.error("system_id              ok   import_ms  routes   stops   db_bytes");
  console.error("---------------------- ---- ---------- -------- ------- ----------");
  for (const r of rows) {
    const line =
      `${r.system_id.padEnd(22)} ` +
      `${(r.ok ? "PASS" : "FAIL").padEnd(4)} ` +
      `${String(r.import_ms).padStart(10)} ` +
      `${String(r.route_count ?? "-").padStart(8)} ` +
      `${String(r.stop_count ?? "-").padStart(7)} ` +
      `${String(r.db_bytes ?? "-").padStart(10)}`;
    console.error(line);
    if (!r.ok && r.error) console.error(`                       err: ${r.error}`);
  }
}

async function runDeep(config: AppConfig, ids: string[]): Promise<number> {
  const unknown = ids.filter((id) => !config.systems.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown system ids: ${unknown.join(", ")}`);

  const client = await connectClient(config);
  const pointers = config.systems.map((s) => ({ id: s.id, name: s.name }));
  const aggregate: TrackedViolation[] = [];

  for (const id of ids) {
    const system = config.systems.find((s) => s.id === id)!;
    console.error(`[campaign] Deep pass: ${id}`);
    const tracker: Tracker = {
      ctx: createRunContext(id, pointers),
      collected: [],
    };
    for (const phase of PHASES) {
      console.error(`  phase ${phase}...`);
      try {
        await runPhase(phase, client, system, config.data_dir, tracker);
      } catch (err) {
        console.error(`  phase ${phase} threw:`, err);
      }
    }
    writeSystemInvariants(id, tracker.collected);
    aggregate.push(...tracker.collected);
  }

  mkdirSync(RESULTS_ROOT, { recursive: true });
  writeFileSync(
    join(RESULTS_ROOT, "invariants-summary.json"),
    JSON.stringify(summariseViolations(aggregate), null, 2),
  );
  printViolationSummary(aggregate);
  return errorCount(aggregate);
}

async function runProbe(config: AppConfig, id: string, phase: Phase): Promise<number> {
  const system = config.systems.find((s) => s.id === id);
  if (!system) throw new Error(`Unknown system id: ${id}`);
  const client = await connectClient(config);
  const pointers = config.systems.map((s) => ({ id: s.id, name: s.name }));
  const tracker: Tracker = { ctx: createRunContext(id, pointers), collected: [] };
  console.error(`[campaign] Probe ${id} phase ${phase}`);
  await runPhase(phase, client, system, config.data_dir, tracker);
  writeSystemInvariants(id, tracker.collected);
  printViolationSummary(tracker.collected);
  return errorCount(tracker.collected);
}

async function runChain(config: AppConfig, id: string, anchor: string): Promise<number> {
  const system = config.systems.find((s) => s.id === id);
  if (!system) throw new Error(`Unknown system id: ${id}`);
  const client = await connectClient(config);
  const pointers = config.systems.map((s) => ({ id: s.id, name: s.name }));
  const tracker: Tracker = { ctx: createRunContext(id, pointers), collected: [] };
  console.error(`[campaign] Chain ${id} anchor="${anchor}"`);
  await runChainFlow(client, system, anchor, tracker);
  writeSystemInvariants(id, tracker.collected);
  printViolationSummary(tracker.collected);
  return errorCount(tracker.collected);
}

// ---------- entry point ----------

type ParsedArgs =
  | { mode: "smoke" }
  | { mode: "deep"; deepIds: string[] }
  | { mode: "probe"; probeId: string; probePhase: Phase }
  | { mode: "chain"; chainId: string; anchor: string };

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.includes("--smoke")) return { mode: "smoke" };

  const deepIdx = argv.indexOf("--deep");
  if (deepIdx >= 0) {
    const csv = argv[deepIdx + 1];
    if (!csv) throw new Error("--deep needs a comma-separated list of system ids");
    return {
      mode: "deep",
      deepIds: csv.split(",").map((s) => s.trim()).filter(Boolean),
    };
  }

  const probeIdx = argv.indexOf("--probe");
  if (probeIdx >= 0) {
    const id = argv[probeIdx + 1];
    const phaseIdx = argv.indexOf("--phase");
    const phaseRaw = phaseIdx >= 0 ? argv[phaseIdx + 1] : undefined;
    const phase = phaseRaw != null ? Number(phaseRaw) : NaN;
    if (!id) throw new Error("--probe needs a system id");
    if (!PHASES.includes(phase as Phase)) {
      throw new Error(`--phase must be one of ${PHASES.join(", ")}`);
    }
    return { mode: "probe", probeId: id, probePhase: phase as Phase };
  }

  const chainIdx = argv.indexOf("--chain");
  if (chainIdx >= 0) {
    const id = argv[chainIdx + 1];
    if (!id) throw new Error("--chain needs a system id");
    const anchorIdx = argv.indexOf("--anchor");
    const anchor = anchorIdx >= 0 ? argv[anchorIdx + 1] : "Central";
    return { mode: "chain", chainId: id, anchor: anchor ?? "Central" };
  }

  throw new Error(
    "Usage: campaign.ts (--smoke | --deep <ids> | --probe <id> --phase <n> | --chain <id> [--anchor <q>])"
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  console.error(`[campaign] Loaded ${config.systems.length} systems from ${process.env.GTFS_MCP_CONFIG}`);

  let errors = 0;
  if (args.mode === "smoke") await runSmoke(config);
  else if (args.mode === "deep") errors = await runDeep(config, args.deepIds);
  else if (args.mode === "probe") errors = await runProbe(config, args.probeId, args.probePhase);
  else errors = await runChain(config, args.chainId, args.anchor);

  console.error("[campaign] Done");
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[campaign] Fatal:", err);
  process.exit(1);
});
