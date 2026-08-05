// Retry policy for the device-code poll loop.
//
// Deliberately separate from deviceAuth.ts, which imports the Obsidian API and
// therefore cannot be unit tested. This file is pure, so the policy that
// decides whether a user sees a dead modal is covered by tests.

import { ApiError } from "../api/client.js";

export interface PollFailureContext {
  /** Poll attempts that have failed back-to-back. Resets to 0 on any success. */
  consecutiveFailures: number;
  /** Total failures during this pairing, successful attempts in between or not. */
  totalFailures: number;
  /** Milliseconds since the pairing started. */
  elapsedMs: number;
  /** The error the attempt threw. An ApiError carries an HTTP status. */
  error: unknown;
}

export type PollFailureDecision =
  | { action: "retry"; status?: string }
  | { action: "abort"; message: string };

/** Consecutive failures tolerated silently before the modal admits something is wrong. */
export const QUIET_FAILURE_STREAK = 3;
/** Consecutive failures (about a minute at 2s intervals) before giving up. */
export const FATAL_FAILURE_STREAK = 30;

/**
 * Decide what to do when a single poll attempt fails.
 *
 * Called once per failed attempt, every 2 seconds. Returning `retry` keeps the
 * loop going and optionally updates the line of status text in the modal;
 * returning `abort` closes the modal with an error.
 *
 * A 404 is handled by the caller before this runs, because the server uses it
 * to mean "this pairing is gone" rather than "the request failed". Everything
 * reaching here is a transport failure or a server error.
 *
 * The CLI's answer does not transfer. It swallows every transient error and
 * polls the full window, which is fine in a terminal where nobody is watching.
 * Here a user is staring at a modal, and on mobile the network flaps, so the
 * policy has to tolerate blips without going silent for six minutes.
 */
export function decidePollFailure(ctx: PollFailureContext): PollFailureDecision {
  const { consecutiveFailures, error } = ctx;

  // A 4xx that is not the 404 handled upstream means the server understood the
  // request and refused it. Repeating an unchanged request cannot fix that.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return { action: "abort", message: error.message };
  }

  // One or two flakes are normal on a phone. The server owns the pairing
  // deadline, so waiting them out costs nothing and saying so would be noise.
  if (consecutiveFailures < QUIET_FAILURE_STREAK) {
    return { action: "retry" };
  }

  // About a minute of unbroken failure. Without this the modal sits there
  // looking alive for the full window with nothing behind it.
  if (consecutiveFailures >= FATAL_FAILURE_STREAK) {
    return {
      action: "abort",
      message: "Lost connection to Stashwise. Check your network and try again.",
    };
  }

  // Still retrying, but the user deserves to know why nothing is happening.
  // The caller resets this text on the next successful poll.
  return { action: "retry", status: "Connection lost. Retrying..." };
}
