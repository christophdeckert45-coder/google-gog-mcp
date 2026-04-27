// Rebuilt Google Drive bridge using Composio SDK (no direct Google Drive API calls)

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

// Kept for backwards compatibility with mcp-server.ts typing
export type GoogleGogConfig = Record<string, never>;

function normalizeAccountLabel(label: unknown): 'pro' | 'personal' {
  return label === 'personal' ? 'personal' : 'pro';
}

type AccountLabel = 'pro' | 'personal';

type SearchDriveFilesInput = {
  query: string;
  pageSize?: number;
  driveId?: string;
  mimeTypes?: string[];
  includeTrashed?: boolean;
  account?: AccountLabel;
};

type ToolManifestEntry = {
  name: string;
  description: string;
  accountRequired?: boolean;
};

export const gogToolManifest: ToolManifestEntry[] = [
  { name: 'google_drive_search_files', description: 'Search Google Drive files accessible to the connected Google accounts.', accountRequired: true },
  { name: 'google_docs_read', description: 'Read Google Docs, Sheets, and PDFs via Drive export/download using the appropriate account token.', accountRequired: true },
  { name: 'google_sheets_get_metadata', description: 'Fetch Google Sheets metadata.', accountRequired: true },
  { name: 'google_sheets_read_range', description: 'Read a Google Sheets range by exporting the sheet as CSV and slicing the requested cells.', accountRequired: true },
  { name: 'google_sheets_write_range', description: 'Write values to a Google Sheets range.', accountRequired: true },
] as const;

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
let composioClient: any | null = null;

function invalidateTokenCache(account: GoogleAccount) {
  tokenCache.delete(cacheKey(account));
}

function isAuthFailure(status: number, payload: unknown, error?: unknown): boolean {
  const message = [status, JSON.stringify(payload ?? {}), error instanceof Error ? error.message : String(error ?? '')]
    .join(' ')
    .toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    message.includes('invalid_grant') ||
    message.includes('expired') ||
    message.includes('revoked') ||
    message.includes('unauthorized') ||
    message.includes('token') && (message.includes('expired') || message.includes('revoked'))
  );
}

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

function getGoogleAccountsFromEnvImpl(): GoogleAccount[] {
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

  const proAccount = buildAccount(
    'pro',
    ['GOOGLECLIENTID_PRO', 'GOOGLE_CLIENT_ID_PRO', 'GOOGLECLIENTID', 'GOOGLE_CLIENT_ID'],
    ['GOOGLECLIENTSECRET_PRO', 'GOOGLE_CLIENT_SECRET_PRO', 'GOOGLECLIENTSECRET', 'GOOGLE_CLIENT_SECRET'],
    ['GOOGLEREFRESHTOKEN_PRO', 'GOOGLE_REFRESH_TOKEN_PRO', 'GOOGLEREFRESHTOKEN', 'GOOGLE_REFRESH_TOKEN'],
    ['GOOGLEEMAILPRO', 'GOOGLE_EMAIL_PRO', 'GOOGLE_EMAIL'],
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

export function getGoogleAccountsFromEnv(): GoogleAccount[] {
  return getGoogleAccountsFromEnvImpl();
}

function cacheKey(account: GoogleAccount): string {
  const label = normalizeAccountLabel(account.label);
  return `${label}:${account.email ?? account.clientId.slice(0, 8)}`;
}

function orderedAccounts(accounts: GoogleAccount[]): GoogleAccount[] {
  const pro = accounts.filter((account) => normalizeAccountLabel(account.label) === 'pro');
  const personal = accounts.filter((account) => normalizeAccountLabel(account.label) === 'personal');
  return [...pro, ...personal];
}

function accessCandidates(accounts: GoogleAccount[], preferred?: AccountLabel): GoogleAccount[] {
  const candidates = orderedAccounts(accounts);
  if (!preferred) return candidates;
  const preferredAccount = candidates.filter((account) => normalizeAccountLabel(account.label) === preferred);
  const fallbackAccount = candidates.filter((account) => normalizeAccountLabel(account.label) !== preferred);
  return [...preferredAccount, ...fallbackAccount];
}

function normalizeDriveResourceId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/(?:d|folders)\/([a-zA-Z0-9_-]{10,})/) ?? trimmed.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  return match?.[1] ?? trimmed;
}

async function getAccessToken(account: GoogleAccount): Promise<string> {
  const safeLabel = normalizeAccountLabel(account.label);
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
      `Failed to refresh Google access token for ${safeLabel}${account.email ? ` (${account.email})` : ''}: ${payload.error_description ?? payload.error ?? response.statusText}`,
    );
  }

  tokenCache.set(cacheKey(account), {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  });

  return payload.access_token;
}

async function getComposioClient(): Promise<any> {
  if (composioClient) return composioClient;

  const apiKey = env('COMPOSIO_API_KEY');
  if (!apiKey) {
    throw new Error('Missing COMPOSIO_API_KEY in environment.');
  }

  // Dynamic import so the bridge can still load even if dependency install is not present yet.
  const mod: any = await import('@composio/client');
  const Composio = mod.default ?? mod;

  composioClient = new Composio({ apiKey });
  return composioClient;
}

async function composioProxyGoogle(
  account: GoogleAccount,
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD',
  opts?: {
    body?: unknown;
    toolkitSlug?: string;
    expectBinary?: boolean;
    retryOnAuthFailure?: boolean;
  },
): Promise<{ status: number; data?: unknown; binaryText?: string }> {
  const client = await getComposioClient();
  const accessToken = await getAccessToken(account);

  const execute = async () => client.tools.proxy({
    endpoint,
    method,
    body: opts?.body,
    custom_connection_data: {
      authScheme: 'OAUTH2',
      toolkitSlug: opts?.toolkitSlug ?? 'googledrive',
      val: {
        access_token: accessToken,
      },
    },
  });

  let res = await execute();
  let status = res?.status ?? 200;

  if (opts?.retryOnAuthFailure !== false && isAuthFailure(status, res?.data)) {
    invalidateTokenCache(account);
    const refreshed = await getAccessToken(account);
    res = await client.tools.proxy({
      endpoint,
      method,
      body: opts?.body,
      custom_connection_data: {
        authScheme: 'OAUTH2',
        toolkitSlug: opts?.toolkitSlug ?? 'googledrive',
        val: {
          access_token: refreshed,
        },
      },
    });
    status = res?.status ?? 200;
  }

  if (res?.binary_data?.url) {
    const url: string = res.binary_data.url;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    return { status, binaryText: buf.toString('utf8') };
  }

  return { status, data: res?.data };
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
  return { ...item, account: { label: normalizeAccountLabel(account.label), email: account.email } };
}

export async function searchDriveFiles(accounts: GoogleAccount[], input: SearchDriveFilesInput) {
  const query = buildDriveQuery(input.query, input.mimeTypes, input.includeTrashed);
  const pageSize = Math.max(1, Math.min(100, input.pageSize ?? 25));

  const seen = new Set<string>();
  const results: Array<Record<string, unknown>> = [];
  const candidates = accessCandidates(accounts, input.account);

  for (const account of candidates) {
    try {
      const params = new URLSearchParams({
        q: query,
        pageSize: String(pageSize),
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName),size)',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        corpora: input.driveId ? 'drive' : 'allDrives',
        ...(input.driveId ? { driveId: input.driveId } : {}),
      });

      const endpoint = `${DRIVE_API_BASE}/files?${params.toString()}`;
      const res = await composioProxyGoogle(account, endpoint, 'GET', { toolkitSlug: 'googledrive', retryOnAuthFailure: true });
      if (res.status < 200 || res.status >= 300) continue;

      const payload = (res.data ?? {}) as { files?: Record<string, unknown>[] };
      for (const file of payload.files ?? []) {
        const id = String((file as any).id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        results.push(normalizeDriveResult(account, file));
      }
    } catch {
      // Keep trying other accounts if one refresh token is revoked or expired.
      continue;
    }
  });

    const endpoint = `${DRIVE_API_BASE}/files?${params.toString()}`;
    const res = await composioProxyGoogle(account, endpoint, 'GET', { toolkitSlug: 'googledrive' });
    if (res.status < 200 || res.status >= 300) continue;

    const payload = (res.data ?? {}) as { files?: Record<string, unknown>[] };
    for (const file of payload.files ?? []) {
      const id = String((file as any).id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      results.push(normalizeDriveResult(account, file));
    }
  }

  return {
    query: input.query,
    accounts: candidates.map((account) => ({ label: account.label, email: account.email })),
    results,
  };
}

function helpfulTokenError(accounts: GoogleAccount[]): Error {
  const labels = accounts.map((account) => normalizeAccountLabel(account.label)).join(' then ');
  return new Error(`Unable to refresh Google access token for configured accounts (${labels || 'none'}). Check the Google client ID, client secret, and refresh token for the pro and personal accounts.`);
}

export async function readGoogleDoc(accounts: GoogleAccount[], fileIdOrUrl: string, account?: AccountLabel) {
  const candidates = accessCandidates(accounts, account);
  const fileId = normalizeDriveResourceId(fileIdOrUrl);

  let lastError: unknown;

  for (const account of candidates) {
    try {
      const endpoint = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
      const res = await composioProxyGoogle(account, endpoint, 'GET', { toolkitSlug: 'googledrive', expectBinary: true });

      if (res.binaryText == null) {
        lastError = new Error('Composio proxy returned no binary data for document read.');
        continue;
      }

      return {
        fileId,
        account: { label: account.label, email: account.email },
        content: res.binaryText,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : helpfulTokenError(candidates);
}

export async function getSheetMetadata(accounts: GoogleAccount[], spreadsheetIdOrUrl: string, account?: AccountLabel) {
  const candidates = accessCandidates(accounts, account);
  const spreadsheetId = normalizeDriveResourceId(spreadsheetIdOrUrl);

  let lastError: unknown;

  for (const account of candidates) {
    try {
      const endpoint = `${DRIVE_API_BASE}/files/${encodeURIComponent(spreadsheetId)}?fields=id,name,mimeType,owners(emailAddress,displayName)`;
      const res = await composioProxyGoogle(account, endpoint, 'GET', { toolkitSlug: 'googledrive' });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Google API error ${res.status}: ${JSON.stringify(res.data ?? '')}`);
      }

      return {
        spreadsheetId,
        account: { label: account.label, email: account.email },
        metadata: res.data,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : helpfulTokenError(candidates);
}

export async function readSheetRange(
  accounts: GoogleAccount[],
  spreadsheetIdOrUrl: string,
  range: string,
  valueRenderOption: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA' = 'FORMATTED_VALUE',
  account?: AccountLabel,
) {
  // For now we keep the previous behavior: export the spreadsheet as CSV and return the full content.
  // Callers can slice if they need tighter cell-level results.

  const candidates = accessCandidates(accounts, account);
  const spreadsheetId = normalizeDriveResourceId(spreadsheetIdOrUrl);

  let lastError: unknown;

  for (const account of candidates) {
    try {
      const endpoint = `${DRIVE_API_BASE}/files/${encodeURIComponent(spreadsheetId)}/export?mimeType=${encodeURIComponent('text/csv')}`;
      const res = await composioProxyGoogle(account, endpoint, 'GET', { toolkitSlug: 'googledrive', expectBinary: true });

      if (res.binaryText == null) throw new Error(`Google Sheets export returned no CSV text (status ${res.status}).`);

      return {
        spreadsheetId,
        range,
        valueRenderOption,
        account: { label: account.label, email: account.email },
        content: res.binaryText,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : helpfulTokenError(candidates);
}

export async function writeSheetRange(
  accounts: GoogleAccount[],
  spreadsheetIdOrUrl: string,
  range: string,
  values: unknown[][],
  valueInputOption: 'RAW' | 'USER_ENTERED' = 'USER_ENTERED',
  preferredAccount?: AccountLabel,
) {
  const preferred = preferredAccount;
  const account = accessCandidates(accounts, preferred)[0];
  const spreadsheetId = normalizeDriveResourceId(spreadsheetIdOrUrl);
  if (!account) throw new Error('Unable to access Google Sheets because no pro or personal credentials are configured.');

  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=${encodeURIComponent(valueInputOption)}&includeValuesInResponse=true`;

  const res = await composioProxyGoogle(account, endpoint, 'PUT', {
    toolkitSlug: 'googledrive',
    body: { values },
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Google Sheets write failed ${res.status}: ${JSON.stringify(res.data ?? '')}`);
  }

  return res.data;
}
