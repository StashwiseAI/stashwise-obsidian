import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
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

/**
 * One row of the settings tab, described once.
 *
 * Obsidian renders a settings tab two different ways depending on version, and
 * 1.13 picks exactly one of them:
 *
 *     renderTab = function () {
 *       this.settingItems.length > 0 ? renderDeclaratively(this) : this.display()
 *     }
 *
 * Returning anything from getSettingDefinitions() means display() is never
 * called again on 1.13 or later, and the two are never merged. Writing the
 * rows out twice, once per renderer, would therefore fail silently: a row
 * missing from one list disappears for the versions that use it while looking
 * perfectly fine on the other.
 *
 * So the rows are described here instead, and both renderers read this. Adding
 * a row below adds it to both. There is no second list to keep in step.
 */
interface Row {
  name: string;
  desc?: string;
  /** Absent on rows that are informational and carry no control. */
  render?: (setting: Setting) => void;
  /**
   * Re-evaluated on every render, which is how connecting or disconnecting
   * reshapes the tab. Must read live state rather than close over a snapshot.
   */
  visible?: () => boolean;
}

interface Section {
  heading: string;
  rows: Row[];
}

export class StashwiseSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: StashwisePlugin,
  ) {
    super(app, plugin);
  }

  // ---------------------------------------------------------------------
  // The two renderers. Both consume sections() and neither owns content.
  // ---------------------------------------------------------------------

  /**
   * Obsidian 1.13.0 and later. Returning a non-empty array is also what puts
   * these settings into Obsidian's settings search, which is the whole reason
   * to implement it.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.sections().map((section) => ({
      type: "group" as const,
      heading: section.heading,
      items: section.rows.map((row): SettingGroupItem => {
        // Split rather than spread: a definition either renders imperatively
        // or is informational, and the two shapes are mutually exclusive.
        if (row.render) {
          return {
            name: row.name,
            desc: row.desc,
            visible: row.visible,
            render: row.render,
          };
        }
        return { name: row.name, desc: row.desc, visible: row.visible };
      }),
    }));
  }

  /**
   * Obsidian below 1.13.0, which has no declarative API. Still required at our
   * minAppVersion of 1.7.2, and still the path Obsidian takes whenever
   * getSettingDefinitions() comes back empty.
   */
  display(): void {
    this.renderImperatively();
  }

  private renderImperatively(): void {
    const { containerEl } = this;
    containerEl.empty();

    for (const section of this.sections()) {
      const rows = section.rows.filter((row) => row.visible?.() ?? true);
      if (rows.length === 0) continue;

      new Setting(containerEl).setName(section.heading).setHeading();

      for (const row of rows) {
        const setting = new Setting(containerEl).setName(row.name);
        if (row.desc) setting.setDesc(row.desc);
        row.render?.(setting);
      }
    }
  }

  /**
   * Redraw after connecting, disconnecting or pasting a token, on whichever
   * renderer is in use.
   *
   * update() is the 1.13 way and re-evaluates every visible() predicate, but it
   * does not exist at our minAppVersion, so calling it directly is exactly the
   * mistake no-unsupported-api exists to catch. Detecting it at runtime is the
   * honest cross-version answer: newer Obsidian re-reads the definitions, older
   * Obsidian redraws the imperative tab.
   */
  private refresh(): void {
    const maybeDeclarative = this as { update?: () => void };
    if (typeof maybeDeclarative.update === "function") {
      maybeDeclarative.update();
      return;
    }
    this.renderImperatively();
  }

  // ---------------------------------------------------------------------
  // The single description of the tab.
  // ---------------------------------------------------------------------

  private sections(): Section[] {
    return [this.accountSection(), this.syncSection(), this.advancedSection()];
  }

  private accountSection(): Section {
    const { account } = this.plugin.settings;
    const who = account?.email ?? account?.display_name ?? "your account";
    const tier = account?.subscription_tier ?? "free";

    return {
      heading: "Account",
      rows: [
        {
          name: "Connected",
          desc: `Signed in as ${who} on the ${tier} plan.`,
          visible: () => Boolean(this.plugin.settings.token),
          render: (setting) => {
            setting.addButton((button) => {
              button.setButtonText("Disconnect").onClick(async () => {
                await this.plugin.disconnect();
                this.refresh();
              });
              // The class directly, rather than setWarning() or
              // setDestructive(). setDestructive() needs 1.13.0 and we support
              // 1.7.2; setWarning() is deprecated, and on 1.13 it now resolves
              // to setDestructive().setCta(). mod-warning is the class
              // setWarning() applied before that change, it is still styled in
              // 1.13 (solid error background, plus its own mobile rule), and it
              // renders the same on both sides of the split.
              button.buttonEl.addClass("mod-warning");
            });
          },
        },
        {
          name: "Not connected",
          desc: "Connect to sync your library and search it from any note.",
          visible: () => !this.plugin.settings.token,
          render: (setting) => {
            setting.addButton((button) =>
              button
                .setButtonText("Connect account")
                .setCta()
                .onClick(async () => {
                  await this.plugin.connect();
                  this.refresh();
                }),
            );
          },
        },
        {
          name: "Token storage",
          // configDir rather than a hardcoded ".obsidian": the config folder is
          // user-configurable, and pointing someone at a path that does not
          // exist on their vault is worse than not naming one.
          desc:
            "Your access token is stored unencrypted in this vault, at " +
            `${this.app.vault.configDir}/plugins/stashwise/data.json. ` +
            "If you sync this vault to another service, the token syncs with it. " +
            "Use Disconnect to revoke it.",
          render: (setting) => {
            setting.setClass("stashwise-token-warning");
          },
        },
      ],
    };
  }

  private syncSection(): Section {
    return {
      heading: "Sync",
      rows: [
        {
          name: "Vault folder",
          desc: "Folder the plugin writes into. Everything else in your vault is left alone.",
          render: (setting) => {
            setting.addText((text) =>
              text
                .setPlaceholder("Stashwise")
                .setValue(this.plugin.settings.vaultRoot)
                .onChange(async (value) => {
                  this.plugin.settings.vaultRoot =
                    value.trim() || DEFAULT_SETTINGS.vaultRoot;
                  await this.plugin.saveSettings();
                }),
            );
          },
        },
        {
          name: "What to sync",
          desc: "Wiki topics are what make Obsidian's graph view render your knowledge graph.",
          render: (setting) => {
            setting.addDropdown((dropdown) =>
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
          },
        },
        {
          name: "Sync every",
          desc: "Minutes between automatic syncs. Set to 0 to sync only when you ask.",
          render: (setting) => {
            setting.addText((text) =>
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
          },
        },
        {
          name: "Delete notes for removed saves",
          desc:
            "When a save is deleted in Stashwise, move its note to the trash. " +
            "Off by default, because your own notes may live in that file.",
          render: (setting) => {
            setting.addToggle((toggle) =>
              toggle
                .setValue(this.plugin.settings.deleteRemovedItems)
                .onChange(async (value) => {
                  this.plugin.settings.deleteRemovedItems = value;
                  await this.plugin.saveSettings();
                }),
            );
          },
        },
      ],
    };
  }

  private advancedSection(): Section {
    return {
      heading: "Advanced",
      rows: [
        {
          name: "API URL",
          desc: "Point at a local backend while developing. Reconnect after changing this.",
          render: (setting) => {
            setting.addText((text) =>
              text
                .setPlaceholder(DEFAULT_SETTINGS.apiBaseUrl)
                .setValue(this.plugin.settings.apiBaseUrl)
                .onChange(async (value) => {
                  this.plugin.settings.apiBaseUrl =
                    value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
                  await this.plugin.saveSettings();
                }),
            );
          },
        },
        {
          // Connect account sends you to {webapp_base_url}/cli, which is the
          // hosted web app even when API URL points at localhost. Authorizing
          // there pairs the code with the hosted backend, so a local backend
          // never sees it and polling never completes. Pasting a token is the
          // way in for a local backend, and for anyone who already minted one
          // with the CLI.
          name: "Paste an access token",
          desc:
            "Alternative to Connect account. Required when API URL points at a " +
            "local backend. The token is checked against that backend before it is saved.",
          visible: () => !this.plugin.settings.token,
          render: (setting) => {
            // Per render, so a redraw does not carry a stale value forward.
            let pasted = "";
            setting
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
                  if (applied) this.refresh();
                }),
              );
          },
        },
      ],
    };
  }
}
