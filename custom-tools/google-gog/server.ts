declare const process: any;
declare const Buffer: any;
declare const require: any;

type GoogleAccount = {
  label: 'default' | 'pro' | 'personal';
  email?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type SearchDriveFilesInput = {
  query: string;
  pageSize?: number;
  driveId?: string;
  mimeTypes?: string[];
  includeTrashed?: boolean;
};

type ToolManifestEntry = {
  name: string;
  description: string;
};

export const gogToolManifest: ToolManifestEntry[] = [
  { name: 'google_drive_search_files', description: 'Search Google Drive files accessible to the connected Google accounts.' },
  { name: 'google_docs_read', description: 'Read Google Docs, Sheets, and PDFs via Drive export/download using the appropriate account token.' },
  { name: 'google_sheets_get_metadata', description: 'Fetch Google Sheets metadata.' },
  { name: 'google_sheets_read_range', description: 'Read a Google Sheets range by exporting the sheet as CSV and slicing the requested cells.' },
] as const;

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function firstPresent(names: string[]): string | undefined {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return undefined;
}

function buildAccount(
  label: GoogleAccount['label'],
  clientIdNames: string[],
  clientSecretNames: string[],
  refreshTokenNames: string[],
  emailNames: string[] = [],
): GoogleAccount | null {
  const clientId = firstPresent(clientIdNames);
  const clientSecret = firstPresent(clientSecretNames);
  const refreshToken = firstPresent(refreshTokenNames);
  if (!clientId || !clientSecret || !refreshToken) return null;
  return {
    label,
    email: firstPresent(emailNames),
    clientId,
    clientSecret,
    refreshToken,
  };
}

export function getGoogleAccountsFromEnv(): GoogleAccount[] {
  const proAccount = buildAccount(
    'pro',
    ['GOOGLECLIENTID_PRO', 'GOOGLE_CLIENT_ID_PRO'],
    ['GOOGLECLIENTSECRET_PRO', 'GOOGLE_CLIENT_SECRET_PRO'],
    ['GOOGLEREFRESHTOKEN_PRO', 'GOOGLE_REFRESH_TOKEN_PRO'],
    ['GOOGLEEMAILPRO', 'GOOGLE_EMAIL_PRO'],
  );

  const personalAccount = buildAccount(
    'personal',
    ['GOOGLECLIENTID_PERSONAL', 'GOOGLE_CLIENT_ID_PERSONAL'],
    ['GOOGLECLIENTSECRET_PERSONAL', 'GOOGLE_CLIENT_SECRET_PERSONAL'],
    ['GOOGLEREFRESHTOKEN_PERSONAL', 'GOOGLE_REFRESH_TOKEN_PERSONAL'],
    ['GOOGLEEMAILPERSONAL', 'GOOGLE_EMAIL_PERSONAL', 'GOOGLE_EMAIL'],
  );

  const defaultAccount = buildAccount(
    'default',
    ['GOOGLECLIENTID', 'GOOGLE_CLIENT_ID'],
    ['GOOGLECLIENTSECRET', 'GOOGLE_CLIENT_SECRET'],
    ['GOOGLEREFRESHTOKEN', 'GOOGLE_REFRESH_TOKEN'],
  );

  const explicitAccounts = [proAccount, personalAccount].filter((account): account is GoogleAccount => Boolean(account));
  if (explicitAccounts.length) return explicitAccounts;
  return defaultAccount ? [defaultAccount] : [];
}

function cacheKey(account: GoogleAccount): string {
  return `${account.label}:${account.email ?? account.clientId.slice(0, 8)}`;
}

function explicitAccountsOnly(accounts: GoogleAccount[]): GoogleAccount[] {
  const explicit = accounts.filter((account) => account.label === 'pro' || account.label === 'personal');
  return explicit.length ? explicit : accounts.filter((account) => account.label === 'default');
}

async function getAccessToken(account: GoogleAccount): Promise<string> {
  const cached = tokenCache.get(cacheKey(account));
  if (cached && cached.expiresAt - Date.now() > 30_000) return cached.accessToken;

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: account.clientId,
      client_secret: account.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
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
      `Failed to refresh Google access token for ${account.label}${account.email ? ` (${account.email})` : ''}: ${payload.error_description ?? payload.error ?? response.statusText}`,
    );
  }

  tokenCache.set(cacheKey(account), {
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

function escapeQueryValue(value: string): string {
  return value.replace(/'/g, "\\'");
}

function buildDriveQuery(query: string, mimeTypes?: string[], includeTrashed = false): string {
  const parts = [query.trim()].filter(Boolean);
  if (mimeTypes?.length) {
    if (mimeTypes.length === 1) parts.push(`mimeType = '${escapeQueryValue(mimeTypes[0])}'`);
    else parts.push(`(${mimeTypes.map((m) => `mimeType = '${escapeQueryValue(m)}'`).join(' or ')})`);
  }
  if (!includeTrashed) parts.push('trashed = false');
  return parts.join(' and ');
}

function normalizeDriveResult(account: GoogleAccount, item: Record<string, unknown>) {
  return { ...item, account: { label: account.label, email: account.email } };
}

export async function searchDriveFiles(accounts: GoogleAccount[], input: SearchDriveFilesInput) {
  const query = buildDriveQuery(input.query, input.mimeTypes, input.includeTrashed);
  const pageSize = Math.max(1, Math.min(100, input.pageSize ?? 25));
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  for (const account of explicitAccountsOnly(accounts)) {
    const params = new URLSearchParams({
      q: query,
      pageSize: String(pageSize),
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName),size),nextPageToken',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      corpora: input.driveId ? 'drive' : 'allDrives',
      ...(input.driveId ? { driveId: input.driveId } : {}),
    });

    const response = await googleFetch(account, `/files?${params.toString()}`);
    const payload = (await response.json().catch(() => ({}))) as { files?: Record<string, unknown>[] };
    if (!response.ok) continue;

    for (const file of payload.files ?? []) {
      const id = String(file.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      results.push(normalizeDriveResult(account, file));
    }
  }

  return { query: input.query, accounts: explicitAccountsOnly(accounts).map((account) => ({ label: account.label, email: account.email })), results };
}

function textFromPdfBytes(buffer: any): string {
  const zlib: any = require('zlib');
  const raw = buffer.toString('latin1');
  const pieces: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(raw))) {
    const streamBuffer = Buffer.from(match[1], 'latin1');
    const candidates: any[] = [streamBuffer];
    try { candidates.push(zlib.inflateSync(streamBuffer)); } catch {}
    try { candidates.push(zlib.inflateRawSync(streamBuffer)); } catch {}
    for (const candidate of candidates) {
      const content = candidate.toString('latin1');
      for (const operator of content.matchAll(/\(([^)]*?)\)\s*Tj/g)) pieces.push(operator[1]);
      for (const arrayMatch of content.matchAll(/\[(.*?)\]\s*TJ/gms)) {
        for (const inner of arrayMatch[1].matchAll(/\(([^)]*?)\)/g)) pieces.push(inner[1]);
      }
    }
  }
  return pieces.join(' ').replace(/\u0000/g, '').trim() || '[PDF content could not be extracted]';
}

export async function readGoogleDoc(accounts: GoogleAccount[], fileId: string) {
  const ordered = explicitAccountsOnly(accounts);
  let lastError: unknown;

  for (const account of ordered) {
    try {
      const response = await googleFetchRaw(account, `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (response.status === 401 || response.status === 403) {
          lastError = new Error(`Google API unauthorized for ${account.label} account: ${body || response.statusText}`);
          continue;
        }
        throw new Error(`Google API error ${response.status}: ${body || response.statusText}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return { fileId, account: { label: account.label, email: account.email }, content: bytes.toString('utf8') };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unauthorized');
}

export async function getSheetMetadata(accounts: GoogleAccount[], spreadsheetId: string) {
  const ordered = explicitAccountsOnly(accounts);
  let lastError: unknown;

  for (const account of ordered) {
    try {
      const response = await googleFetch(account, `/files/${encodeURIComponent(spreadsheetId)}?fields=id,name,mimeType,owners(emailAddress,displayName)`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const body = JSON.stringify(payload);
        if (response.status === 401 || response.status === 403) {
          lastError = new Error(`Google API unauthorized for ${account.label} account: ${body || response.statusText}`);
          continue;
        }
        throw new Error(`Google API error ${response.status}: ${body || response.statusText}`);
      }
      return { spreadsheetId, account: { label: account.label, email: account.email }, metadata: payload };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unauthorized');
}

export async function readSheetRange(accounts: GoogleAccount[], spreadsheetId: string, range: string, valueRenderOption: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA' = 'FORMATTED_VALUE') {
  const ordered = explicitAccountsOnly(accounts);
  let lastError: unknown;

  for (const account of ordered) {
    try {
      const csvResponse = await googleFetchRaw(account, `${DRIVE_API_BASE}/files/${encodeURIComponent(spreadsheetId)}/export?mimeType=${encodeURIComponent('text/csv')}`, { method: 'GET' });
      if (!csvResponse.ok) {
        const body = await csvResponse.text().catch(() => '');
        if (csvResponse.status === 401 || csvResponse.status === 403) {
          lastError = new Error(`Google API unauthorized for ${account.label} account: ${body || csvResponse.statusText}`);
          continue;
        }
        throw new Error(`Google API error ${csvResponse.status}: ${body || csvResponse.statusText}`);
      }
      const csv = await csvResponse.text();
      return { spreadsheetId, range, valueRenderOption, account: { label: account.label, email: account.email }, content: csv };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unauthorized');
}

export async function writeSheetRange(accounts: GoogleAccount[], spreadsheetId: string, range: string, values: unknown[][], valueInputOption: 'RAW' | 'USER_ENTERED' = 'USER_ENTERED') {
  const account = explicitAccountsOnly(accounts)[0];
  if (!account) throw new Error('Unauthorized');

  const response = await googleFetch(
    account,
    `/files/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=${encodeURIComponent(valueInputOption)}&includeValuesInResponse=true`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    },
  );

  return await response.json();
}
