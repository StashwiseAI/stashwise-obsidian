import {
  debounce,
  ItemView,
  MarkdownView,
  Notice,
  setIcon,
  WorkspaceLeaf,
} from "obsidian";
import type { AgentSearchResultItem, SearchScope } from "../api/types.js";
import { describeSource, formatInsert, type InsertStyle } from "../search/insert.js";
import { createLatestOnly } from "../search/latestOnly.js";
import type { StashwisePlugin } from "../main.js";

export const STASHWISE_SEARCH_VIEW = "stashwise-search";

const RESULT_COUNT = 12;
const DEBOUNCE_MS = 300;

export class StashwiseSearchView extends ItemView {
  private query = "";
  private searchScope: SearchScope = "all";
  private results: AgentSearchResultItem[] = [];
  private state: "idle" | "loading" | "error" = "idle";
  private errorMessage = "";
  private resultsEl!: HTMLElement;

  /** Discards responses the user has already outrun. See latestOnly.ts. */
  private readonly runLatest = createLatestOnly<AgentSearchResultItem[]>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: StashwisePlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return STASHWISE_SEARCH_VIEW;
  }

  getDisplayText(): string {
    return "Stashwise";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("stashwise-search-view");

    this.renderControls(container);
    this.resultsEl = container.createDiv({ cls: "stashwise-results" });
    this.renderResults();
  }

  private renderControls(container: HTMLElement): void {
    const controls = container.createDiv({ cls: "stashwise-search-controls" });

    const input = controls.createEl("input", {
      type: "search",
      cls: "stashwise-search-input",
      attr: { placeholder: "Search your Stashwise library" },
    });

    const runSearch = debounce(
      () => void this.search(),
      DEBOUNCE_MS,
      // Reset the timer on every keystroke so we fire once the user pauses,
      // not once per burst of typing.
      true,
    );

    input.addEventListener("input", () => {
      this.query = input.value;
      runSearch();
    });
    // Enter should not wait out the debounce.
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.query = input.value;
        void this.search();
      }
    });

    const scopeSelect = controls.createEl("select", { cls: "dropdown" });
    for (const [value, label] of [
      ["all", "Everything"],
      ["library", "Saves"],
      ["wiki", "Wiki topics"],
    ] as const) {
      scopeSelect.createEl("option", { value, text: label });
    }
    scopeSelect.value = this.searchScope;
    scopeSelect.addEventListener("change", () => {
      this.searchScope = scopeSelect.value as SearchScope;
      if (this.query.trim()) void this.search();
    });
  }

  private async search(): Promise<void> {
    const query = this.query.trim();
    if (!query) {
      this.results = [];
      this.state = "idle";
      this.renderResults();
      return;
    }

    const token = this.plugin.settings.token;
    if (!token) {
      this.state = "error";
      this.errorMessage = "Connect your Stashwise account in settings first.";
      this.renderResults();
      return;
    }

    this.state = "loading";
    this.renderResults();

    try {
      const results = await this.runLatest(
        this.plugin.api
          .search(token, query, RESULT_COUNT, this.searchScope)
          .then((response) => response.results),
      );
      // null means a newer search already landed; leave its results alone.
      if (results === null) return;

      this.results = results;
      this.state = "idle";
    } catch (error) {
      this.state = "error";
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }
    this.renderResults();
  }

  private renderResults(): void {
    const el = this.resultsEl;
    if (!el) return;
    el.empty();

    if (this.state === "loading") {
      el.createDiv({ cls: "stashwise-empty", text: "Searching..." });
      return;
    }
    if (this.state === "error") {
      el.createDiv({ cls: "stashwise-empty stashwise-error", text: this.errorMessage });
      return;
    }
    if (!this.query.trim()) {
      el.createDiv({
        cls: "stashwise-empty",
        text: "Search your saves and wiki topics, then insert them into any note.",
      });
      return;
    }
    if (this.results.length === 0) {
      el.createDiv({ cls: "stashwise-empty", text: "Nothing found." });
      return;
    }

    for (const item of this.results) {
      this.renderResult(el, item);
    }
  }

  private renderResult(parent: HTMLElement, item: AgentSearchResultItem): void {
    const row = parent.createDiv({ cls: "stashwise-result" });

    row.createDiv({ cls: "stashwise-result-title", text: item.title || "Untitled" });

    const source = describeSource(item);
    if (source) {
      row.createDiv({ cls: "stashwise-result-source", text: source });
    }
    if (item.snippet) {
      row.createDiv({ cls: "stashwise-result-snippet", text: item.snippet });
    }

    const actions = row.createDiv({ cls: "stashwise-result-actions" });
    this.addResultAction(actions, "link", "Insert link", () => this.insert(item, "link"));
    this.addResultAction(actions, "quote", "Insert quote", () => this.insert(item, "quote"));
    if (item.source_url) {
      this.addResultAction(actions, "external-link", "Open source", () => {
        window.open(item.source_url as string, "_blank");
      });
    }
  }

  private addResultAction(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): void {
    const button = parent.createEl("button", {
      cls: "stashwise-action clickable-icon",
      attr: { "aria-label": label },
    });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
  }

  private insert(item: AgentSearchResultItem, style: InsertStyle): void {
    // getActiveViewOfType would return null here: clicking this button made the
    // sidebar the active leaf. getMostRecentLeaf looks at the main editor area,
    // which is where the user actually wants the text to land.
    const view = this.app.workspace.getMostRecentLeaf()?.view;
    if (!(view instanceof MarkdownView)) {
      new Notice("Open a note first, then insert.");
      return;
    }
    view.editor.replaceSelection(formatInsert(item, style));
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
