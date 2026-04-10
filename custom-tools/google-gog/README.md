Google Gog MCP scaffold

Purpose
- Search Google Drive files
- Read Google Docs
- Read Google Sheets metadata
- Read Google Sheets ranges

Architecture
- server.ts: API helpers for Drive, Docs, and Sheets
- mcp-server.ts: MCP server wrapper and tool call routing
- registration.ts: re-exportable registration notes and tool manifest
- index.ts: convenience exports

OAuth / connection notes
- Intended primary Google account: chris@everyday.inc
- Required read-only scopes:
  - drive.readonly
  - documents.readonly
  - spreadsheets.readonly
- This workspace does not currently expose a dedicated permissions flow for these scopes, so the server is scaffolded to accept standard Google OAuth env vars instead.

Environment variables expected by the wrapper
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REFRESH_TOKEN
- GOOGLE_REDIRECT_URI (optional)
- MCP_SERVER_NAME (optional)
- MCP_SERVER_VERSION (optional)

Current status
- Server helper layer: complete
- MCP wrapper + registration layer: complete
- Deployment / OAuth consent: still needed outside this workspace
