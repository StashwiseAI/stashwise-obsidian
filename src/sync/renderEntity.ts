// WikiEntity -> the Stashwise-owned half of a topic note.
//
// Mirrors `wiki_export._build_page_markdown`, because a user who previously
// unzipped GET /wiki/export should recognise these files rather than find a
// parallel set beside them.

import type { SyncEntity } from "../api/types.js";
import { markdownLink } from "../search/insert.js";
import { normalizeTimestamp, yamlScalar } from "./renderSave.js";

export function renderEntityFrontmatter(entity: SyncEntity): string {
  const lines = [
    `stashwise_id: ${entity.id}`,
    "stashwise_type: topic",
    `category: ${yamlScalar(entity.category)}`,
  ];
  if (entity.canonical_form) {
    lines.push(`canonical_form: ${yamlScalar(entity.canonical_form)}`);
  }
  lines.push(`mention_count: ${entity.mention_count}`);
  lines.push(`version: ${entity.version}`);
  lines.push(`source_count: ${entity.sources.length}`);
  lines.push(`updated_at: ${yamlScalar(normalizeTimestamp(entity.updated_at))}`);
  // Category doubles as a tag so Dataview queries like
  // `TABLE mention_count WHERE contains(tags, "concept")` work, matching the
  // convention wiki_export already established.
  lines.push(`tags: [${yamlScalar(entity.category)}]`);
  return lines.join("\n");
}

export function renderEntityBody(entity: SyncEntity): string {
  const sections: string[] = [`# ${entity.name}`];

  const summary = (entity.summary ?? "").trim();
  sections.push(summary || "_No summary yet._");

  if (entity.related.length) {
    // Deduplicate by target: the same pair can carry several relationship
    // types, and rendering each one produces near-identical bullets.
    const seen = new Set<string>();
    const bullets: string[] = [];
    for (const related of entity.related) {
      if (seen.has(related.id)) continue;
      seen.add(related.id);
      bullets.push(`- [[${related.name}]] _(${related.label})_`);
    }
    sections.push(`## Related\n${bullets.join("\n")}`);
  }

  if (entity.sources.length) {
    const bullets = entity.sources
      .map((source) => `- ${markdownLink(source.title ?? "Untitled", source.source_url)}`)
      .join("\n");
    sections.push(`## Sources\n${bullets}`);
  }

  return sections.join("\n\n");
}
