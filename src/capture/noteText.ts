// Parsing a vault note into something Stashwise can store.
//
// Split out from commands.ts, which imports the Obsidian API and so cannot be
// unit tested. Every rule here is about interpreting text the user wrote, which
// is exactly the part worth pinning down with tests.

/** Longest URL-looking token in a blob of text. */
export function findUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>()[\]"']+/g);
  if (!matches?.length) return null;
  // Trailing punctuation is almost always sentence punctuation, not URL.
  return matches[0].replace(/[.,;:!?]+$/, "");
}

/**
 * Split a note into a title and a body.
 *
 * Prefers a leading `# Heading` over the filename, since the filename is often
 * a date or a slug while the heading is what the user actually called it.
 * Frontmatter is dropped: it is vault metadata, not part of the note's content.
 */
export function extractNote(
  raw: string,
  fallbackTitle: string,
): { title: string; body: string } {
  let text = raw;

  const frontmatter = text.match(/^---\n[\s\S]*?\n---\n?/);
  if (frontmatter) text = text.slice(frontmatter[0].length);

  const heading = text.match(/^\s*#\s+(.+)$/m);
  const title = heading ? heading[1].trim() : fallbackTitle;
  const body = heading ? text.replace(heading[0], "").trim() : text.trim();

  return { title: title || fallbackTitle, body };
}

/** Read `stashwise_id` out of a note's frontmatter, if it was captured before. */
export function readStashwiseId(raw: string): string | null {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;
  const match = frontmatter[1].match(/^stashwise_id:\s*(.+)$/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** Add or replace `stashwise_id` so a second capture updates instead of duplicating. */
export function withStashwiseId(raw: string, id: string): string {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatter) {
    return `---\nstashwise_id: ${id}\n---\n\n${raw}`;
  }
  const body = frontmatter[1];
  const updated = /^stashwise_id:/m.test(body)
    ? body.replace(/^stashwise_id:.*$/m, `stashwise_id: ${id}`)
    : `${body}\nstashwise_id: ${id}`;
  return raw.replace(frontmatter[0], `---\n${updated}\n---\n`);
}
