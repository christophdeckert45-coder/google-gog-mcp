export type GoogleAccount = {
  label: "pro" | "personal" | string;
  email?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type SearchDriveFilesInput = {
  query: string;
  pageSize?: number;
  driveId?: string;
  mimeTypes?: string[];
  includeTrashed?: boolean;
};

export type ToolManifestEntry = {
  name: string;
  description: string;
};

export const gogToolManifest: ToolManifestEntry[] = [
  { name: "google_drive_search_files", description: "Search Google Drive files accessible to the connected Google accounts." },
  { name: "google_docs_read", description: "Read Google Docs, Sheets, and PDFs via Drive export/download using the appropriate account token." },
  { name: "google_sheets_get_metadata", description: "Fetch Google Sheets metadata." },
  { name: "google_sheets_read_range", description: "Read a Google Sheets range by exporting the sheet as CSV and slicing the requested cells." },
];

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function buildAccount(
  label: "pro" | "personal",
  clientIdKey: string,
  clientSecretKey: string,
  refreshTokenKey: string,
  emailKey?: string,
): GoogleAccount | null {
  const clientId = env(clientIdKey);
  const clientSecret = env(clientSecretKey);
  const refreshToken = env(refreshTokenKey);
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { label, email: emailKey ? env(emailKey) : undefined, clientId, clientSecret, refreshToken };
}

export function getGoogleAccountsFromEnv(): GoogleAccount[] {
  return [
    buildAccount("pro", "GOOGLECLIENTIDPRO", "GOOGLECLIENTSECRETPRO", "GOOGLEREFRESHTOKENPRO", "GOOGLEEMAILPRO"),
    buildAccount("personal", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_EMAIL"),
  ].filter((x): x is GoogleAccount => Boolean(x));
}

function accountKey(account: GoogleAccount): string {
  return `${account.label}:${account.email ?? account.clientId.slice(0, 8)}`;
}

async function getAccessToken(account: GoogleAccount): Promise<string> {
  const cached = tokenCache.get(accountKey(account));
  if (cached && cached.expiresAt - Date.now() > 30_000) return cached.accessToken;

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: account.clientId,
      client_secret: account.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Failed to refresh Google access token for ${account.label}${account.email ? ` (${account.email})` : ""}: ${payload.error ?? response.statusText}${payload.error_description ? ` - ${payload.error_description}` : ""}`,
    );
  }

  tokenCache.set(accountKey(account), {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  });
  return payload.access_token;
}

async function googleFetch(account: GoogleAccount, path: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await getAccessToken(account);
  return fetch(`${DRIVE_API_BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
  });
}

async function googleFetchRaw(account: GoogleAccount, url: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await getAccessToken(account);
  return fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
  });
}

function preferredReadAccounts(accounts: GoogleAccount[]): GoogleAccount[] {
  return [...accounts.filter((a) => a.label === "pro"), ...accounts.filter((a) => a.label !== "pro")];
}

async function getFileMetadata(account: GoogleAccount, fileId: string) {
  const response = await googleFetch(account, `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink,modifiedTime,owners(emailAddress,displayName),size,headRevisionId,trashed`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Drive metadata for ${fileId} using ${account.label}${account.email ? ` (${account.email})` : ""}: ${JSON.stringify(payload)}`,
    );
  }
  return payload as { mimeType?: string; name?: string } & Record<string, unknown>;
}

async function pickAccountWithAccess(accounts: GoogleAccount[], fileId: string) {
  let lastError: unknown;
  for (const account of accounts) {
    try {
      return { account, metadata: await getFileMetadata(account, fileId) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to access Drive file ${fileId}`);
}

async function downloadFileBytes(account: GoogleAccount, fileId: string): Promise<Buffer> {
  const response = await googleFetchRaw(account, `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`, { method: "GET" });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to download Drive file ${fileId} using ${account.label}${account.email ? ` (${account.email})` : ""}: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function exportFile(account: GoogleAccount, fileId: string, mimeType: string): Promise<string> {
  const response = await googleFetchRaw(
    account,
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`,
    { method: "GET" },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to export Drive file ${fileId} as ${mimeType} using ${account.label}${account.email ? ` (${account.email})` : ""}: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
    );
  }
  return await response.text();
}

function escapeQueryValue(value: string): string {
  return value.replace(/'/g, "\\'");
}

function buildDriveQuery(query: string, mimeTypes?: string[], includeTrashed = false): string {
  const parts = [query.trim()].filter(Boolean);
  if (mimeTypes?.length) {
    if (mimeTypes.length === 1) parts.push(`mimeType = '${escapeQueryValue(mimeTypes[0])}'`);
    else parts.push(`(${mimeTypes.map((m) => `mimeType = '${escapeQueryValue(m)}'`).join(" or ")})`);
  }
  if (!includeTrashed) parts.push("trashed = false");
  return parts.join(" and ");
}

function normalizeDriveResult(account: GoogleAccount, item: Record<string, unknown>) {
  return { ...item, account: { label: account.label, email: account.email } };
}

export async function searchDriveFiles(accounts: GoogleAccount[], input: SearchDriveFilesInput) {
  const query = buildDriveQuery(input.query, input.mimeTypes, input.includeTrashed);
  const pageSize = Math.max(1, Math.min(100, input.pageSize ?? 25));
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const account of accounts) {
    const params = new URLSearchParams({
      q: query,
      pageSize: String(pageSize),
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName),size),nextPageToken",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: input.driveId ? "drive" : "allDrives",
      ...(input.driveId ? { driveId: input.driveId } : {}),
    });
    const response = await googleFetch(account, `/files?${params.toString()}`);
    const payload = (await response.json().catch(() => ({}))) as { files?: Record<string, unknown>[] };
    if (!response.ok) continue;
    for (const file of payload.files ?? []) {
      const id = String(file.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      results.push(normalizeDriveResult(account, file));
    }
  }

  return { query: input.query, accounts: accounts.map((account) => ({ label: account.label, email: account.email })), results };
}

async function textFromPdfBytes(buffer: Buffer): Promise<string> {
  const zlib = await import("node:zlib");
  const raw = buffer.toString("latin1");
  const pieces: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(raw))) {
    const streamBuffer = Buffer.from(match[1], "latin1");
    const candidates: Buffer[] = [streamBuffer];
    try { candidates.push(zlib.inflateSync(streamBuffer)); } catch {}
    try { candidates.push(zlib.inflateRawSync(streamBuffer)); } catch {}
    for (const candidate of candidates) {
      const content = candidate.toString("latin1");
      for (const operator of content.matchAll(/\(([^)]*?)\)\s*Tj/g)) pieces.push(operator[1]);
      for (const arrayMatch of content.matchAll(/\[(.*?)\]\s*TJ/gms)) {
        for (const inner of arrayMatch[1].matchAll(/\(([^)]*?)\)/g)) pieces.push(inner[1]);
      }
    }
  }
  return pieces.join(" ").replace(/\u0000/g, "").trim() || "[PDF content could not be extracted]";
}

export async function readGoogleDoc(accounts: GoogleAccount[], fileId: string) {
  const { account, metadata } = await pickAccountWithAccess(preferredReadAccounts(accounts), fileId);
  const mimeType = String(metadata.mimeType ?? "");
  const name = String(metadata.name ?? fileId);

  if (mimeType === "application/vnd.google-apps.document") {
    return { fileId, name, mimeType, account: { label: account.label, email: account.email }, source: "drive.export:text/plain", content: await exportFile(account, fileId, "text/plain") };
  }
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    return { fileId, name, mimeType, account: { label: account.label, email: account.email }, source: "drive.export:text/csv", content: await exportFile(account, fileId, "text/csv") };
  }
  if (mimeType === "application/pdf") {
    const bytes = await downloadFileBytes(account, fileId);
    return { fileId, name, mimeType, account: { label: account.label, email: account.email }, source: "drive.download:pdf", content: await textFromPdfBytes(bytes) };
  }

  const bytes = await downloadFileBytes(account, fileId);
  return { fileId, name, mimeType, account: { label: account.label, email: account.email }, source: "drive.download:binary", content: bytes.toString("utf8") };
}

export async function getSheetMetadata(accounts: GoogleAccount[], spreadsheetId: string) {
  const { account, metadata } = await pickAccountWithAccess(preferredReadAccounts(accounts), spreadsheetId);
  return { spreadsheetId, account: { label: account.label, email: account.email }, metadata };
}

function columnToIndex(column: string): number {
  let index = 0;
  for (const ch of column.toUpperCase()) {
    if (ch < "A" || ch > "Z") continue;
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

function parseA1Range(range: string) {
  const clean = range.replace(/'/g, "");
  const parts = clean.split(":");
  const parseCell = (cell: string) => {
    const match = cell.match(/([A-Z]+)(\d+)?/i);
    if (!match) return null;
    return { col: columnToIndex(match[1]), row: match[2] ? Math.max(0, Number(match[2]) - 1) : 0 };
  };
  return { start: parseCell(parts[0]), end: parseCell(parts[1] ?? parts[0]) };
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    const next = csv[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ""; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export async function readSheetRange(
  accounts: GoogleAccount[],
  spreadsheetId: string,
  range: string,
  valueRenderOption: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA" = "FORMATTED_VALUE",
) {
  const { account, metadata } = await pickAccountWithAccess(preferredReadAccounts(accounts), spreadsheetId);
  const csv = await exportFile(account, spreadsheetId, "text/csv");
  const rows = parseCsv(csv);
  const { start, end } = parseA1Range(range);
  const content = start
    ? rows.slice(start.row, end?.row ?? start.row + 1).map((r) => r.slice(start.col, (end?.col ?? start.col) + 1))
    : rows;
  return { spreadsheetId, range, valueRenderOption, account: { label: account.label, email: account.email }, metadata, content };
}
