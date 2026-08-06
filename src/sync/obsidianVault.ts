// The real VaultIO, backed by Obsidian's vault API.
//
// Everything here goes through `app.vault` / `vault.adapter` rather than
// node:fs, which does not exist on mobile. normalizePath is applied at the
// boundary because Obsidian is strict about leading slashes and duplicate
// separators in vault-relative paths.

import { App, normalizePath, TFile, TFolder } from "obsidian";
import type { VaultIO } from "./engine.js";
import type { StateAdapter } from "./state.js";

export class ObsidianVaultIO implements VaultIO {
  constructor(private readonly app: App) {}

  async read(path: string): Promise<string> {
    const file = this.file(path);
    if (!file) throw new Error(`Not found: ${path}`);
    // `read` rather than `cachedRead`: a stale cache here would mean writing
    // back a user zone the user has since edited.
    return this.app.vault.read(file);
  }

  async write(path: string, data: string): Promise<void> {
    const normalized = normalizePath(path);
    const file = this.file(normalized);
    if (file) {
      await this.app.vault.modify(file, data);
      return;
    }
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    await this.app.vault.create(normalized, data);
  }

  async exists(path: string): Promise<boolean> {
    return this.file(path) !== null;
  }

  async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) return;

    // Create each level in turn. createFolder throws when a folder already
    // exists, which is routine on the parents of a nested path, so each level
    // is checked before it is created.
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(current) instanceof TFolder) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch {
        // Lost a race with another writer, or it appeared between the check
        // and the call. Either way the folder now exists, which is the goal.
      }
    }
  }

  async trash(path: string): Promise<void> {
    const file = this.file(path);
    if (!file) return;
    // trashFile, not vault.trash: it honours the user's "deleted files"
    // preference (system trash, vault trash, or permanent) rather than us
    // picking for them.
    await this.app.fileManager.trashFile(file);
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.file(from);
    if (!file) return;
    await this.app.fileManager.renameFile(file, normalizePath(to));
  }

  private file(path: string): TFile | null {
    const found = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return found instanceof TFile ? found : null;
  }
}

/**
 * State lives under the plugin's own config folder, not in the vault proper,
 * so it never shows up as a note and never syncs as user content.
 */
export class ObsidianStateAdapter implements StateAdapter {
  constructor(private readonly app: App) {}

  async read(path: string): Promise<string> {
    return this.app.vault.adapter.read(normalizePath(path));
  }

  async write(path: string, data: string): Promise<void> {
    const normalized = normalizePath(path);
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent && !(await this.app.vault.adapter.exists(parent))) {
      await this.app.vault.adapter.mkdir(parent);
    }
    await this.app.vault.adapter.write(normalized, data);
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizePath(path));
  }
}
