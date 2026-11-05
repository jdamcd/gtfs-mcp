import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const MCP_PATH = "/mcp";
// Real requests are tool calls with a few short arguments: a few hundred bytes.
const MAX_BODY_BYTES = 256 * 1024;
// Over MAX_BODY_BYTES the rest of the body is read and discarded rather than
// buffered. Closing the socket mid-upload would give the client a connection
// reset instead of the 413. Past this ceiling the connection is dropped.
const MAX_DRAIN_BYTES = 8 * MAX_BODY_BYTES;

function parseEnvList(value: string | undefined): string[] | null {
  if (!value) return null;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

function buildLocalDefaults(port: number): { hosts: string[]; origins: string[] } {
  return {
    hosts: [`127.0.0.1:${port}`, `localhost:${port}`, "127.0.0.1", "localhost"],
    origins: [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://127.0.0.1",
      "http://localhost",
    ],
  };
}

export interface HttpMcpServer {
  httpServer: Server;
  close: () => Promise<void>;
}

/**
 * HTTP server for the MCP Streamable HTTP transport.
 *
 * Stateless: the SDK handler builds a fresh McpServer per request. The
 * wrapper enforces the spec's DNS-rebinding mitigations (Origin + Host
 * validation, single endpoint path) and a body cap before delegating,
 * since the handler checks neither. Override the default localhost-only
 * allow lists with MCP_ALLOWED_HOSTS / MCP_ALLOWED_ORIGINS env vars
 * (comma-separated) — only safe paired with an external auth layer.
 */
export function createHttpMcpServer(config: AppConfig): HttpMcpServer {
  const hostsOverride = parseEnvList(process.env.MCP_ALLOWED_HOSTS);
  const originsOverride = parseEnvList(process.env.MCP_ALLOWED_ORIGINS);
  let cachedDefaults: { hosts: string[]; origins: string[] } | undefined;

  const handler = createMcpHandler(() => createServer(config));
  const handleMcpRequest = toNodeHandler(handler);

  function getDefaults(port: number) {
    if (!cachedDefaults) cachedDefaults = buildLocalDefaults(port);
    return cachedDefaults;
  }

  function isAllowedHost(host: string | undefined, port: number): boolean {
    if (!host) return false;
    if (hostsOverride?.includes("*")) return true;
    return (hostsOverride ?? getDefaults(port).hosts).includes(host);
  }

  function isAllowedOrigin(origin: string | undefined, port: number): boolean {
    // Non-browser MCP clients (Claude Desktop, etc.) omit Origin; only
    // browser-driven requests carry one and only those are DNS-rebinding targets.
    if (origin === undefined) return true;
    if (originsOverride?.includes("*")) return true;
    return (originsOverride ?? getDefaults(port).origins).includes(origin);
  }

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const localPort = req.socket.localPort ?? 0;

    const pathname = (req.url ?? "/").split("?", 1)[0];
    if (pathname !== MCP_PATH) {
      res.writeHead(404).end("Not Found");
      return;
    }

    const origin = req.headers.origin;
    if (!isAllowedOrigin(typeof origin === "string" ? origin : undefined, localPort)) {
      res.writeHead(403).end("Forbidden: origin not allowed");
      return;
    }
    if (!isAllowedHost(req.headers.host, localPort)) {
      res.writeHead(403).end("Forbidden: host not allowed");
      return;
    }

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        totalBytes += buf.length;
        if (totalBytes > MAX_DRAIN_BYTES) {
          req.socket.destroy();
          return;
        }
        if (totalBytes > MAX_BODY_BYTES) {
          chunks.length = 0;
          continue;
        }
        chunks.push(buf);
      }
      if (totalBytes > MAX_BODY_BYTES) {
        res.setHeader("Connection", "close");
        res.writeHead(413).end("Payload Too Large");
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400).end("Bad Request: invalid JSON");
        return;
      }

      // Pass the parsed body: the adapter would otherwise re-read the drained stream.
      await handleMcpRequest(req, res, body);
    } else if (req.method === "GET" || req.method === "DELETE") {
      // 2025-era session verbs. Serving is stateless, so the handler answers 405.
      await handleMcpRequest(req, res);
    } else {
      res.writeHead(405).end("Method Not Allowed");
    }
  });

  return { httpServer, close: () => handler.close() };
}

export async function startHttpServer(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "127.0.0.1";

  console.error(
    `[gtfs-mcp] Loaded config with ${config.systems.length} system(s): ${config.systems.map((s) => s.id).join(", ")}`,
  );

  const { httpServer, close } = createHttpMcpServer(config);

  httpServer.listen(port, host, () => {
    console.error(
      `[gtfs-mcp] Server started on HTTP transport at http://${host}:${port}${MCP_PATH}`,
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[gtfs-mcp] Received ${signal}, shutting down...`);
    await close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
