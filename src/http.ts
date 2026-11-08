import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

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
  closeAllSessions: () => Promise<void>;
}

/**
 * HTTP server for the MCP Streamable HTTP transport.
 *
 * Each client session gets its own McpServer and transport instance. The
 * wrapper enforces the spec's DNS-rebinding mitigations (Origin + Host
 * validation, single endpoint path) before delegating to the SDK transport.
 * Override the default localhost-only allow lists with MCP_ALLOWED_HOSTS /
 * MCP_ALLOWED_ORIGINS env vars (comma-separated) — only safe paired with
 * an external auth layer.
 */
export function createHttpMcpServer(config: AppConfig): HttpMcpServer {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const hostsOverride = parseEnvList(process.env.MCP_ALLOWED_HOSTS);
  const originsOverride = parseEnvList(process.env.MCP_ALLOWED_ORIGINS);
  let cachedDefaults: { hosts: string[]; origins: string[] } | undefined;

  function getDefaults(port: number) {
    if (!cachedDefaults) cachedDefaults = buildLocalDefaults(port);
    return cachedDefaults;
  }

  function isAllowedHost(host: string | undefined, port: number): boolean {
    if (!host) return false;
    return (hostsOverride ?? getDefaults(port).hosts).includes(host);
  }

  function isAllowedOrigin(origin: string | undefined, port: number): boolean {
    // Non-browser MCP clients (Claude Desktop, etc.) omit Origin; only
    // browser-driven requests carry one and only those are DNS-rebinding targets.
    if (origin === undefined) return true;
    return (originsOverride ?? getDefaults(port).origins).includes(origin);
  }

  function resolveSession(
    sessionId: string | undefined,
    res: ServerResponse,
  ): StreamableHTTPServerTransport | null {
    if (!sessionId) {
      res.writeHead(400).end("Bad Request: missing session ID");
      return null;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.writeHead(404).end("Not Found: unknown session ID");
      return null;
    }
    return transport;
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
        if (totalBytes > MAX_BODY_BYTES) {
          res.setHeader("Connection", "close");
          res.writeHead(413).end("Payload Too Large");
          return;
        }
        chunks.push(buf);
      }

      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400).end("Bad Request: invalid JSON");
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      const isInitialize =
        !sessionId &&
        (Array.isArray(body)
          ? body.some(
              (m: { method?: string }) => m.method === "initialize",
            )
          : (body as { method?: string }).method === "initialize");

      if (isInitialize) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
            console.error(`[gtfs-mcp] HTTP session created: ${id}`);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            console.error(
              `[gtfs-mcp] HTTP session closed: ${transport.sessionId}`,
            );
          }
        };

        const server = createServer(config);
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      const transport = resolveSession(sessionId, res);
      if (!transport) return;
      await transport.handleRequest(req, res, body);
    } else if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const transport = resolveSession(sessionId, res);
      if (!transport) return;
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(405).end("Method Not Allowed");
    }
  });

  async function closeAllSessions(): Promise<void> {
    const closes = Array.from(sessions.values()).map((t) => t.close());
    sessions.clear();
    await Promise.all(closes);
  }

  return { httpServer, closeAllSessions };
}

export async function startHttpServer(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "127.0.0.1";

  console.error(
    `[gtfs-mcp] Loaded config with ${config.systems.length} system(s): ${config.systems.map((s) => s.id).join(", ")}`,
  );

  const { httpServer, closeAllSessions } = createHttpMcpServer(config);

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
    await closeAllSessions();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
