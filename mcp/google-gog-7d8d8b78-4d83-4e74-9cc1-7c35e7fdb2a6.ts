// @ts-nocheck
/**
 * MCP Integration: google-gog
 * Server: /api/mcp
 */
import { callFunction, type CallToolResult } from './call-function.ts';

const CONNECTION_ID = 'google-gog';

export interface GoogleDriveSearchFilesInput {
  query: string;
  pageSize?: number;
  driveId?: string;
  mimeTypes?: string[];
  includeTrashed?: boolean;
  account?: 'pro' | 'personal';
}

export async function googleDriveSearchFiles(params: GoogleDriveSearchFilesInput): Promise<CallToolResult> {
  return await callFunction(CONNECTION_ID, 'google_drive_search_files', params);
}

export interface GoogleDocsReadInput {
  documentId: string;
  account?: 'pro' | 'personal';
}

export async function googleDocsRead(params: GoogleDocsReadInput): Promise<CallToolResult> {
  return await callFunction(CONNECTION_ID, 'google_docs_read', params);
}

export interface GoogleSheetsGetMetadataInput {
  spreadsheetId: string;
  account?: 'pro' | 'personal';
}

export async function googleSheetsGetMetadata(params: GoogleSheetsGetMetadataInput): Promise<CallToolResult> {
  return await callFunction(CONNECTION_ID, 'google_sheets_get_metadata', params);
}

export interface GoogleSheetsReadRangeInput {
  spreadsheetId: string;
  range: string;
  valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
  account?: 'pro' | 'personal';
}

export async function googleSheetsReadRange(params: GoogleSheetsReadRangeInput): Promise<CallToolResult> {
  return await callFunction(CONNECTION_ID, 'google_sheets_read_range', params);
}

export interface GoogleSheetsWriteRangeInput {
  spreadsheetId: string;
  range: string;
  values: unknown[][];
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  account?: 'pro' | 'personal';
}

export async function googleSheetsWriteRange(params: GoogleSheetsWriteRangeInput): Promise<CallToolResult> {
  return await callFunction(CONNECTION_ID, 'google_sheets_write_range', params);
}
