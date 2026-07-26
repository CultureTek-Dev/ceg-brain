import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const pexec = promisify(execFile);

export type Auth =
  | { type: "api"; key: string }
  | { type: "subscription"; token: string };

let cachedToken: string | null = null;
let cachedAt = 0;

/**
 * Fetch a fresh subscription access token from the local `ant` OAuth profile.
 * `ant auth print-credentials --access-token` prints a bare short-lived token
 * and refreshes the underlying credential as needed.
 */
async function fetchSubscriptionToken(): Promise<string> {
  const { stdout } = await pexec(config.antBin, [
    "auth",
    "print-credentials",
    "--access-token",
  ]);
  const token = stdout.trim();
  if (!token) throw new Error("`ant auth print-credentials --access-token` returned empty output — is the box authed? Run `ant auth login`.");
  return token;
}

/** Returns current auth for the configured backend. Caches the subscription token. */
export async function getAuth(force = false): Promise<Auth> {
  if (config.backend === "api") {
    if (!config.anthropicApiKey) throw new Error("backend=api but ANTHROPIC_API_KEY is not set");
    return { type: "api", key: config.anthropicApiKey };
  }
  // Preferred: the `claude setup-token` value straight from the environment.
  // It's a long-lived (~1yr) subscription OAuth bearer — no CLI, no refresh dance.
  if (config.oauthToken) {
    return { type: "subscription", token: config.oauthToken };
  }
  // Fallback: source a short-lived token from the `ant` CLI OAuth profile.
  const ttlMs = config.tokenRefreshMin * 60_000;
  if (force || !cachedToken || Date.now() - cachedAt > ttlMs) {
    cachedToken = await fetchSubscriptionToken();
    cachedAt = Date.now();
  }
  return { type: "subscription", token: cachedToken };
}

/** Force a token refresh (used on 401 from upstream). */
export async function refreshAuth(): Promise<Auth> {
  return getAuth(true);
}
