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

/**
 * Creates an HTTP server that handles MCP Streamable HTTP transport.
 * Each client session gets its own McpServer and transport instance.
 */
export function createHttpMcpServer(config: AppConfig): Server {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
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

      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400).end("Bad Request: missing or invalid session ID");
        return;
      }

      await sessions.get(sessionId)!.handleRequest(req, res, body);
    } else if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400).end("Bad Request: missing or invalid session ID");
        return;
      }
      await sessions.get(sessionId)!.handleRequest(req, res);
    } else {
      res.writeHead(405).end("Method Not Allowed");
    }
  });
}

export async function startHttpServer(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env.PORT || "3000", 10);

  console.error(
    `[gtfs-mcp] Loaded config with ${config.systems.length} system(s): ${config.systems.map((s) => s.id).join(", ")}`,
  );

  const httpServer = createHttpMcpServer(config);

  httpServer.listen(port, () => {
    console.error(
      `[gtfs-mcp] Server started on HTTP transport at http://localhost:${port}/mcp`,
    );
  });
}
