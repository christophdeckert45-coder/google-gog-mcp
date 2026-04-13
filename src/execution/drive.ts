/**
 * Execution Layer — Google Drive API Client
 *
 * Direct, thin wrapper around the Google Drive v3 API.
 * No business logic here — just API calls and typed returns.
 */

import { google, drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
  owners?: Array<{ displayName: string; emailAddress: string }>;
}

export interface DriveSearchResult {
  files: DriveFile[];
  nextPageToken?: string;
  totalEstimate?: number;
}

export class DriveClient {
  private drive: drive_v3.Drive;

  constructor(auth: OAuth2Client) {
    this.drive = google.drive({ version: "v3", auth });
  }

  /**
   * Search files using the Drive API query syntax.
   * Plain-text queries are wrapped in a fullText search automatically.
   */
  async search(
    query: string,
    pageSize: number,
    pageToken?: string
  ): Promise<DriveSearchResult> {
    // Detect whether the query looks like Drive query syntax.
    const isDriveQuery =
      /\b(name|mimeType|fullText|modifiedTime|createdTime|trashed)\b\s*(=|!=|contains|<|>|<=|>=|in|not)\b/i.test(
        query
      );

    const q = isDriveQuery
      ? `${query} and trashed = false`
      : `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`;

    const res = await this.drive.files.list({
      q,
      pageSize,
      pageToken,
      fields:
        "nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink, owners(displayName, emailAddress))",
      orderBy: "modifiedTime desc",
    });

    const files: DriveFile[] = (res.data.files ?? []).map((f) => ({
      id: f.id ?? "",
      name: f.name ?? "",
      mimeType: f.mimeType ?? "",
      modifiedTime: f.modifiedTime ?? "",
      size: f.size ?? undefined,
      webViewLink: f.webViewLink ?? undefined,
      owners: f.owners?.map((o) => ({
        displayName: o.displayName ?? "",
        emailAddress: o.emailAddress ?? "",
      })),
    }));

    return {
      files,
      nextPageToken: res.data.nextPageToken ?? undefined,
    };
  }

  /**
   * Export a Google Workspace file to a given MIME type.
   * Works for Docs, Sheets, Slides, etc.
   */
  async exportFile(fileId: string, mimeType: string): Promise<string> {
    const res = await this.drive.files.export(
      { fileId, mimeType },
      { responseType: "text" }
    );
    return res.data as string;
  }

  /**
   * Download a binary/non-Workspace file's content.
   */
  async downloadFile(fileId: string): Promise<string> {
    const res = await this.drive.files.get(
      { fileId, alt: "media" },
      { responseType: "text" }
    );
    return res.data as string;
  }
}
