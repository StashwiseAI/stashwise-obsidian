// Device-code login, ported from stashwise-cli/src/auth.ts.
//
//   1. POST /auth/cli/start   -> device_code + user_code + verification_uri
//   2. user authorises in the browser
//   3. poll /auth/cli/poll    -> the raw token once authorised
//
// The CLI stores the result in the OS keychain via keytar. That is a native
// module, so it cannot come along to a plugin that runs on mobile; the token
// goes into plugin data.json instead and the settings tab says so.

import { App, Modal, Setting } from "obsidian";
import { ApiError, StashwiseApi } from "../api/client.js";
import type { StashwiseUser } from "../api/types.js";
import { decidePollFailure } from "./policy.js";

const POLL_INTERVAL_MS = 2000;
/** Slightly past the server's 5-minute pairing TTL, matching the CLI. */
const POLL_MAX_ATTEMPTS = 180;

export type AuthResult =
  | { kind: "authorized"; token: string; user?: StashwiseUser }
  | { kind: "expired" }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the whole pairing: start it, show the modal, poll until it resolves.
 *
 * `clientLabel` is derived from the vault name rather than the hostname, since
 * `node:os` is off-limits in a mobile-capable plugin.
 */
export async function runDeviceAuth(
  app: App,
  api: StashwiseApi,
  clientLabel: string,
  webBaseUrl: string,
): Promise<AuthResult> {
  let start;
  try {
    start = await api.startDeviceCode(clientLabel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", message: `Could not start sign-in: ${message}` };
  }

  const modal = new DeviceCodeModal(app, {
    verificationUri: start.verification_uri,
    userCode: start.user_code,
    webBaseUrl,
  });
  modal.open();

  // `window.open` is unreliable inside the mobile webview, so the modal shows a
  // tappable link and the code as selectable text. The popup is a convenience
  // for desktop, never the only route.
  window.open(start.verification_uri, "_blank");

  const startedAt = Date.now();
  let consecutiveFailures = 0;
  let totalFailures = 0;

  try {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      if (modal.cancelled) {
        return { kind: "cancelled" };
      }

      try {
        const poll = await api.pollDeviceCode(start.device_code);
        consecutiveFailures = 0;
        modal.setStatus("Waiting for authorization...");

        if (poll.status === "expired") {
          return { kind: "expired" };
        }
        if (poll.status === "authorized" && poll.token) {
          return { kind: "authorized", token: poll.token, user: poll.user };
        }
      } catch (error) {
        // The server answers 404 once a pairing is gone. That is a verdict, not
        // a transport failure, so it never reaches the retry policy.
        if (error instanceof ApiError && error.status === 404) {
          return { kind: "expired" };
        }

        consecutiveFailures += 1;
        totalFailures += 1;
        const decision = decidePollFailure({
          consecutiveFailures,
          totalFailures,
          elapsedMs: Date.now() - startedAt,
          error,
        });
        if (decision.action === "abort") {
          return { kind: "failed", message: decision.message };
        }
        if (decision.status) {
          modal.setStatus(decision.status);
        }
      }
    }
    return { kind: "timeout" };
  } finally {
    modal.close();
  }
}

interface DeviceCodeModalOptions {
  verificationUri: string;
  userCode: string;
  webBaseUrl: string;
}

class DeviceCodeModal extends Modal {
  cancelled = false;
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly options: DeviceCodeModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("stashwise-auth-modal");

    contentEl.createEl("h2", { text: "Connect Stashwise" });
    contentEl.createEl("p", {
      text: "Approve this vault in your browser, then come back here.",
    });

    const link = contentEl.createEl("p").createEl("a", {
      text: "Open the authorization page",
      href: this.options.verificationUri,
    });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `Or visit ${this.options.webBaseUrl}/cli and enter this code:`,
    });
    contentEl.createEl("div", {
      cls: "stashwise-user-code",
      text: this.options.userCode,
    });

    this.statusEl = contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Waiting for authorization...",
    });

    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Cancel").onClick(() => {
        this.cancelled = true;
        this.close();
      }),
    );
  }

  setStatus(text: string): void {
    if (this.statusEl) {
      this.statusEl.setText(text);
    }
  }

  onClose(): void {
    // Closing with the X or Escape is a cancellation too, not just the button.
    this.cancelled = true;
    this.contentEl.empty();
  }
}
