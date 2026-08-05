// The two capture commands.
//
// Both surface the backend's own error text rather than inventing copy, because
// only the server knows whether this token hard stops at the save cap (free
// agents) or falls through to a raw save (paid).

import { Editor, MarkdownView, Notice, TFile } from "obsidian";
import { ApiError } from "../api/client.js";
import type { StashwisePlugin } from "../main.js";
import { extractNote, readStashwiseId, withStashwiseId } from "./noteText.js";
import { findUrl } from "./noteText.js";

function reportError(error: unknown, action: string): void {
  if (error instanceof ApiError) {
    if (error.status === 402) {
      // The backend's save_limit_detail knows which cap was hit and whether
      // this principal stops or degrades. Paraphrasing it would be wrong.
      new Notice(`Stashwise: ${error.message}`, 8000);
      return;
    }
    if (error.status === 401) {
      new Notice("Stashwise session expired. Reconnect in settings.", 8000);
      return;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  new Notice(`Stashwise could not ${action}: ${message}`, 8000);
}

export async function captureCurrentNote(
  plugin: StashwisePlugin,
  file: TFile,
): Promise<void> {
  const token = plugin.settings.token;
  if (!token) {
    new Notice("Connect your Stashwise account first.");
    return;
  }

  const raw = await plugin.app.vault.read(file);
  const existingId = readStashwiseId(raw);
  const { title, body } = extractNote(raw, file.basename);

  if (!body.trim()) {
    new Notice("Nothing to save: this note is empty.");
    return;
  }

  try {
    if (existingId) {
      // Already captured once. Updating the note layer keeps one Library item
      // rather than making a new one every time the command is run.
      await plugin.api.updateContentNote(token, existingId, body, "replace");
      new Notice(`Updated "${title}" in Stashwise.`);
      return;
    }

    const created = await plugin.api.createNote(token, {
      title,
      body,
      include_in_wiki: true,
    });
    await plugin.app.vault.modify(file, withStashwiseId(raw, created.content.id));
    new Notice(`Saved "${title}" to Stashwise.`);
  } catch (error) {
    reportError(error, "save this note");
  }
}

export async function captureUrl(
  plugin: StashwisePlugin,
  editor: Editor,
): Promise<void> {
  const token = plugin.settings.token;
  if (!token) {
    new Notice("Connect your Stashwise account first.");
    return;
  }

  const selection = editor.getSelection();
  const url =
    findUrl(selection) ?? findUrl(editor.getLine(editor.getCursor().line));
  if (!url) {
    new Notice("Select a URL, or put the cursor on a line containing one.");
    return;
  }

  try {
    await plugin.api.saveUrl(token, url);
    new Notice(`Saving ${url} to Stashwise. It will appear after analysis.`);
  } catch (error) {
    reportError(error, "save that URL");
  }
}

export function activeMarkdownFile(plugin: StashwisePlugin): TFile | null {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  return view?.file ?? null;
}
