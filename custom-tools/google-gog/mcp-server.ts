import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  getSheetMetadata,
  gogToolManifest,
  readGoogleDoc,
  readSheetRange,
  searchDriveFiles,
  type GoogleGogConfig,
} from "./server.js";

type ToolName = (typeof gogToolManifest)[number]["name"];

export interface GoogleGogServerConfig extends GoogleGogConfig {
  serverName?: string;
  serverVersion?: string;
}

export function createGoogleGogServer(config: GoogleGogServerConfig) {
  const server = new Server(
    {
      name: config.serverName ?? "google-gog",
      version: config.serverVersion ?? "0.1.0",
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: gogToolManifest.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolInputSchemas[tool.name],
    })),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params as { name: ToolName; arguments?: Record<string, unknown> };

    switch (name) {
      case "google_drive_search_files":
        return textResult(await searchDriveFiles(config, {
          query: String(args?.query ?? ""),
          pageSize: args?.pageSize ? Number(args.pageSize) : undefined,
          driveId: typeof args?.driveId === "string" ? args.driveId : undefined,
          mimeTypes: Array.isArray(args?.mimeTypes) ? args.mimeTypes.map(String) : undefined,
          includeTrashed: Boolean(args?.includeTrashed),
        }));
      case "google_docs_read":
        return textResult(await readGoogleDoc(config, String(args?.documentId ?? "")));
      case "google_sheets_get_metadata":
        return textResult(await getSheetMetadata(config, String(args?.spreadsheetId ?? "")));
      case "google_sheets_read_range": {
        const valueRenderOption =
          args?.valueRenderOption === "UNFORMATTED_VALUE" || args?.valueRenderOption === "FORMULA"
            ? (args.valueRenderOption as "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA")
            : "FORMATTED_VALUE";
        return textResult(
          await readSheetRange(config, String(args?.spreadsheetId ?? ""), String(args?.range ?? ""), valueRenderOption),
        );
      }
      default:
        throw new Error(`Unsupported tool: ${name}`);
    }
  });

  return server;
}

export async function runGoogleGogServer(config: GoogleGogServerConfig) {
  const server = createGoogleGogServer(config);
  await server.connect(new StdioServerTransport());
}

function textResult(result: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

const toolInputSchemas: Record<ToolName, Record<string, unknown>> = {
  google_drive_search_files: {
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
  google_docs_read: {
    type: "object",
    properties: { documentId: { type: "string" } },
    required: ["documentId"],
    additionalProperties: false,
  },
  google_sheets_get_metadata: {
    type: "object",
    properties: { spreadsheetId: { type: "string" } },
    required: ["spreadsheetId"],
    additionalProperties: false,
  },
  google_sheets_read_range: {
    type: "object",
    properties: {
      spreadsheetId: { type: "string" },
      range: { type: "string" },
      valueRenderOption: { type: "string", enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"] },
    },
    required: ["spreadsheetId", "range"],
    additionalProperties: false,
  },
};

if (import.meta.main) {
  const config = {
    googleClientId: process.env.GOOGLECLIENTID ?? "",
    googleClientSecret: process.env.GOOGLECLIENTSECRET ?? "",
    googleRefreshToken: process.env.GOOGLEREFRESHTOKEN ?? "",
    googleRedirectUri: process.env.GOOGLEREDIRECTURI,
    serverName: process.env.MCP_SERVER_NAME,
    serverVersion: process.env.MCP_SERVER_VERSION,
  } satisfies GoogleGogServerConfig;

  if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) {
    throw new Error("Missing GOOGLECLIENTID, GOOGLECLIENTSECRET, or GOOGLEREFRESHTOKEN. Use primary account chris@everyday.inc.");
  }

  await runGoogleGogServer(config);
}
