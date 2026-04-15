declare const process: any;
declare const Buffer: any;
declare const require: any;

type GoogleAccount = {
  label: 'pro' | 'personal';
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
  { name: 'google_sheets_write_range', description: 'Write values to a Google Sheets range.' },
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

  return [proAccount, personalAccount].filter((account): account is GoogleAccount => Boolean(account));
}

function cacheKey(account: GoogleAccount): string {
  return `${account.label}:${account.email ?? account.clientId.slice(0, 8)}`;
}

function orderedAccounts(accounts: GoogleAccount[]): GoogleAccount[] {
  const pro = accounts.filter((account) => account.label === 'pro');
  const personal = accounts.filter((account) => account.label === 'personal');
  return [...pro, ...personal];
}

function normalizeDriveResourceId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/(?:d|folders)\/([a-zA-Z0-9_-]{10,})/) ?? trimmed.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  return match?.[1] ?? trimmed;
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

function accessCandidates(accounts: GoogleAccount[]): GoogleAccount[] {
  const candidates = orderedAccounts(accounts);
  if (candidates.length) return candidates;
  return [];
}

export async function searchDriveFiles(accounts: GoogleAccount[], input: SearchDriveFilesInput) {
  const query = buildDriveQuery(input.query, input.mimeTypes, input.includeTrashed);
  const pageSize = Math.max(1, Math.min(100, input.pageSize ?? 25));
  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];
  const candidates = accessCandidates(accounts);

  for (const account of candidates) {
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

  return { query: input.query, accounts: candidates.map((account) => ({ label: account.label, email: account.email })), results };
}

function helpfulTokenError(accounts: GoogleAccount[]): Error {
  const labels = accounts.map((account) => account.label).join(' then ');
  return new Error(`Unable to refresh Google access token for configured accounts (${labels || 'none'}). Check the Google client ID, client secret, and refresh token for the pro and personal accounts.`);
}

export async function readGoogleDoc(accounts: GoogleAccount[], fileIdOrUrl: string) {
  const candidates = accessCandidates(accounts);
  const fileId = normalizeDriveResourceId(fileIdOrUrl);
  let lastError: unknown;

  for (const account of candidates) {
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

  throw lastError instanceof Error ? lastError : helpfulTokenError(candidates);
}

export async function getSheetMetadata(accounts: GoogleAccount[], spreadsheetIdOrUrl: string) {
  const candidates = accessCandidates(accounts);
  const spreadsheetId = normalizeDriveResourceId(spreadsheetIdOrUrl);
  let lastError: unknown;

  for (const account of candidates) {
    try {
      const response = await googleFetch(account, `/files/${encodeURIComponent(spreadsheetId)}?fields=id,name,mimeType,owners(emailAddress,displayName)`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const body = JSON.stringify(payload);
        throw new Error(`Google API error ${response.status}: ${body || response.statusText}`);
      }
      return { spreadsheetId, account: { label: account.label, email: account.email }, metadata: payload };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : helpfulTokenError(candidates);
}

export async function readSheetRange(accounts: GoogleAccount[], spreadsheetIdOrUrl: string, range: string, valueRenderOption: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA' = 'FORMATTED_VALUE') {
  const candidates = accessCandidates(accounts);
  const spreadsheetId = normalizeDriveResourceId(spreadsheetIdOrUrl);
  let lastError: unknown;

  for (const account of candidates) {
    try {
      const csvResponse = await googleFetchRaw(account, `${DRIVE_API_BASE}/files/${encodeURIComponent(spreadsheetId)}/export?mimeType=${encodeURIComponent('text/csv')}`, { method: 'GET' });
      if (!csvResponse.ok) {
        const body = await csvResponse.text().catch(() => '');
        throw new Error(`Google API error ${csvResponse.status}: ${body || csvResponse.statusText}`);
      }
      const csv = await csvResponse.text();
      return { spreadsheetId, range, valueRenderOption, account: { label: account.label, email: account.email }, content: csv };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : helpfulTokenError(candidates);
}

export async function writeSheetRange(accounts: GoogleAccount[], spreadsheetIdOrUrl: string, range: string, values: unknown[][], valueInputOption: 'RAW' | 'USER_ENTERED' = 'USER_ENTERED') {
  const account = accessCandidates(accounts)[0];
  const spreadsheetId = normalizeDriveResourceId(spreadsheetIdOrUrl);
  if (!account) throw new Error('Unable to access Google Sheets because no pro or personal credentials are configured.');

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
