/**
 * Execution Layer — Client Factory
 *
 * Creates all Google API clients from a single authenticated OAuth2Client.
 * This is the only place where client instantiation happens.
 */

export { DriveClient } from "./drive.js";
export { DocsClient } from "./docs.js";
export { SheetsClient } from "./sheets.js";

export type { DriveFile, DriveSearchResult } from "./drive.js";
export type {
  SheetInfo,
  SpreadsheetMetadata,
  SheetRangeResult,
} from "./sheets.js";
