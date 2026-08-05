import { App, MarkdownView, Notice, SuggestModal } from "obsidian";
import type { AgentSearchResultItem, SearchScope } from "../api/types.js";
import { describeSource, formatInsert, type InsertStyle } from "../search/insert.js";
import { createLatestOnly } from "../search/latestOnly.js";
import type { StashwisePlugin } from "../main.js";

const RESULT_COUNT = 12;

/**
 * Keyboard-only search: open, type, press Enter, the text is in the note.
 *
 * SuggestModal calls getSuggestions on every keystroke and already debounces
 * rendering, but it does not guard against out-of-order responses, so the same
 * latest-only wrapper the sidebar uses applies here too.
 */
export class StashwiseSearchModal extends SuggestModal<AgentSearchResultItem> {
  private readonly runLatest = createLatestOnly<AgentSearchResultItem[]>();

  constructor(
    app: App,
    private readonly plugin: StashwisePlugin,
    private readonly style: InsertStyle,
    private readonly searchScope: SearchScope = "all",
  ) {
    super(app);
    this.setPlaceholder(
      style === "quote" ? "Search Stashwise to quote" : "Search Stashwise to link",
    );
    this.emptyStateText = "Nothing found.";
  }

  async getSuggestions(query: string): Promise<AgentSearchResultItem[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const token = this.plugin.settings.token;
    if (!token) {
      new Notice("Connect your Stashwise account in settings first.");
      return [];
    }

    try {
      const results = await this.runLatest(
        this.plugin.api
          .search(token, trimmed, RESULT_COUNT, this.searchScope)
          .then((response) => response.results),
      );
      // Superseded by a newer keystroke. Returning the previous list would make
      // the modal flicker back to stale results.
      return results ?? [];
    } catch (error) {
      new Notice(
        `Stashwise search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  renderSuggestion(item: AgentSearchResultItem, el: HTMLElement): void {
    el.createDiv({ cls: "stashwise-result-title", text: item.title || "Untitled" });
    const source = describeSource(item);
    if (source) {
      el.createDiv({ cls: "stashwise-result-source", text: source });
    }
    if (item.snippet) {
      el.createDiv({ cls: "stashwise-result-snippet", text: item.snippet });
    }
  }

  onChooseSuggestion(item: AgentSearchResultItem): void {
    // A modal does not steal the active leaf the way a sidebar does, so the
    // ordinary lookup is correct here.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a note first, then insert.");
      return;
    }
    view.editor.replaceSelection(formatInsert(item, this.style));
  }
}
