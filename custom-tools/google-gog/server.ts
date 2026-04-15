declare const process: any;

type GoogleAccount = {
  label: 'default' | 'pro' | 'personal';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type ValueRenderOption = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
type ValueInputOption = 'RAW' | 'USER_ENTERED';

type DriveSearchInput = {
  query: string;
  pageSize?: number;
  driveId?: string;
  mimeTypes?: string[];
  includeTrashed?: boolean;
};

function env(name: string): string | undefined {
  const value = process.env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
): GoogleAccount | null {
  const clientId = firstPresent(clientIdNames);
  const clientSecret = firstPresent(clientSecretNames);
  const refreshToken = firstPresent(refreshTokenNames);
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { label, clientId, clientSecret, refreshToken };
}

export function getGoogleAccountsFromEnv(): GoogleAccount[] {
  const accounts: GoogleAccount[] = [];

  const defaultAccount = buildAccount('default',
    ['GOOGLECLIENTID', 'GOOGLE_CLIENT_ID'],
    ['GOOGLECLIENTSECRET', 'GOOGLE_CLIENT_SECRET'],
    ['GOOGLEREFRESHTOKEN', 'GOOGLE_REFRESH_TOKEN'],
  );
  if (defaultAccount) accounts.push(defaultAccount);

  const proAccount = buildAccount('pro',
    ['GOOGLECLIENTID_PRO', 'GOOGLE_CLIENT_ID_PRO'],
    ['GOOGLECLIENTSECRET_PRO', 'GOOGLE_CLIENT_SECRET_PRO'],
    ['GOOGLEREFRESHTOKEN_PRO', 'GOOGLE_REFRESH_TOKEN_PRO'],
  );
  if (proAccount) accounts.push(proAccount);

  const personalAccount = buildAccount('personal',
    ['GOOGLECLIENTID_PERSONAL', 'GOOGLE_CLIENT_ID_PERSONAL'],
    ['GOOGLECLIENTSECRET_PERSONAL', 'GOOGLE_CLIENT_SECRET_PERSONAL'],
    ['GOOGLEREFRESHTOKEN_PERSONAL', 'GOOGLE_REFRESH_TOKEN_PERSONAL'],
  );
  if (personalAccount) accounts.push(personalAccount);

  return accounts;
}

async function getAccessToken(account: GoogleAccount): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
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
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(
      `OAuth token refresh failed for ${account.label} account: ${payload.error_description ?? payload.error ?? `HTTP ${response.status}`}`,
    );
  }

  return payload.access_token;
}

async function googleFetch<T>(
  accounts: GoogleAccount[],
  path: string,
  init: RequestInit,
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown = new Error('Unauthorized');

  for (const account of accounts) {
    try {
      const accessToken = await getAccessToken(account);
      const response = await fetch(`https://www.googleapis.com${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(init.headers ?? {}),
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401 || response.status === 403) {
          lastError = new Error(`Google API unauthorized for ${account.label} account: ${text || response.statusText}`);
          continue;
        }
        throw new Error(`Google API error ${response.status}: ${text || response.statusText}`);
      }

      return await parse(response);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unauthorized');
}

export const gogToolManifest = [
  { name: 'google_drive_search_files', description: 'Search Google Drive files using Drive query syntax.' },
  { name: 'google_docs_read', description: 'Read a Google Doc as plain text.' },
  { name: 'google_sheets_get_metadata', description: 'Fetch spreadsheet metadata including sheet names and IDs.' },
  { name: 'google_sheets_read_range', description: 'Read a Google Sheets range.' },
  { name: 'google_sheets_write_range', description: 'Write values to a Google Sheets range.' },
] as const;

export async function searchDriveFiles(accounts: GoogleAccount[], input: DriveSearchInput) {
  const qParts: string[] = [];
  if (input.query?.trim()) qParts.push(`(${input.query.trim()})`);
  if (input.mimeTypes?.length) {
    const mimeClause = input.mimeTypes.map((mime) => `mimeType='${mime.replace(/'/g, "\\'")}'`).join(' or ');
    qParts.push(`(${mimeClause})`);
  }
  if (input.includeTrashed === false) qParts.push('trashed = false');

  const params = new URLSearchParams();
  params.set('fields', 'files(id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName,emailAddress)),nextPageToken');
  params.set('supportsAllDrives', 'true');
  params.set('includeItemsFromAllDrives', 'true');
  if (input.pageSize) params.set('pageSize', String(Math.min(Math.max(Math.trunc(input.pageSize), 1), 1000)));
  if (input.driveId) {
    params.set('corpora', 'drive');
    params.set('driveId', input.driveId);
  }
  params.set('q', qParts.join(' and ') || input.query || '');

  return await googleFetch(accounts, `/drive/v3/files?${params.toString()}`, { method: 'GET' }, async (response) => await response.json());
}

export async function readGoogleDoc(accounts: GoogleAccount[], documentId: string) {
  return await googleFetch(accounts, `/docs/v1/documents/${encodeURIComponent(documentId)}`, { method: 'GET' }, async (response) => {
    const doc = (await response.json()) as any;
    const parts: string[] = [];
    for (const block of doc.body?.content ?? []) {
      for (const element of block.paragraph?.elements ?? []) {
        const content = element.textRun?.content;
        if (typeof content === 'string') parts.push(content);
      }
    }
    return { documentId, text: parts.join('').trim(), raw: doc };
  });
}

export async function getSheetMetadata(accounts: GoogleAccount[], spreadsheetId: string) {
  return await googleFetch(accounts, `/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties`, { method: 'GET' }, async (response) => await response.json());
}

export async function readSheetRange(accounts: GoogleAccount[], spreadsheetId: string, range: string, valueRenderOption: ValueRenderOption = 'FORMATTED_VALUE') {
  const params = new URLSearchParams({ valueRenderOption });
  return await googleFetch(accounts, `/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`, { method: 'GET' }, async (response) => await response.json());
}

export async function writeSheetRange(accounts: GoogleAccount[], spreadsheetId: string, range: string, values: unknown[][], valueInputOption: ValueInputOption = 'USER_ENTERED') {
  return await googleFetch(
    accounts,
    `/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=${encodeURIComponent(valueInputOption)}&includeValuesInResponse=true`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    },
    async (response) => await response.json(),
  );
}
