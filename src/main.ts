import { Notice, Plugin, requestUrl, WorkspaceLeaf } from "obsidian";
import { StashwiseApi, visibleTokenPrefix, type Transport } from "./api/client.js";
import { runDeviceAuth } from "./auth/deviceAuth.js";
import { activeMarkdownFile, captureCurrentNote, captureUrl } from "./capture/commands.js";
import {
  DEFAULT_SETTINGS,
  StashwiseSettingTab,
  type StashwiseSettings,
} from "./settings.js";
import { SyncEngine, type SyncReport } from "./sync/engine.js";
import { ObsidianStateAdapter, ObsidianVaultIO } from "./sync/obsidianVault.js";
import { SyncStateStore } from "./sync/state.js";
import { StashwiseSearchModal } from "./views/searchModal.js";
import { STASHWISE_SEARCH_VIEW, StashwiseSearchView } from "./views/searchView.js";

/**
 * The single adapter between our pure client and the Obsidian host.
 *
 * `throw: false` is load-bearing. requestUrl rejects on any 400+ by default,
 * which would discard the response body, and the body is exactly where the
 * backend puts the message we need to show (a save-cap explanation, an auth
 * failure reason). We map status codes ourselves instead.
 */
const obsidianTransport: Transport = async (req) => {
  const response = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  return { status: response.status, text: response.text ?? "" };
};

/** Wait this long after load before the first sync, so startup is not blocked. */
const STARTUP_SYNC_DELAY_MS = 4000;

export class StashwisePlugin extends Plugin {
  settings: StashwiseSettings = { ...DEFAULT_SETTINGS };
  api!: StashwiseApi;

  private engine!: SyncEngine;
  private store!: SyncStateStore;
  private syncTimer: number | null = null;
  /** Guards against a manual sync racing the timer or the foreground trigger. */
  private syncing = false;
  private lastSyncAt = 0;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.api = new StashwiseApi(obsidianTransport, () => this.settings.apiBaseUrl);

    this.store = new SyncStateStore(
      new ObsidianStateAdapter(this.app),
      `${this.app.vault.configDir}/plugins/stashwise/sync-state.json`,
    );
    await this.store.load();
    this.engine = new SyncEngine(this.api, new ObsidianVaultIO(this.app), this.store);

    this.addSettingTab(new StashwiseSettingTab(this.app, this));
    this.registerView(
      STASHWISE_SEARCH_VIEW,
      (leaf) => new StashwiseSearchView(leaf, this),
    );
    this.addRibbonIcon("search", "Search Stashwise", () => void this.openSearchView());
    this.registerCommands();

    // Mobile has no background execution, so returning to the app is the only
    // moment a phone can notice that something was saved elsewhere. This is
    // what makes "save in the Stashwise app, open Obsidian, the note is there"
    // actually work.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const interval = this.settings.syncIntervalMinutes;
      if (interval <= 0) return;
      if (Date.now() - this.lastSyncAt < interval * 60_000) return;
      void this.syncNow({ silent: true });
    });

    this.restartSyncTimer();

    if (this.isConnected) {
      // Deferred: syncing during onload would stall Obsidian's startup.
      this.registerInterval(
        window.setTimeout(() => void this.syncNow({ silent: true }), STARTUP_SYNC_DELAY_MS),
      );
    }
  }

  onunload(): void {
    this.clearSyncTimer();
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-search",
      name: "Open search panel",
      callback: () => void this.openSearchView(),
    });
    this.addCommand({
      id: "insert-link",
      name: "Search and insert a link",
      editorCallback: () => new StashwiseSearchModal(this.app, this, "link").open(),
    });
    this.addCommand({
      id: "insert-quote",
      name: "Search and insert a quote",
      editorCallback: () => new StashwiseSearchModal(this.app, this, "quote").open(),
    });
    this.addCommand({
      id: "connect-account",
      name: "Connect account",
      callback: () => void this.connect(),
    });
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "full-resync",
      name: "Full resync",
      callback: () => void this.syncNow({ full: true }),
    });
    this.addCommand({
      id: "save-note",
      name: "Save current note",
      checkCallback: (checking) => {
        const file = activeMarkdownFile(this);
        if (!file) return false;
        if (!checking) void captureCurrentNote(this, file);
        return true;
      },
    });
    this.addCommand({
      id: "save-url",
      name: "Save URL",
      editorCallback: (editor) => void captureUrl(this, editor),
    });
  }

  async openSearchView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(STASHWISE_SEARCH_VIEW);

    let leaf: WorkspaceLeaf | null;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      // getRightLeaf(false) returns null on mobile when no right sidebar exists,
      // so fall back to a regular leaf rather than silently doing nothing.
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: STASHWISE_SEARCH_VIEW, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    // loadData() is typed `any`, so narrow before merging rather than letting
    // arbitrary shapes into settings.
    const stored = (await this.loadData()) as Partial<StashwiseSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  get isConnected(): boolean {
    return Boolean(this.settings.token);
  }

  /** Vault name rather than hostname, since node:os is off-limits on mobile. */
  private clientLabel(): string {
    return `Stashwise for Obsidian (${this.app.vault.getName()})`;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      new Notice("Stashwise is already connected. Disconnect first to switch accounts.");
      return;
    }

    const result = await runDeviceAuth(
      this.app,
      this.api,
      this.clientLabel(),
      this.settings.webBaseUrl,
    );

    switch (result.kind) {
      case "authorized": {
        this.settings.token = result.token;
        this.settings.account = result.user ?? null;
        await this.saveSettings();
        const who = result.user?.email ?? result.user?.display_name ?? "your account";
        new Notice(`Stashwise connected as ${who}.`);
        this.restartSyncTimer();
        void this.syncNow();
        break;
      }
      case "expired":
        new Notice("That sign-in code expired. Try connecting again.");
        break;
      case "timeout":
        new Notice("Timed out waiting for authorization.");
        break;
      case "cancelled":
        break;
      case "failed":
        new Notice(`Stashwise sign-in failed: ${result.message}`);
        break;
    }
  }

  /**
   * Accept a token the user pasted, after checking it actually works.
   *
   * Validating first matters because the failure it prevents is silent: a
   * wrong token saves fine, then every sync fails with a 401 that looks like a
   * plugin bug rather than a typo.
   */
  async useToken(rawToken: string): Promise<boolean> {
    if (!rawToken.startsWith("sw_at_")) {
      new Notice("That does not look like a Stashwise token. They start with sw_at_.");
      return false;
    }
    try {
      const user = await this.api.me(rawToken);
      this.settings.token = rawToken;
      this.settings.account = {
        id: user.id,
        email: user.email ?? null,
        display_name: user.display_name ?? null,
        subscription_tier: user.subscription_tier ?? "free",
      };
      await this.saveSettings();
      new Notice(`Stashwise connected as ${user.email ?? user.display_name ?? "your account"}.`);
      this.restartSyncTimer();
      void this.syncNow();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`That token was rejected by ${this.settings.apiBaseUrl}: ${message}`, 8000);
      return false;
    }
  }

  /**
   * Clear the local token and revoke it server side.
   *
   * The local clear happens regardless of whether the revoke call succeeds: a
   * user asking to disconnect while offline should still end up disconnected,
   * and a token we can no longer reach is one they can revoke from the web app.
   */
  async disconnect(): Promise<void> {
    const token = this.settings.token;
    this.settings.token = null;
    this.settings.account = null;
    await this.saveSettings();
    this.clearSyncTimer();

    if (!token) return;

    try {
      const prefix = visibleTokenPrefix(token);
      const { items } = await this.api.listAgentTokens(token);
      const mine = items.find(
        (item) => item.token_prefix === prefix && !item.revoked_at,
      );
      if (mine) {
        await this.api.revokeAgentToken(token, mine.id);
        new Notice("Stashwise disconnected and this vault's token revoked.");
        return;
      }
      new Notice("Stashwise disconnected.");
    } catch {
      new Notice(
        "Stashwise disconnected locally. The token could not be revoked; " +
          "you can remove it from your account settings on stashwise.co.",
      );
    }
  }

  async syncNow(options: { full?: boolean; silent?: boolean } = {}): Promise<void> {
    if (!this.isConnected) {
      if (!options.silent) new Notice("Connect your Stashwise account first.");
      return;
    }
    if (this.syncing) {
      if (!options.silent) new Notice("A Stashwise sync is already running.");
      return;
    }

    this.syncing = true;
    if (!options.silent) new Notice("Stashwise: syncing...");
    try {
      const report = await this.engine.run({
        token: this.settings.token as string,
        root: this.settings.vaultRoot,
        scope: this.settings.syncScope,
        deleteRemovedItems: this.settings.deleteRemovedItems,
        full: options.full,
      });
      this.lastSyncAt = Date.now();
      this.announce(report, options.silent ?? false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Stashwise sync failed: ${message}`, 8000);
    } finally {
      this.syncing = false;
    }
  }

  private announce(report: SyncReport, silent: boolean): void {
    const parts: string[] = [];
    if (report.savesWritten) parts.push(`${report.savesWritten} saves`);
    if (report.entitiesWritten) parts.push(`${report.entitiesWritten} topics`);
    if (report.notesPushed) parts.push(`${report.notesPushed} notes sent up`);
    if (report.deleted) parts.push(`${report.deleted} removed`);

    // Always surface a detached file, even on a silent background run: it means
    // the plugin has stopped updating a note and the user is the only one who
    // can put the markers back.
    if (report.detached) {
      new Notice(
        `Stashwise skipped ${report.detached} note(s) whose markers were edited. ` +
          "Delete the file to have it rebuilt, or restore the markers.",
        10000,
      );
    }
    if (report.errors.length) {
      new Notice(`Stashwise sync had ${report.errors.length} error(s). See console.`, 8000);
      for (const error of report.errors) console.error("[Stashwise]", error);
    }
    if (silent) return;
    new Notice(parts.length ? `Stashwise: updated ${parts.join(", ")}.` : "Stashwise: up to date.");
  }

  restartSyncTimer(): void {
    this.clearSyncTimer();
    const minutes = this.settings.syncIntervalMinutes;
    if (!this.isConnected || minutes <= 0) return;

    this.syncTimer = this.registerInterval(
      window.setInterval(() => void this.syncNow({ silent: true }), minutes * 60_000),
    );
  }

  private clearSyncTimer(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

// The one default export in this codebase, and only because Obsidian's plugin
// loader instantiates `module.exports.default` by contract. Everything else
// stays on named exports.
export default StashwisePlugin;
