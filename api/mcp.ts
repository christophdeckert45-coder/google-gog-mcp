import type { IncomingMessage, ServerResponse } from "http";
import {
  getSheetMetadata,
  gogToolManifest,
  readGoogleDoc,
  readSheetRange,
  searchDriveFiles,
} from "../custom-tools/google-gog/server";

const PROTOCOL_VERSION = "2024-11-05";

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function json(res: ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getGoogleConfig() {
  const googleClientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? "";
  const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI;

  return { googleClientId, googleClientSecret, googleRefreshToken, googleRedirectUri };
}

function requireGoogleConfig() {
  const config = getGoogleConfig();
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN. Connect Google OAuth using the primary account chris@everyday.inc.",
    );
  }
  return config;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function toolSchemas() {
  return gogToolManifest.map((tool) => {
    switch (tool.name) {
      case "google_drive_search_files":
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              pageSize: { type: "number" },
              driveId: { type: "string" },
              mimeTypes: { type: "array", items: { type: "string" } },
              includeTrashed: { type: "boolean" },
            },
            required: ["query"],
            additionalProperties: false,
          },
        };
      case "google_docs_read":
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: "object",
            properties: { documentId: { type: "string" } },
            required: ["documentId"],
            additionalProperties: false,
          },
        };
      case "google_sheets_get_metadata":
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: "object",
            properties: { spreadsheetId: { type: "string" } },
            required: ["spreadsheetId"],
            additionalProperties: false,
          },
        };
      case "google_sheets_read_range":
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: "object",
            properties: {
              spreadsheetId: { type: "string" },
              range: { type: "string" },
              valueRenderOption: {
                type: "string",
                enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
              },
            },
            required: ["spreadsheetId", "range"],
            additionalProperties: false,
          },
        };
    }
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    if ((req.method ?? "GET").toUpperCase() === "GET") {
      json(res, 200, {
        name: "google-gog",
        status: "ok",
        endpoint: "/api/mcp",
        transport: "json-rpc-over-http",
        capabilities: { tools: true },
      });
      return;
    }

    if ((req.method ?? "POST").toUpperCase() !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return;
    }

    const body = (await readJsonBody(req)) as JsonRpcRequest | JsonRpcRequest[] | null;

    if (!body) {
      json(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }

    const handleRequest = async (request: JsonRpcRequest) => {
      const id = request.id ?? null;
      const method = request.method ?? "";

      if (request.jsonrpc !== "2.0") {
        return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
      }

      switch (method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              serverInfo: {
                name: "google-gog",
                version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "0.1.0",
              },
              capabilities: { tools: {} },
            },
          };

        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: toolSchemas() } };

        case "tools/call": {
          const name = String(request.params?.name ?? "");
          const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
          const config = requireGoogleConfig();

          switch (name) {
            case "google_drive_search_files": {
              const result = await searchDriveFiles(config, {
                query: String(args.query ?? ""),
                pageSize: args.pageSize ? Number(args.pageSize) : undefined,
                driveId: typeof args.driveId === "string" ? args.driveId : undefined,
                mimeTypes: Array.isArray(args.mimeTypes) ? args.mimeTypes.map(String) : undefined,
                includeTrashed: Boolean(args.includeTrashed),
              });
              return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
            }
            case "google_docs_read": {
              const result = await readGoogleDoc(config, String(args.documentId ?? ""));
              return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
            }
            case "google_sheets_get_metadata": {
              const result = await getSheetMetadata(config, String(args.spreadsheetId ?? ""));
              return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
            }
            case "google_sheets_read_range": {
              const valueRenderOption =
                args.valueRenderOption === "UNFORMATTED_VALUE" || args.valueRenderOption === "FORMULA"
                  ? (args.valueRenderOption as "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA")
                  : "FORMATTED_VALUE";
              const result = await readSheetRange(
                config,
                String(args.spreadsheetId ?? ""),
                String(args.range ?? ""),
                valueRenderOption,
              );
              return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
            }
            default:
              return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } };
          }
        }

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    };

    if (Array.isArray(body)) {
      json(res, 200, await Promise.all(body.map((request) => handleRequest(request))));
      return;
    }

    json(res, 200, await handleRequest(body));
  } catch (error) {
    json(res, 500, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" },
    });
  }
}
