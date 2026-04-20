/**
 * Execution Layer — Google Sheets API Client
 *
 * Reads spreadsheet metadata and cell ranges via the Sheets v4 API.
 * CSV export uses the Drive export endpoint.
 */

import { google, sheets_v4 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { DriveClient } from "./drive.js";

export interface SheetInfo {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  title: string;
  locale: string;
  sheets: SheetInfo[];
  spreadsheetUrl: string;
}

export interface SheetRangeResult {
  range: string;
  majorDimension: string;
  values: string[][];
}

export class SheetsClient {
  private sheets: sheets_v4.Sheets;
  private drive: DriveClient;

  constructor(auth: OAuth2Client, drive: DriveClient) {
    this.sheets = google.sheets({ version: "v4", auth });
    this.drive = drive;
  }

  /**
   * Get spreadsheet metadata: title, locale, and per-sheet info.
   */
  async getMetadata(fileId: string): Promise<SpreadsheetMetadata> {
    const res = await this.sheets.spreadsheets.get({
      spreadsheetId: fileId,
      fields:
        "spreadsheetId, properties(title, locale), sheets(properties(sheetId, title, gridProperties(rowCount, columnCount))), spreadsheetUrl",
    });

    const data = res.data;
    const sheets: SheetInfo[] = (data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title: s.properties?.title ?? "",
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    }));

    return {
      spreadsheetId: data.spreadsheetId ?? fileId,
      title: data.properties?.title ?? "",
      locale: data.properties?.locale ?? "",
      sheets,
      spreadsheetUrl: data.spreadsheetUrl ?? "",
    };
  }

  /**
   * Read a specific range of cells. Returns raw string values.
   */
  async readRange(
    fileId: string,
    range: string
  ): Promise<SheetRangeResult> {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: fileId,
      range,
      valueRenderOption: "FORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });

    return {
      range: res.data.range ?? range,
      majorDimension: res.data.majorDimension ?? "ROWS",
      values: (res.data.values as string[][]) ?? [],
    };
  }

  /**
   * Export a single sheet tab as CSV using the Drive export endpoint.
   */
  async exportAsCsv(fileId: string, sheetId: number): Promise<string> {
    // The Drive export API exports the first sheet by default.
    // To export a specific sheet, we append gid= to the export link.
    // Since googleapis doesn't support gid natively on export,
    // we use a direct HTTP request via the Drive client's export method
    // which exports the default sheet, then we use the Sheets API
    // to read all values and format as CSV if a non-default sheet is needed.
    if (sheetId === 0) {
      return this.drive.exportFile(fileId, "text/csv");
    }

    // For non-default sheets, read all values and convert to CSV.
    const metadata = await this.getMetadata(fileId);
    const sheet = metadata.sheets.find((s) => s.sheetId === sheetId);
    if (!sheet) {
      throw new Error(
        `Sheet with ID ${sheetId} not found. Available sheets: ${metadata.sheets
          .map((s) => `${s.title} (id=${s.sheetId})`)
          .join(", ")}`
      );
    }

    const rangeResult = await this.readRange(fileId, sheet.title);
    return valuesToCsv(rangeResult.values);
  }
}

/**
 * Convert a 2D array of strings to CSV format.
 */
function valuesToCsv(values: string[][]): string {
  return values
    .map((row) =>
      row
        .map((cell) => {
          // Escape cells containing commas, quotes, or newlines.
          if (/[",\n\r]/.test(cell)) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          return cell;
        })
        .join(",")
    )
    .join("\n");
}
