/**
 * Auth Layer — OAuth 2.0 for Google User Accounts
 *
 * Handles the OAuth 2.0 authorization code flow for personal Google accounts.
 * Tokens are persisted to disk so the user only authenticates once.
 *
 * Flow:
 *   1. On first run, opens the browser to Google's consent screen.
 *   2. A temporary local HTTP server captures the authorization code.
 *   3. The code is exchanged for access + refresh tokens.
 *   4. Tokens are saved to ~/.poke-google-mcp/credentials.json.
 *   5. On subsequent runs, the refresh token is used automatically.
 */

import { google } from "googleapis";
import { OAuth2Client, Credentials } from "google-auth-library";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as url from "node:url";

// Read-only scopes — intentionally narrow for v1.
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

const CREDENTIALS_DIR = path.join(
  process.env.HOME ?? "~",
  ".poke-google-mcp"
);
const TOKEN_PATH = path.join(CREDENTIALS_DIR, "credentials.json");

const REDIRECT_PORT = 8976;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

function loadConfig(): OAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables.\n" +
        "Create OAuth 2.0 credentials at https://console.cloud.google.com/apis/credentials\n" +
        "and set them before starting the server."
    );
  }

  return { clientId, clientSecret };
}

function createOAuth2Client(config: OAuthConfig): OAuth2Client {
  return new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    REDIRECT_URI
  );
}

function loadSavedTokens(): Credentials | null {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const raw = fs.readFileSync(TOKEN_PATH, "utf-8");
      return JSON.parse(raw) as Credentials;
    }
  } catch {
    // Corrupted file — will re-auth.
  }
  return null;
}

function saveTokens(tokens: Credentials): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
  fs.chmodSync(TOKEN_PATH, 0o600);
}

/**
 * Opens a temporary HTTP server on localhost to capture the OAuth callback,
 * then exchanges the authorization code for tokens.
 */
async function authorizeInteractively(
  client: OAuth2Client
): Promise<Credentials> {
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.error(
    "\n┌─────────────────────────────────────────────────┐"
  );
  console.error(
    "│  Google OAuth — open this URL in your browser:  │"
  );
  console.error(
    "└─────────────────────────────────────────────────┘\n"
  );
  console.error(authUrl);
  console.error("");

  // Try to open the browser automatically (best-effort).
  try {
    const openModule = await import("open");
    await openModule.default(authUrl);
  } catch {
    // If 'open' isn't available, the user can click the URL above.
  }

  return new Promise<Credentials>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const parsedUrl = url.parse(req.url ?? "", true);
        if (parsedUrl.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = parsedUrl.query.code as string | undefined;
        if (!code) {
          res.writeHead(400);
          res.end("Missing authorization code.");
          reject(new Error("No authorization code in callback."));
          return;
        }

        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Authentication successful!</h2>" +
            "<p>You can close this tab and return to the terminal.</p></body></html>"
        );

        resolve(tokens);
      } catch (err) {
        res.writeHead(500);
        res.end("Authentication failed.");
        reject(err);
      } finally {
        server.close();
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.error(
        `Waiting for OAuth callback on http://localhost:${REDIRECT_PORT}/callback ...`
      );
    });

    // Timeout after 5 minutes.
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes."));
    }, 5 * 60 * 1000);
  });
}

/**
 * Returns an authenticated OAuth2Client ready to use with Google APIs.
 *
 * - Reuses saved tokens when available.
 * - Falls back to interactive browser-based auth.
 * - Automatically refreshes expired access tokens.
 */
export async function getAuthenticatedClient(): Promise<OAuth2Client> {
  const config = loadConfig();
  const client = createOAuth2Client(config);

  const saved = loadSavedTokens();
  if (saved) {
    client.setCredentials(saved);

    // Proactively refresh if access token is expired.
    if (saved.expiry_date && Date.now() >= saved.expiry_date - 60_000) {
      try {
        const { credentials } = await client.refreshAccessToken();
        client.setCredentials(credentials);
        saveTokens(credentials);
      } catch {
        // Refresh failed — re-auth.
        console.error("Token refresh failed; re-authenticating...");
        const tokens = await authorizeInteractively(client);
        client.setCredentials(tokens);
      }
    }

    return client;
  }

  // No saved tokens — interactive auth.
  const tokens = await authorizeInteractively(client);
  client.setCredentials(tokens);
  return client;
}

export { SCOPES };
