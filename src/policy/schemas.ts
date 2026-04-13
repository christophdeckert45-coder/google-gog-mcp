/**
 * Policy Layer — Tool Schemas
 *
 * Defines the typed input schemas for every tool the server exposes.
 * This is the single source of truth for what the MCP surface accepts.
 * Keep this file narrow: search + read only (no write/delete).
 *
 * Architecture note (clawchief/gog style):
 *   Policy defines WHAT is allowed.
 *   Orchestration decides HOW to satisfy a request.
 *   Execution talks to the external API.
 */

import { z } from "zod";

// ──────────────────────────────────────────────
// Google Drive — search
// ──────────────────────────────────────────────

export const DriveSearchSchema = z.object({
  query: z
    .string()
    .describe(
      "Search query. Supports Google Drive search syntax (e.g. 'name contains \"report\"', 'mimeType = \"application/vnd.google-apps.spreadsheet\"'). Plain text is also accepted and will be matched against file names and content."
    ),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Maximum number of results to return (1–100, default 10)."),
  pageToken: z
    .string()
    .optional()
    .describe("Token for fetching the next page of results."),
});

export type DriveSearchInput = z.infer<typeof DriveSearchSchema>;

// ──────────────────────────────────────────────
// Google Docs — read / export
// ──────────────────────────────────────────────

export const DocsReadSchema = z.object({
  fileId: z
    .string()
    .describe("The Google Drive file ID of the document to read."),
  exportFormat: z
    .enum(["text", "markdown", "html"])
    .default("text")
    .describe(
      "Format to export the document as. 'text' returns plain text, 'markdown' returns a basic markdown conversion, 'html' returns raw HTML."
    ),
});

export type DocsReadInput = z.infer<typeof DocsReadSchema>;

// ──────────────────────────────────────────────
// Google Sheets — read metadata
// ──────────────────────────────────────────────

export const SheetsGetMetadataSchema = z.object({
  fileId: z
    .string()
    .describe("The Google Drive file ID of the spreadsheet."),
});

export type SheetsGetMetadataInput = z.infer<typeof SheetsGetMetadataSchema>;

// ──────────────────────────────────────────────
// Google Sheets — read range
// ──────────────────────────────────────────────

export const SheetsReadRangeSchema = z.object({
  fileId: z
    .string()
    .describe("The Google Drive file ID of the spreadsheet."),
  range: z
    .string()
    .describe(
      "A1 notation range to read (e.g. 'Sheet1!A1:D10'). Use the sheet name from sheets_get_metadata."
    ),
});

export type SheetsReadRangeInput = z.infer<typeof SheetsReadRangeSchema>;

// ──────────────────────────────────────────────
// Google Sheets — export as CSV
// ──────────────────────────────────────────────

export const SheetsExportSchema = z.object({
  fileId: z
    .string()
    .describe("The Google Drive file ID of the spreadsheet."),
  sheetId: z
    .number()
    .int()
    .default(0)
    .describe(
      "The numeric sheet (tab) ID to export. Defaults to 0 (first sheet). Use sheets_get_metadata to discover sheet IDs."
    ),
});

export type SheetsExportInput = z.infer<typeof SheetsExportSchema>;

// ──────────────────────────────────────────────
// Tool manifest — used by the orchestration layer
// to register tools with the MCP server.
// ──────────────────────────────────────────────

export const TOOL_MANIFEST = {
  drive_search: {
    name: "drive_search",
    description:
      "Search for files in the user's Google Drive. Returns file names, IDs, MIME types, and modification dates. Use the returned fileId with other tools to read content.",
    schema: DriveSearchSchema,
  },
  docs_read: {
    name: "docs_read",
    description:
      "Read the content of a Google Doc by exporting it as plain text, markdown, or HTML. Use drive_search first to find the fileId.",
    schema: DocsReadSchema,
  },
  sheets_get_metadata: {
    name: "sheets_get_metadata",
    description:
      "Get metadata about a Google Spreadsheet including sheet names, IDs, and row/column counts. Use this before sheets_read_range to discover available sheets and ranges.",
    schema: SheetsGetMetadataSchema,
  },
  sheets_read_range: {
    name: "sheets_read_range",
    description:
      "Read a specific range of cells from a Google Spreadsheet. Returns the values as a 2D array. Use sheets_get_metadata first to discover sheet names.",
    schema: SheetsReadRangeSchema,
  },
  sheets_export: {
    name: "sheets_export",
    description:
      "Export a single sheet (tab) from a Google Spreadsheet as CSV. Use sheets_get_metadata to find the sheetId for the tab you want.",
    schema: SheetsExportSchema,
  },
} as const;
