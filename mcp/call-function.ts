// @ts-nocheck
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const RPC_URL = "http://127.0.0.1:7123/rpc";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

interface AudioContent {
  type: "audio";
  data: string;
  mimeType: string;
}

interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

interface EmbeddedResourceContent {
  type: "resource";
  resource: { uri: string; mimeType?: string; text?: string; blob?: string };
}

type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLinkContent
  | EmbeddedResourceContent;

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function shouldRetryWithAlias(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Unknown MCP connection|invalid input syntax for type uuid/i.test(message);
}

function shouldMoveToNextCandidateOnAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid_grant|token.*(expired|revoked)|expired or revoked|unauthori[sz]ed|\b401\b|\b403\b/i.test(message);
}

function extractUuidFromText(text: string): string | null {
  const m = text.match(UUID_RE);
  return m?.[0] ?? null;
}

function extractUuidsFromFilename(filename: string): string[] {
  const m = filename.match(/^google-gog-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.ts$/i);
  return m?.[1] ? [m[1]] : [];
}

async function listCurrentConnectionsViaRpc(): Promise<any | null> {
  const id = crypto.randomUUID();
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'list_connections', params: {} }),
      signal: AbortSignal.timeout(30_000),
    });
    return await res.json();
  } catch {
    return null;
  }
}

function extractGoogleGogUuidFromConnectionsPayload(payload: any): string[] {
  if (!payload) return [];

  const jsonText = (() => {
    try {
      return JSON.stringify(payload);
    } catch {
      return '';
    }
  })();

  type Candidate = { id: string; ts: number; rank: number };
  const candidates: Candidate[] = [];

  const arr = Array.isArray(payload?.result)
    ? payload.result
    : Array.isArray(payload?.connections)
      ? payload.connections
      : Array.isArray(payload?.data)
        ? payload.data
        : [];

  const toTime = (...values: unknown[]): number => {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return 0;
  };

  for (const item of arr) {
    const text = (() => {
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })().toLowerCase();

    const id = item?.id ?? item?.connection_id ?? item?.uuid ?? item?.connectionId ?? item?.connectionUUID;
    if (!isUuid(id)) continue;

    const statusText = String(item?.status ?? item?.state ?? item?.connectionStatus ?? item?.active ? 'active' : '').toLowerCase();
    const rank = /active|connected|valid/.test(statusText) && !/revoked|expired|disabled|inactive/.test(statusText) ? 1 : 0;
    candidates.push({
      id,
      ts: toTime(item?.updatedAt, item?.updated_at, item?.lastUsedAt, item?.last_used_at, item?.connectedAt, item?.connected_at, item?.createdAt, item?.created_at),
      rank,
    });
  }

  // Fallback: if the payload is nested or unstructured, harvest any UUIDs we can find.
  if (candidates.length === 0) {
    const uuids = jsonText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    for (const u of uuids.slice(0, 10)) {
      if (isUuid(u)) candidates.push({ id: u, ts: 0, rank: 0 });
    }
  }

  return candidates
    .sort((a, b) => b.rank - a.rank || b.ts - a.ts)
    .map((candidate) => candidate.id);
}

function resolveConnectionCandidatesFromFiles(): string[] {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = fs
    .readdirSync(dir)
    .filter((filename) => /^google-gog-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ts$/i.test(filename))
    .map((filename) => {
      const [uuid] = extractUuidsFromFilename(filename);
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(dir, filename)).mtimeMs;
      } catch {
        mtime = 0;
      }
      return uuid ? { uuid, mtime } : null;
    })
    .filter((entry): entry is { uuid: string; mtime: number } => Boolean(entry));

  const ordered = files
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.uuid);

  return Array.from(new Set(ordered));
}

function resolveConnectionCandidates(connection: string): string[] {
  if (connection !== 'google-gog') return [connection];
  return resolveConnectionCandidatesFromFiles();
}

export async function callFunction(connection: string, toolName: string, args: unknown): Promise<CallToolResult> {
  const id = crypto.randomUUID();

  // Primary strategy for google-gog: ask the local MCP server for the user's current connections.
  // This avoids guessing the UUID from wrapper filenames.
  let candidateConnections: string[] = [];

  if (connection === 'google-gog') {
    const payload = await listCurrentConnectionsViaRpc();
    const fromRpc = extractGoogleGogUuidFromConnectionsPayload(payload);

    if (fromRpc.length) {
      candidateConnections = fromRpc;
    } else {
      candidateConnections = resolveConnectionCandidatesFromFiles();
    }
  } else {
    candidateConnections = [connection];
  }

  if (!candidateConnections.length) {
    throw new Error(
      `Unable to resolve MCP connection UUID for alias 'google-gog'. ` +
        `Try re-adding the integration, and ensure your runtime MCP server supports list_connections.`,
    );
  }

  let lastError: any = undefined;

  for (const candidateConnection of candidateConnections) {
    const request = {
      jsonrpc: "2.0",
      id,
      method: "tool_call",
      params: { connection: candidateConnection, tool: toolName, args },
    };

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(130_000),
        });

        const result = await res.json();

        if (result.error) {
          throw new Error(`Tool ${toolName} failed: ${result.error.message || JSON.stringify(result.error)}`);
        }

        return result.result as CallToolResult;
      } catch (err: any) {
        lastError = err;

        // If this candidate connection is invalid/unavailable or its auth is revoked,
        // immediately move to the next candidate so a re-added connection can be tried.
        if (shouldRetryWithAlias(err) || shouldMoveToNextCandidateOnAuthError(err)) {
          break;
        }

        if (err?.cause?.code === "ECONNREFUSED" && attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }

        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }

        throw err;
      }
    }
  }

  throw lastError;
}
