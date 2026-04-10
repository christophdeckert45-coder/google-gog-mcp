export { gogToolManifest } from "./server.js";
export { createGoogleGogServer, runGoogleGogServer } from "./mcp-server.js";

export const googleGogRegistrationNotes = {
  oauthScopes: [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ],
  intendedPrimaryAccount: "chris@everyday.inc",
  description:
    "Registers Google Drive, Docs, and Sheets read-only tools behind an MCP server wrapper, using the google-gog architecture scaffold.",
} as const;
