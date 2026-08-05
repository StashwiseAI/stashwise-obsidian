// Content -> the Stashwise-owned half of a vault note.
//
// Renders only the managed region and the frontmatter. The user zone is never
// this file's business; managedBlock.ts splices the two together.

import type { SyncContent, SyncEntityRelated } from "../api/types.js";
import { markdownLink } from "../search/insert.js";

/**
 * Minimal YAML scalar quoting, ported from `wiki_export._yaml_scalar`.
 *
 * Titles are scraped from arbitrary web pages, so a leading `-`, an embedded
 * `:` or a stray quote is routine. Unquoted, any of them makes the frontmatter
 * unparseable and Obsidian shows the note as broken.
 */
export function yamlScalar(value: string): string {
  if (!value) return '""';
  const needsQuote =
    /[:#{}[\],&*?|<>=!%@`'"\\-]/.test(value) || value !== value.trim();
  if (!needsQuote) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlList(values: string[]): string {
  if (values.length === 0) return "[]";
  return `[${values.map(yamlScalar).join(", ")}]`;
}

/**
 * Give a timestamp an explicit UTC offset when the server sent none.
 *
 * `DateTime(timezone=True)` round-trips aware on Postgres and naive on SQLite,
 * and content timestamps reach us through the shared ContentResponse, which
 * cannot be changed for one client. Without this, a note written against local
 * dev carries `2026-08-02T07:34:33` and every Dataview date query reads it as
 * local time, while the same note from prod carries a `Z` and reads as UTC.
 */
export function normalizeTimestamp(value: string): string {
  // Already carries Z or a +/-HH:MM offset.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  return `${value}Z`;
}

export function renderSaveFrontmatter(
  item: SyncContent,
  options: { topics?: string[] } = {},
): string {
  const lines = [
    `stashwise_id: ${item.id}`,
    "stashwise_type: save",
    `source_url: ${yamlScalar(item.source_url)}`,
    `source_platform: ${yamlScalar(item.source_platform)}`,
  ];
  if (item.created_at) {
    lines.push(`saved_at: ${yamlScalar(normalizeTimestamp(item.created_at))}`);
  }
  if (item.updated_at) {
    lines.push(`updated_at: ${yamlScalar(normalizeTimestamp(item.updated_at))}`);
  }
  if (item.analysis_state) {
    lines.push(`analysis_state: ${yamlScalar(item.analysis_state)}`);
  }
  if (item.tags.length) lines.push(`tags: ${yamlList(item.tags)}`);
  if (options.topics?.length) lines.push(`topics: ${yamlList(options.topics)}`);
  return lines.join("\n");
}

/**
 * The managed body.
 *
 * `summary_core_markdown` wins over `summary` where present: the enrichment
 * redesign splits the core summary from appended context, and the legacy
 * `summary` string is only a fallback for rows predating the migration.
 */
export function renderSaveBody(
  item: SyncContent,
  options: { topics?: SyncEntityRelated[] } = {},
): string {
  const sections: string[] = [];
  const title = (item.title ?? "").trim() || "Untitled";
  sections.push(`# ${title}`);

  sections.push(`> [!info] Source\n> ${markdownLink(title, item.source_url)}`);

  if (item.analysis_state === "raw") {
    // A raw save has no summary and never will until it is reanalyzed. Saying
    // so beats leaving a note that looks like the analysis silently failed.
    sections.push(
      "> [!warning] Not analyzed\n" +
        "> This was saved past your monthly analysis limit. Reanalyze it in " +
        "Stashwise to fill in the summary and add it to your wiki.",
    );
  }

  const summary = (item.summary_core_markdown ?? item.summary ?? "").trim();
  if (summary) {
    sections.push(summary);
  } else if (item.analysis_state !== "raw" && item.status !== "completed") {
    sections.push("_Still being analyzed._");
  }

  if (item.takeaways?.length) {
    const bullets = item.takeaways
      .map((takeaway) => {
        const stamp = takeaway.timestamp ? ` _(${takeaway.timestamp})_` : "";
        return `- ${takeaway.text}${stamp}`;
      })
      .join("\n");
    sections.push(`## Key takeaways\n${bullets}`);
  }

  if (options.topics?.length) {
    const links = options.topics
      .map((topic) => `[[${topic.name}]]`)
      .join(", ");
    sections.push(`## Topics\n${links}`);
  }

  return sections.join("\n\n");
}
