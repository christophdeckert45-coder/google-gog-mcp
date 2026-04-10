export interface GoogleGogConfig {
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  googleRedirectUri?: string;
}

export interface GoogleDriveSearchInput {
  query: string;
  pageSize?: number;
  driveId?: string;
  mimeTypes?: string[];
  includeTrashed?: boolean;
}

export const gogToolManifest = [
  {
    name: "google_drive_search_files",
    description: "Search files in Google Drive and return metadata for matching items.",
  },
  {
    name: "google_docs_read",
    description: "Read a Google Doc and return its plain text content.",
  },
  {
    name: "google_sheets_get_metadata",
    description: "Get spreadsheet metadata including sheets and titles.",
  },
  {
    name: "google_sheets_read_range",
    description: "Read a range from a Google Sheet.",
  },
] as const;

async function googleApiFetch(config: GoogleGogConfig, url: string, init?: RequestInit) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: config.googleRefreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Failed to refresh Google token: ${tokenResponse.status} ${tokenResponse.statusText}`);
  }

  const tokenJson = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw new Error("Google token response missing access_token");

  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${tokenJson.access_token}`,
      ...(init?.headers ?? {}),
    },
  });
}

export async function searchDriveFiles(config: GoogleGogConfig, input: GoogleDriveSearchInput) {
  const qParts = [input.query];
  if (input.includeTrashed === false) qParts.push("trashed = false");
  if (input.mimeTypes?.length) qParts.push(`(${input.mimeTypes.map((m) => `mimeType='${m}'`).join(" or ")})`);

  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", qParts.filter(Boolean).join(" and "));
  url.searchParams.set("pageSize", String(input.pageSize ?? 10));
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))");
  if (input.driveId) url.searchParams.set("driveId", input.driveId);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  const res = await googleApiFetch(config, url.toString());
  if (!res.ok) throw new Error(`Drive search failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function readGoogleDoc(config: GoogleGogConfig, documentId: string) {
  const res = await googleApiFetch(config, `https://docs.googleapis.com/v1/documents/${documentId}`);
  if (!res.ok) throw new Error(`Docs read failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function getSheetMetadata(config: GoogleGogConfig, spreadsheetId: string) {
  const res = await googleApiFetch(
    config,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties,sheets(properties)`,
  );
  if (!res.ok) throw new Error(`Sheets metadata failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function readSheetRange(
  config: GoogleGogConfig,
  spreadsheetId: string,
  range: string,
  valueRenderOption: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA" = "FORMATTED_VALUE",
) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  url.searchParams.set("valueRenderOption", valueRenderOption);
  const res = await googleApiFetch(config, url.toString());
  if (!res.ok) throw new Error(`Sheets read failed: ${res.status} ${res.statusText}`);
  return res.json();
}
