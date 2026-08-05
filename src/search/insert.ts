// Turning a search result into text to drop into a note.
//
// The backend's `citation` field is plain text shaped "Title — host", built for
// LLM context where a bare URL is noise. A markdown note wants the opposite: a
// real clickable link. So these formats are built here, and `citation` is only
// a fallback for a result that has no URL at all.
//
// Pure by design: no Obsidian import, so every escaping rule below is tested.

import type { AgentSearchResultItem } from "../api/types.js";

export type InsertStyle = "link" | "quote";

/**
 * Escape markdown link text.
 *
 * A `]` inside the text terminates the link early and leaves the URL sitting in
 * the note as visible junk. Titles come from arbitrary scraped pages, so this
 * is a matter of when, not if.
 */
export function escapeLinkText(text: string): string {
  return text.replace(/([[\]\\])/g, "\\$1");
}

/**
 * Wrap a URL for markdown link syntax.
 *
 * Spaces and parentheses break the `(...)` form. Angle brackets are the
 * standard escape hatch, and a URL containing a literal `>` gets percent
 * encoded because nothing else can rescue it.
 */
export function escapeLinkUrl(url: string): string {
  if (!/[ ()<>]/.test(url)) return url;
  return `<${url.replace(/>/g, "%3E")}>`;
}

/** `[Title](url)`, degrading to bare escaped text when there is no URL. */
export function markdownLink(title: string, url: string | null): string {
  const safeTitle = escapeLinkText(title.trim() || "Untitled");
  if (!url) return safeTitle;
  return `[${safeTitle}](${escapeLinkUrl(url)})`;
}

/** Prefix every line so a multi-line snippet stays inside the callout. */
function asCalloutBody(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  return lines.map((line) => `> ${line}`.trimEnd()).join("\n");
}

/**
 * Render a result for insertion at the cursor.
 *
 * `link` gives an inline reference to drop mid-sentence. `quote` gives a block
 * callout carrying the snippet plus attribution, for when the point is the
 * content rather than the pointer.
 */
export function formatInsert(item: AgentSearchResultItem, style: InsertStyle): string {
  const link = markdownLink(item.title, item.source_url);

  if (style === "link") {
    return link;
  }

  const snippet = item.snippet?.trim();
  if (!snippet) {
    // Nothing to quote. An empty callout would be worse than just the link.
    return link;
  }
  return `> [!quote] ${link}\n${asCalloutBody(snippet)}`;
}

/**
 * Short label for the result list: where this came from and how recently.
 * Purely cosmetic, so it stays quiet when the backend sends nulls.
 */
export function describeSource(item: AgentSearchResultItem): string {
  const parts: string[] = [];
  if (item.kind === "entity") {
    parts.push("Wiki topic");
  } else if (item.source_platform) {
    parts.push(item.source_platform);
  }
  if (item.saved_at) {
    const date = new Date(item.saved_at);
    if (!Number.isNaN(date.getTime())) {
      parts.push(date.toLocaleDateString());
    }
  }
  return parts.join(" · ");
}
