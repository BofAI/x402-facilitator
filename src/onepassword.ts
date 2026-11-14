/**
 * 1Password secret retrieval via Service Accounts or the Connect REST API.
 */
import { logger } from "./logger.js";

const PLACEHOLDER_TOKENS = new Set(["your-op-token", "your-service-account-token"]);

/** A 1Password secret reference parsed into its (vault, item, field) parts. */
export interface OpRef {
  vault: string;
  item: string;
  field: string;
}

/** Parse a `vault/item/field` string into an OpRef, or null if malformed. */
export function parseOpRef(ref: string | undefined | null): OpRef | null {
  if (!ref || typeof ref !== "string") return null;
  const parts = ref.trim().split("/");
  if (parts.length !== 3 || parts.some((p) => !p.trim())) return null;
  return { vault: parts[0].trim(), item: parts[1].trim(), field: parts[2].trim() };
}

/** Whether a token is present and not one of the documented placeholders. */
export function isUsableToken(token: string | undefined | null): token is string {
  return Boolean(token?.trim() && !PLACEHOLDER_TOKENS.has(token.trim()));
}

export interface OnePasswordOptions {
  mode?: "service_account" | "connect";
  host?: string;
}

// Only these locally generated messages may be exposed. Never log response bodies,
// fetch errors, secret references or credentials from either provider.
class ConnectError extends Error {}
const CONNECT_ID = /^[a-z0-9]{26}$/;

async function getConnectSecret(ref: OpRef, token: string, host?: string): Promise<string> {
  let base: URL;
  try {
    base = new URL(host ?? "");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new Error();
  } catch {
    throw new ConnectError("OP_CONNECT_HOST must be an HTTP(S) URL without credentials, query or fragment");
  }
  base.pathname = base.pathname.replace(/\/$/, "") + "/";
  // Keep the controller strongly reachable until body consumption completes.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  async function request(path: string): Promise<unknown> {
    try {
      const response = await fetch(new URL(path, base), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ConnectError(`1Password Connect HTTP ${response.status}`);
      }
      // Explicitly cancel the body reader too: fetch abort alone can leave a
      // stalled response body pending after headers have arrived.
      const reader = response.body?.getReader();
      if (!reader) throw new ConnectError("Invalid 1Password Connect empty response");
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        controller.signal.throwIfAborted();
        const decoder = new TextDecoder();
        let body = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        controller.signal.throwIfAborted();
        return JSON.parse(body + decoder.decode()) as unknown;
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (err) {
      if (err instanceof ConnectError) throw err;
      throw new ConnectError("1Password Connect request failed (network, timeout or invalid response)");
    }
  }
  async function resolveId(value: string, path: string, label: "name" | "title"): Promise<string> {
    if (CONNECT_ID.test(value)) return value;
    const rows = await request(path);
    if (!Array.isArray(rows)) throw new ConnectError("Invalid 1Password Connect collection response");
    const matches = rows.filter((row) => row && row[label] === value);
    if (matches.length !== 1 || typeof matches[0].id !== "string" || !CONNECT_ID.test(matches[0].id))
      throw new ConnectError("1Password Connect vault/item not found or ambiguous; use an ID");
    return matches[0].id;
  }
  try {
    const vault = await resolveId(ref.vault, "v1/vaults", "name");
    const item = await resolveId(ref.item, `v1/vaults/${vault}/items`, "title");
    const detail = await request(`v1/vaults/${vault}/items/${item}`);
    if (!detail || typeof detail !== "object" || !("fields" in detail) || !Array.isArray(detail.fields))
      throw new ConnectError("Invalid 1Password Connect item fields");
    const byId = detail.fields.filter((field) => field && field.id === ref.field);
    const matches = byId.length ? byId : detail.fields.filter((field) => field && field.label === ref.field);
    if (matches.length !== 1 || typeof matches[0].value !== "string")
      throw new ConnectError("1Password Connect field not found or ambiguous; use a field ID");
    return matches[0].value;
  } finally {
    clearTimeout(timeout);
  }
}

// The SDK client is created lazily and cached for the process lifetime.
let clientPromise: Promise<unknown> | null = null;
let clientToken: string | undefined;

async function getClient(token: string): Promise<{ secrets: { resolve(ref: string): Promise<string> } }> {
  if (!clientPromise || clientToken !== token) {
    clientToken = token;
    clientPromise = import("@1password/sdk").then(({ createClient }) =>
      createClient({
        auth: token,
        integrationName: "x402-facilitator",
        integrationVersion: "2.0.1",
      }),
    );
  }
  return clientPromise as Promise<{ secrets: { resolve(ref: string): Promise<string> } }>;
}

/**
 * Resolve a secret from 1Password.
 *
 * @param ref - The parsed `vault/item/field` reference.
 * @param token - A token for the explicitly selected provider.
 * @param options - Provider mode and Connect host (Service Accounts by default).
 * @returns The secret value.
 */
export async function getSecretFromOnePassword(ref: OpRef, token: string, options: OnePasswordOptions = {}): Promise<string> {
  if (!isUsableToken(token)) {
    if (options.mode === "connect") throw new Error("Valid OP_CONNECT_TOKEN is required for 1Password Connect");
    throw new Error(
      "Valid 1Password service account token is not provided. Set OP_SERVICE_ACCOUNT_TOKEN " +
        "or update onepassword.token in the config.",
    );
  }
  try {
    if (options.mode === "connect") return await getConnectSecret(ref, token, options.host);
    const client = await getClient(token);
    return await client.secrets.resolve(`op://${ref.vault}/${ref.item}/${ref.field}`);
  } catch (err) {
    const reason = err instanceof ConnectError ? err.message : "1Password service account resolution failed";
    logger.warn("1Password secret resolution failed", { mode: options.mode ?? "service_account", reason });
    throw new Error(reason);
  }
}
