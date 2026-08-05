import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SearchScope, StashwiseUser } from "./api/types.js";
import type { StashwisePlugin } from "./main.js";

export interface StashwiseSettings {
  /** Overridable so a dev build can point at a local backend on :8000. */
  apiBaseUrl: string;
  webBaseUrl: string;
  /**
   * Long-lived agent token from the device-code flow.
   *
   * Obsidian's saveData writes this to .obsidian/plugins/stashwise/data.json
   * in plaintext. If the vault syncs through iCloud, Dropbox or Obsidian Sync,
   * the token travels with it. This is the standard storage every Obsidian
   * plugin holding an API key uses, but the settings tab says so out loud
   * rather than leaving the user to discover it.
   */
  token: string | null;
  account: StashwiseUser | null;
  /** Vault folder that the plugin owns. Everything it writes lives under here. */
  vaultRoot: string;
  syncIntervalMinutes: number;
  syncScope: SearchScope;
  /**
   * Off by default. Deleting a save in the web app should not silently remove
   * a vault note the user may have written their own thinking underneath.
   */
  deleteRemovedItems: boolean;
}

export const DEFAULT_SETTINGS: StashwiseSettings = {
  apiBaseUrl: "https://stashwise-api.fly.dev/api/v1",
  webBaseUrl: "https://stashwise.co",
  token: null,
  account: null,
  vaultRoot: "Stashwise",
  syncIntervalMinutes: 15,
  syncScope: "all",
  deleteRemovedItems: false,
};

export class StashwiseSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: StashwisePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderAccount(containerEl);
    this.renderSync(containerEl);
    this.renderAdvanced(containerEl);
  }

  private renderAccount(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Account").setHeading();

    const { account, token } = this.plugin.settings;
    const connected = Boolean(token);

    const setting = new Setting(containerEl).setName(
      connected ? "Connected" : "Not connected",
    );

    if (connected) {
      const who = account?.email ?? account?.display_name ?? "your account";
      const tier = account?.subscription_tier ?? "free";
      setting.setDesc(`Signed in as ${who} on the ${tier} plan.`);
      setting.addButton((button) =>
        button
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            await this.plugin.disconnect();
            this.display();
          }),
      );
    } else {
      setting.setDesc("Connect to sync your library and search it from any note.");
      setting.addButton((button) =>
        button
          .setButtonText("Connect account")
          .setCta()
          .onClick(async () => {
            await this.plugin.connect();
            this.display();
          }),
      );
    }

    containerEl.createEl("p", {
      cls: "setting-item-description stashwise-token-warning",
      text:
        "Your access token is stored unencrypted in this vault, at " +
        ".obsidian/plugins/stashwise/data.json. If you sync this vault to " +
        "another service, the token syncs with it. Use Disconnect to revoke it.",
    });
  }

  private renderSync(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Vault folder")
      .setDesc("Folder the plugin writes into. Everything else in your vault is left alone.")
      .addText((text) =>
        text
          .setPlaceholder("Stashwise")
          .setValue(this.plugin.settings.vaultRoot)
          .onChange(async (value) => {
            this.plugin.settings.vaultRoot = value.trim() || DEFAULT_SETTINGS.vaultRoot;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("What to sync")
      .setDesc("Wiki topics are what make Obsidian's graph view render your knowledge graph.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("all", "Saves and wiki topics")
          .addOption("library", "Saves only")
          .addOption("wiki", "Wiki topics only")
          .setValue(this.plugin.settings.syncScope)
          .onChange(async (value) => {
            this.plugin.settings.syncScope = value as SearchScope;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync every")
      .setDesc("Minutes between automatic syncs. Set to 0 to sync only when you ask.")
      .addText((text) =>
        text
          .setPlaceholder("15")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const minutes = Number.parseInt(value, 10);
            this.plugin.settings.syncIntervalMinutes =
              Number.isFinite(minutes) && minutes >= 0
                ? minutes
                : DEFAULT_SETTINGS.syncIntervalMinutes;
            await this.plugin.saveSettings();
            this.plugin.restartSyncTimer();
          }),
      );

    new Setting(containerEl)
      .setName("Delete notes for removed saves")
      .setDesc(
        "When a save is deleted in Stashwise, move its note to the trash. " +
          "Off by default, because your own notes may live in that file.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteRemovedItems)
          .onChange(async (value) => {
            this.plugin.settings.deleteRemovedItems = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderAdvanced(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("API URL")
      .setDesc("Point at a local backend while developing. Reconnect after changing this.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.apiBaseUrl)
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl =
              value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
            await this.plugin.saveSettings();
          }),
      );

    // Connect account sends you to {webapp_base_url}/cli, which is the hosted
    // web app even when API URL points at localhost. Authorizing there pairs
    // the code with the hosted backend, so a local backend never sees it and
    // polling never completes. Pasting a token is the way in for a local
    // backend, and for anyone who already minted one with the CLI.
    if (!this.plugin.settings.token) {
      let pasted = "";
      new Setting(containerEl)
        .setName("Paste an access token")
        .setDesc(
          "Alternative to Connect account. Required when API URL points at a " +
            "local backend. The token is checked against that backend before it is saved.",
        )
        .addText((text) => {
          text.setPlaceholder("sw_at_...").onChange((value) => {
            pasted = value.trim();
          });
          text.inputEl.type = "password";
        })
        .addButton((button) =>
          button.setButtonText("Use token").onClick(async () => {
            if (!pasted) {
              new Notice("Paste a token first.");
              return;
            }
            const applied = await this.plugin.useToken(pasted);
            if (applied) this.display();
          }),
        );
    }
  }
}
