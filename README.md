# google-gog-mcp

MCP server that gives [Poke](https://poke.com) (and other MCP clients) read-only visibility into a user's Google Workspace — Drive search, Docs reading, and Sheets access.

Built with the **clawchief/gog** layered architecture: policy defines _what_ is allowed, orchestration decides _how_ to satisfy requests, and execution talks to Google APIs.

## Tool Surface (v1 — read-only)

| Tool | Description |
|------|-------------|
| `drive_search` | Search files in Google Drive by name, content, or MIME type |
| `docs_read` | Read a Google Doc as plain text, markdown, or HTML |
| `sheets_get_metadata` | Get spreadsheet metadata (sheet names, IDs, dimensions) |
| `sheets_read_range` | Read a specific cell range from a spreadsheet |
| `sheets_export` | Export a sheet tab as CSV |

All tools are **read-only**. No write, delete, or sharing operations are exposed in v1.

## Architecture

```
src/
├── policy/          # WHAT is allowed — Zod schemas, tool manifest
│   ├── schemas.ts   # Typed input schemas for every tool
│   └── index.ts
├── orchestration/   # HOW to satisfy requests — tool handlers
│   ├── handlers.ts  # Connects inputs to API clients, shapes responses
│   └── index.ts
├── execution/       # WHERE data comes from — Google API wrappers
│   ├── drive.ts     # Drive v3 API client
│   ├── docs.ts      # Docs export via Drive API
│   ├── sheets.ts    # Sheets v4 API client
│   └── index.ts
├── auth/
│   └── oauth.ts     # OAuth 2.0 authorization code flow
├── server.ts        # MCP server entry point (stdio + HTTP)
└── validate.ts      # Offline validation script
```

**Adding a new tool** means touching all three layers:
1. **Policy**: Add a Zod schema and manifest entry in `schemas.ts`
2. **Orchestration**: Add a handler in `handlers.ts`
3. **Execution**: Add or extend an API client in `execution/`
4. **Server**: Register the tool in `server.ts`

This separation keeps each layer testable and makes it easy to extend to Calendar, Gmail, etc. later.

## Prerequisites

- **Node.js 18+**
- **Google Cloud Project** with these APIs enabled:
  - Google Drive API
  - Google Docs API
  - Google Sheets API
- **OAuth 2.0 Client ID** (Desktop application type)

## Setup

### 1. Create Google OAuth Credentials

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials → OAuth client ID**
3. Select **Desktop application** as the application type
4. Note the **Client ID** and **Client Secret**
5. Go to [APIs & Services → Library](https://console.cloud.google.com/apis/library) and enable:
   - Google Drive API
   - Google Docs API
   - Google Sheets API

> **Why Desktop app?** This server runs locally and uses the OAuth authorization code flow with a localhost redirect. Service accounts can't access personal Drive content — Desktop app credentials let the user authenticate with their own Google account.

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Client ID and Client Secret
```

Or export directly:

```bash
export GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="your-client-secret"
```

### 3. Install & Build

```bash
npm install
npm run build:mcp
```

### 4. First Run (Authentication)

```bash
npm start
```

On first run, the server opens your browser to Google's consent screen. After granting access, tokens are saved to `~/.poke-google-mcp/credentials.json` and reused automatically.

**Scopes requested** (all read-only):
- `drive.readonly` — Search and export files
- `documents.readonly` — Read Google Docs
- `spreadsheets.readonly` — Read Google Sheets

## Running the Server

### stdio transport (local MCP clients)

```bash
npm start
# or for development:
npm run dev
```

### HTTP transport (Poke and remote clients)

```bash
npm run start:http
# or for development:
npm run dev:http
```

The HTTP server exposes:
- `GET /sse` — SSE endpoint for server-to-client messages
- `POST /messages?sessionId=...` — Client-to-server JSON-RPC messages
- `GET /health` — Health check

Default port is `8080`, configurable via the `PORT` environment variable.

## Connecting to Poke

### Option A: Local with stdio

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/path/to/poke-google-workspace-mcp",
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

### Option B: Remote HTTP (for Poke)

1. Deploy the server to a host with HTTPS (Render, Railway, Fly.io, etc.)
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as environment variables
3. In Poke, go to **Settings → Connections → Integrations → New**
4. Enter your server's SSE URL: `https://your-host.example.com/sse`

> **Important**: Poke requires HTTPS. Use a deployment platform that provides TLS automatically, or set up a reverse proxy with a valid certificate.

### Option C: Claude Desktop / Cursor

Add to `claude_desktop_config.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"],
      "cwd": "/path/to/poke-google-workspace-mcp",
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

## Validation

Run the offline validation suite (no Google credentials required):

```bash
npm run validate
```

This verifies:
- All tools are present in the manifest with descriptions and schemas
- Schemas accept valid inputs and reject invalid ones
- Default values are applied correctly
- All layers import cleanly

## Example Usage

Once connected, an AI assistant can:

```
"Search my Drive for quarterly reports"
→ drive_search { query: "quarterly report" }

"Read the Q1 planning doc"
→ docs_read { fileId: "1abc...", exportFormat: "markdown" }

"What sheets are in the budget spreadsheet?"
→ sheets_get_metadata { fileId: "1xyz..." }

"Show me rows 1-20 of the Revenue tab"
→ sheets_read_range { fileId: "1xyz...", range: "Revenue!A1:H20" }

"Export the Summary tab as CSV"
→ sheets_export { fileId: "1xyz...", sheetId: 456 }
```

## Extending for Calendar / Gmail

The architecture is designed to make this straightforward:

### Adding Google Calendar (example)

1. **Enable API**: Enable the Google Calendar API in your Google Cloud project
2. **Add scope**: Add `calendar.readonly` to `SCOPES` in `src/auth/oauth.ts`
3. **Execution**: Create `src/execution/calendar.ts` with a `CalendarClient` class
4. **Policy**: Add `CalendarListEventsSchema` to `src/policy/schemas.ts`
5. **Orchestration**: Add `handleCalendarListEvents` to `src/orchestration/handlers.ts`
6. **Server**: Register the new tool in `src/server.ts`

The same pattern applies for Gmail, People API, Tasks, etc.

### Adding write operations (v2)

When ready to add write capabilities:

1. Add new scopes (e.g. `drive` instead of `drive.readonly`)
2. Delete `~/.poke-google-mcp/credentials.json` to re-authenticate with broader scopes
3. Add execution methods, schemas, and handlers following the same three-layer pattern
4. Consider adding confirmation prompts or dry-run modes for destructive operations

## Security Notes

- Tokens are stored at `~/.poke-google-mcp/credentials.json` with `0600` permissions
- Only read-only scopes are requested — the server cannot modify your data
- The OAuth flow uses a temporary localhost HTTP server that shuts down after receiving the callback
- No credentials are logged or included in MCP responses

## License

MIT
