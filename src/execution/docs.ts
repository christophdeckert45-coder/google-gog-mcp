/**
 * Execution Layer — Google Docs API Client
 *
 * Reads Google Docs content by exporting via the Drive export API.
 * Supports plain text, HTML, and a basic markdown conversion.
 */

import { DriveClient } from "./drive.js";

const EXPORT_MIME: Record<string, string> = {
  text: "text/plain",
  html: "text/html",
  markdown: "text/html", // Export as HTML, then convert to markdown.
};

export class DocsClient {
  private drive: DriveClient;

  constructor(drive: DriveClient) {
    this.drive = drive;
  }

  /**
   * Read a Google Doc's content in the requested format.
   */
  async read(
    fileId: string,
    format: "text" | "markdown" | "html"
  ): Promise<string> {
    const exportMime = EXPORT_MIME[format];
    const raw = await this.drive.exportFile(fileId, exportMime);

    if (format === "markdown") {
      return htmlToBasicMarkdown(raw);
    }

    return raw;
  }
}

/**
 * Lightweight HTML → Markdown conversion.
 * Intentionally simple — handles headings, bold, italic, links, lists, and paragraphs.
 * Not a full-featured converter; suitable for Google Docs export output.
 */
function htmlToBasicMarkdown(html: string): string {
  let md = html;

  // Remove everything before <body> and after </body>.
  const bodyMatch = md.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) {
    md = bodyMatch[1];
  }

  // Strip style and script tags entirely.
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");

  // Headings.
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n");
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n");
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n");
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "#### $1\n\n");
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "##### $1\n\n");
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "###### $1\n\n");

  // Bold / italic.
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Links.
  md = md.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    "[$2]($1)"
  );

  // Unordered list items.
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  // Line breaks and paragraphs.
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");

  // Remove remaining HTML tags.
  md = md.replace(/<[^>]+>/g, "");

  // Decode common HTML entities.
  md = md
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse excessive blank lines.
  md = md.replace(/\n{3,}/g, "\n\n").trim();

  return md;
}
