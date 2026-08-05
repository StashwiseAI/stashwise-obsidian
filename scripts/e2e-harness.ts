// Headless driver for the end-to-end test.
//
// The whole sync core (client, engine, managedBlock, renderers, state) imports
// nothing from `obsidian`, which is what makes this possible: the exact code
// the plugin runs can be exercised against the real backend over real HTTP,
// with the filesystem standing in for the vault. Only the two adapters below
// are test-specific.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { StashwiseApi, type Transport } from "../src/api/client.js";
import { SyncEngine, type VaultIO } from "../src/sync/engine.js";
import { SyncStateStore, type StateAdapter } from "../src/sync/state.js";

/** Stands in for Obsidian's requestUrl. Same contract: never throws on 4xx. */
const fetchTransport: Transport = async (req) => {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  return { status: response.status, text: await response.text() };
};

class FsVault implements VaultIO {
  constructor(private readonly root: string) {}
  private full(path: string): string {
    return join(this.root, path);
  }
  async read(path: string): Promise<string> {
    return readFile(this.full(path), "utf8");
  }
  async write(path: string, data: string): Promise<void> {
    await mkdir(dirname(this.full(path)), { recursive: true });
    await writeFile(this.full(path), data, "utf8");
  }
  async exists(path: string): Promise<boolean> {
    return existsSync(this.full(path));
  }
  async ensureFolder(path: string): Promise<void> {
    await mkdir(this.full(path), { recursive: true });
  }
  async trash(path: string): Promise<void> {
    await rm(this.full(path), { force: true });
  }
  async rename(from: string, to: string): Promise<void> {
    await rename(this.full(from), this.full(to));
  }
}

class FsStateAdapter implements StateAdapter {
  constructor(private readonly root: string) {}
  async read(path: string): Promise<string> {
    return readFile(join(this.root, path), "utf8");
  }
  async write(path: string, data: string): Promise<void> {
    await mkdir(dirname(join(this.root, path)), { recursive: true });
    await writeFile(join(this.root, path), data, "utf8");
  }
  async exists(path: string): Promise<boolean> {
    return existsSync(join(this.root, path));
  }
}

export async function runSync(options: {
  apiBaseUrl: string;
  token: string;
  vaultRoot: string;
  scope?: "library" | "wiki" | "all";
  full?: boolean;
  deleteRemovedItems?: boolean;
}) {
  const api = new StashwiseApi(fetchTransport, () => options.apiBaseUrl);
  const vault = new FsVault(options.vaultRoot);
  const store = new SyncStateStore(new FsStateAdapter(options.vaultRoot), ".sync-state.json");
  await store.load();

  const engine = new SyncEngine(api, vault, store);
  const report = await engine.run({
    token: options.token,
    root: "Stashwise",
    scope: options.scope ?? "all",
    deleteRemovedItems: options.deleteRemovedItems ?? false,
    full: options.full,
  });
  return { report, state: store.current };
}
