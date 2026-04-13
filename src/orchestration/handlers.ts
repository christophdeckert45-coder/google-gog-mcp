/**
 * Orchestration Layer — Tool Handlers
 *
 * Connects policy-defined tool inputs to execution-layer API clients.
 * Each handler validates input via the policy schema, calls the
 * appropriate execution client, and returns a structured result.
 *
 * Architecture note (clawchief/gog style):
 *   Handlers contain the "how" — they decide which execution calls
 *   to make and how to shape the response. They do NOT contain
 *   API details (that's execution) or schema definitions (that's policy).
 */

import type {
  DriveSearchInput,
  DocsReadInput,
  SheetsGetMetadataInput,
  SheetsReadRangeInput,
  SheetsExportInput,
} from "../policy/index.js";
import type { DriveClient } from "../execution/drive.js";
import type { DocsClient } from "../execution/docs.js";
import type { SheetsClient } from "../execution/sheets.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function textResult(data: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Wraps a handler function with standardized error handling.
 */
function withErrorHandling(
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  return fn().catch((err: unknown) => {
    const message =
      err instanceof Error ? err.message : String(err);

    // Surface Google API errors clearly.
    if (message.includes("404")) {
      return errorResult(
        "File not found. Verify the fileId is correct and that you have access to the file."
      );
    }
    if (message.includes("403")) {
      return errorResult(
        "Permission denied. The authenticated account does not have access to this file."
      );
    }
    if (message.includes("401")) {
      return errorResult(
        "Authentication expired. Restart the server to re-authenticate."
      );
    }
    if (message.includes("429")) {
      return errorResult(
        "Rate limit exceeded. Please wait a moment and try again."
      );
    }

    return errorResult(message);
  });
}

// ──────────────────────────────────────────────
// Handler implementations
// ──────────────────────────────────────────────

export function handleDriveSearch(
  drive: DriveClient,
  input: DriveSearchInput
): Promise<ToolResult> {
  return withErrorHandling(async () => {
    const result = await drive.search(
      input.query,
      input.pageSize,
      input.pageToken
    );

    if (result.files.length === 0) {
      return textResult({
        message: "No files found matching your query.",
        query: input.query,
        suggestion:
          "Try a broader search term, or use Drive query syntax like: name contains 'report'",
      });
    }

    return textResult({
      files: result.files,
      resultCount: result.files.length,
      nextPageToken: result.nextPageToken ?? null,
      hint: "Use the fileId from results with docs_read, sheets_get_metadata, or sheets_read_range to access file contents.",
    });
  });
}

export function handleDocsRead(
  docs: DocsClient,
  input: DocsReadInput
): Promise<ToolResult> {
  return withErrorHandling(async () => {
    const content = await docs.read(input.fileId, input.exportFormat);
    return textResult(content);
  });
}

export function handleSheetsGetMetadata(
  sheets: SheetsClient,
  input: SheetsGetMetadataInput
): Promise<ToolResult> {
  return withErrorHandling(async () => {
    const metadata = await sheets.getMetadata(input.fileId);
    return textResult({
      ...metadata,
      hint: "Use the sheet title in sheets_read_range (e.g. 'Sheet1!A1:D10') or sheetId in sheets_export.",
    });
  });
}

export function handleSheetsReadRange(
  sheets: SheetsClient,
  input: SheetsReadRangeInput
): Promise<ToolResult> {
  return withErrorHandling(async () => {
    const result = await sheets.readRange(input.fileId, input.range);

    if (result.values.length === 0) {
      return textResult({
        range: result.range,
        message: "The specified range is empty.",
        suggestion:
          "Use sheets_get_metadata to verify the sheet name and available rows/columns.",
      });
    }

    return textResult({
      range: result.range,
      rowCount: result.values.length,
      columnCount: Math.max(...result.values.map((r) => r.length)),
      values: result.values,
    });
  });
}

export function handleSheetsExport(
  sheets: SheetsClient,
  input: SheetsExportInput
): Promise<ToolResult> {
  return withErrorHandling(async () => {
    const csv = await sheets.exportAsCsv(input.fileId, input.sheetId);
    return textResult(csv);
  });
}
