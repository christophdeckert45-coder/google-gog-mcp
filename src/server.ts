/**
 * MCP Server — Entry Point
 *
 * Wires together the three layers:
 *   Policy    → tool schemas and manifest
 *   Orchestration → tool handlers
 *   Execution → Google API clients
 *
 * Supports two transports:
 *   - stdio  (default) — for local MCP clients (Claude Desktop, Cursor, etc.)
 *   - http   — for remote MCP clients (Poke, etc.)
 *
 * Usage:
 *   npx tsx src/server.ts              # stdio transport
 *   npx tsx src/server.ts --http       # HTTP transport on PORT (default 8080)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import http from "node:http";

import { TOOL_MANIFEST } from "./policy/index.js";
import {
  handleDriveSearch,
  handleDocsRead,
  handleSheetsGetMetadata,
  handleSheetsReadRange,
  handleSheetsExport,
} from "./orchestration/index.js";
import { getAuthenticatedClient } from "./auth/oauth.js";
import { DriveClient, DocsClient, SheetsClient } from "./execution/index.js";

const SERVER_NAME = "poke-google-workspace";
const SERVER_VERSION = "1.0.0";

async function createServer(): Promise<McpServer> {
  // Authenticate with Google.
  console.error("Authenticating with Google...");
  const authClient = await getAuthenticatedClient();
  console.error("Authenticated successfully.");

  // Create execution-layer clients.
  const driveClient = new DriveClient(authClient);
  const docsClient = new DocsClient(driveClient);
  const sheetsClient = new SheetsClient(authClient, driveClient);

  // Create MCP server.
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register tools from the policy manifest.
  const m = TOOL_MANIFEST;

  server.tool(
    m.drive_search.name,
    m.drive_search.description,
    m.drive_search.schema.shape,
    async (input) => handleDriveSearch(driveClient, input)
  );

  server.tool(
    m.docs_read.name,
    m.docs_read.description,
    m.docs_read.schema.shape,
    async (input) => handleDocsRead(docsClient, input)
  );

  server.tool(
    m.sheets_get_metadata.name,
    m.sheets_get_metadata.description,
    m.sheets_get_metadata.schema.shape,
    async (input) => handleSheetsGetMetadata(sheetsClient, input)
  );

  server.tool(
    m.sheets_read_range.name,
    m.sheets_read_range.description,
    m.sheets_read_range.schema.shape,
    async (input) => handleSheetsReadRange(sheetsClient, input)
  );

  server.tool(
    m.sheets_export.name,
    m.sheets_export.description,
    m.sheets_export.schema.shape,
    async (input) => handleSheetsExport(sheetsClient, input)
  );

  return server;
}

// ──────────────────────────────────────────────
// Transport selection
// ──────────────────────────────────────────────

async function runStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

async function runHttp(server: McpServer): Promise<void> {
  const port = parseInt(process.env.PORT ?? "8080", 10);
  const activeSessions = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for Poke and other remote clients.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // Health check.
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    // SSE endpoint — client connects here for server-to-client messages.
    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      activeSessions.set(transport.sessionId, transport);

      res.on("close", () => {
        activeSessions.delete(transport.sessionId);
      });

      await server.connect(transport);
      return;
    }

    // Message endpoint — client POSTs JSON-RPC messages here.
    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !activeSessions.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing sessionId" }));
        return;
      }

      const transport = activeSessions.get(sessionId)!;
      await transport.handlePostMessage(req, res);
      return;
    }

    // 404 for everything else.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.error(
      `${SERVER_NAME} v${SERVER_VERSION} running on http://0.0.0.0:${port}`
    );
    console.error(`  SSE endpoint:     http://localhost:${port}/sse`);
    console.error(`  Message endpoint: http://localhost:${port}/messages`);
    console.error(`  Health check:     http://localhost:${port}/health`);
  });
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main(): Promise<void> {
  const useHttp = process.argv.includes("--http");
  const server = await createServer();

  if (useHttp) {
    await runHttp(server);
  } else {
    await runStdio(server);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
