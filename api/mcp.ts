// @ts-nocheck
declare const process: any;
declare const Buffer: any;

type IncomingMessage = any;
type ServerResponse = any;

import {
  getSheetMetadata,
  gogToolManifest,
  getGoogleAccountsFromEnv,
  readGoogleDoc,
  readSheetRange,
  writeSheetRange,
  searchDriveFiles,
} from '../custom-tools/google-gog/server';

const PROTOCOL_VERSION = '2024-11-05';

type JsonRpcRequest = {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function json(res: ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function requireGoogleAccounts() {
  const accounts = getGoogleAccountsFromEnv();
  if (!accounts.length) {
    throw new Error(
      'Missing Google OAuth credentials. Connect at least one account using GOOGLECLIENTID/GOOGLECLIENTSECRET/GOOGLEREFRESHTOKEN, GOOGLECLIENTID_PRO/GOOGLECLIENTSECRET_PRO/GOOGLEREFRESHTOKEN_PRO, GOOGLECLIENTID_PERSONAL/GOOGLECLIENTSECRET_PERSONAL/GOOGLEREFRESHTOKEN_PERSONAL, or the underscore variants GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID_PRO/GOOGLE_CLIENT_SECRET_PRO/GOOGLE_REFRESH_TOKEN_PRO, GOOGLE_CLIENT_ID_PERSONAL/GOOGLE_CLIENT_SECRET_PERSONAL/GOOGLE_REFRESH_TOKEN_PERSONAL.',
    );
  }
  return accounts;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: any[] = [];
  for await (const chunk of req as any) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks as any).toString('utf8');
  if (!String(raw as any).trim()) return null;
  return JSON.parse(raw);
}

function toolSchemas() {
  return (gogToolManifest as any).map((tool: any) => {
    switch (tool.name) {
      case 'google_drive_search_files':
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              pageSize: { type: 'number' },
              driveId: { type: 'string' },
              mimeTypes: { type: 'array', items: { type: 'string' } },
              includeTrashed: { type: 'boolean' },
            },
            required: ['query'],
            additionalProperties: false,
          },
        };
      case 'google_docs_read':
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: { documentId: { type: 'string' } },
            required: ['documentId'],
            additionalProperties: false,
          },
        };
      case 'google_sheets_get_metadata':
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: { spreadsheetId: { type: 'string' } },
            required: ['spreadsheetId'],
            additionalProperties: false,
          },
        };
      case 'google_sheets_read_range':
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: {
              spreadsheetId: { type: 'string' },
              range: { type: 'string' },
              valueRenderOption: {
                type: 'string',
                enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'],
              },
            },
            required: ['spreadsheetId', 'range'],
            additionalProperties: false,
          },
        };
      case 'google_sheets_write_range':
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: {
              spreadsheetId: { type: 'string' },
              range: { type: 'string' },
              values: { type: 'array', items: { type: 'array' } },
              valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'] },
            },
            required: ['spreadsheetId', 'range', 'values'],
            additionalProperties: false,
          },
        };
      default:
        return { name: tool.name, description: tool.description, inputSchema: {} };
    }
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    if ((req.method ?? 'GET').toUpperCase() === 'GET') {
      json(res, 200, {
        name: 'google-gog',
        status: 'ok',
        endpoint: '/api/mcp',
        transport: 'json-rpc-over-http',
        capabilities: { tools: true },
      });
      return;
    }

    if ((req.method ?? 'POST').toUpperCase() !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = (await readJsonBody(req)) as JsonRpcRequest | JsonRpcRequest[] | null;

    if (!body) {
      json(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }

    const handleRequest = async (request: JsonRpcRequest) => {
      const id = request.id ?? null;
      const method = request.method ?? '';

      if (request.jsonrpc !== '2.0') {
        return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
      }

      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              serverInfo: {
                name: 'google-gog',
                version: String((process as any)?.env?.VERCEL_GIT_COMMIT_SHA as any ?? '0.1.0').slice(0, 7),
              },
              capabilities: { tools: {} },
            },
          };

        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: toolSchemas() } };

        case 'tools/call': {
          const name = String((request.params as any)?.name ?? '');
          const args = ((request.params as any)?.arguments ?? {}) as Record<string, unknown>;
          const config = requireGoogleAccounts();

          switch (name) {
            case 'google_drive_search_files': {
              const result = await searchDriveFiles(config, {
                query: String((args as any).query ?? ''),
                pageSize: (args as any).pageSize ? Number((args as any).pageSize) : undefined,
                driveId: typeof (args as any).driveId === 'string' ? (args as any).driveId : undefined,
                mimeTypes: Array.isArray((args as any).mimeTypes) ? ((args as any).mimeTypes as any[]).map(String) : undefined,
                includeTrashed: Boolean((args as any).includeTrashed),
              });
              return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
            }
            case 'google_docs_read': {
              const result = await readGoogleDoc(config, String((args as any).documentId ?? ''));
              return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
            }
            case 'google_sheets_get_metadata': {
              const result = await getSheetMetadata(config, String((args as any).spreadsheetId ?? ''));
              return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
            }
            case 'google_sheets_read_range': {
              const valueRenderOption =
                (args as any).valueRenderOption === 'UNFORMATTED_VALUE' || (args as any).valueRenderOption === 'FORMULA'
                  ? ((args as any).valueRenderOption as any)
                  : 'FORMATTED_VALUE';
              const result = await readSheetRange(
                config,
                String((args as any).spreadsheetId ?? ''),
                String((args as any).range ?? ''),
                valueRenderOption,
              );
              return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
            }
            case 'google_sheets_write_range': {
              const valueInputOption = (args as any).valueInputOption === 'RAW' ? 'RAW' : 'USER_ENTERED';
              const values = Array.isArray((args as any).values) ? ((args as any).values as any[][]) : [];
              const result = await writeSheetRange(
                config,
                String((args as any).spreadsheetId ?? ''),
                String((args as any).range ?? ''),
                values,
                valueInputOption,
              );
              return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
            }
            default:
              return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
          }
        }

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };

        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    };

    if (Array.isArray(body)) {
      json(res, 200, await Promise.all(body.map((request) => handleRequest(request))));
      return;
    }

    json(res, 200, await handleRequest(body));
  } catch (error) {
    json(res, 500, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
    });
  }
}
