/**
 * 1Password secret retrieval via @1password/sdk.
 *
 * Faithful port of legacy/src/onepassword_client.py: resolves an `op://vault/item/field`
 * reference with a service-account token. Placeholder tokens are rejected.
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
  return Boolean(token && !PLACEHOLDER_TOKENS.has(token));
}

// The SDK client is created lazily and cached for the process lifetime.
let clientPromise: Promise<unknown> | null = null;

async function getClient(token: string): Promise<{ secrets: { resolve(ref: string): Promise<string> } }> {
  if (!clientPromise) {
    clientPromise = import("@1password/sdk").then(({ createClient }) =>
      createClient({
        auth: token,
        integrationName: "x402-facilitator",
        integrationVersion: "2.0.0",
      }),
    );
  }
  return clientPromise as Promise<{ secrets: { resolve(ref: string): Promise<string> } }>;
}

/**
 * Resolve a secret from 1Password.
 *
 * @param ref - The parsed `vault/item/field` reference.
 * @param token - A valid service-account token.
 * @returns The secret value.
 */
export async function getSecretFromOnePassword(ref: OpRef, token: string): Promise<string> {
  if (!isUsableToken(token)) {
    throw new Error(
      "Valid 1Password service account token is not provided. Set OP_SERVICE_ACCOUNT_TOKEN " +
        "or update onepassword.token in the config.",
    );
  }
  try {
    const client = await getClient(token);
    return await client.secrets.resolve(`op://${ref.vault}/${ref.item}/${ref.field}`);
  } catch (err) {
    logger.warn("1Password secret resolution failed", { err: String(err) });
    throw new Error(`Failed to retrieve secret from 1Password: ${String(err)}`);
  }
}
