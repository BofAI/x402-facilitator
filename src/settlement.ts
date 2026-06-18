/**
 * On-chain authorization identity extraction.
 *
 * v2 keys settlement records on the signed authorization identity rather than a
 * client-supplied payment id. The payer + nonce live inside the scheme payload;
 * field shapes are pinned to the @bankofai/x402-*
 * payload types (verified against the SDK), the discriminator being which
 * authorization object is present — exactly what isEIP3009Payload /
 * isPermit2Payload check:
 *
 *   EIP-3009 : payload.authorization.{ from, nonce }
 *   Permit2  : payload.permit2Authorization.{ from, nonce }
 *   GasFree  : payload.gasfree.{ user, nonce }   (TRON only)
 */
export interface PayerNonce {
  payer: string;
  nonce: string;
}

interface FromNonce {
  from?: unknown;
  nonce?: unknown;
}

interface UserNonce {
  user?: unknown;
  nonce?: unknown;
}

/**
 * Extract the paying address and authorization nonce from a scheme payload.
 *
 * @param payload - The `PaymentPayload.payload` (scheme-specific) object.
 * @returns The payer + nonce, or null if the payload matches no known scheme.
 */
export function extractPayerNonce(payload: Record<string, unknown> | undefined): PayerNonce | null {
  if (!payload) return null;

  const auth = payload.authorization as FromNonce | undefined;
  if (auth && typeof auth.from === "string" && typeof auth.nonce === "string") {
    return { payer: auth.from, nonce: auth.nonce };
  }

  const permit2 = payload.permit2Authorization as FromNonce | undefined;
  if (permit2 && typeof permit2.from === "string" && typeof permit2.nonce === "string") {
    return { payer: permit2.from, nonce: permit2.nonce };
  }

  const gasfree = payload.gasfree as UserNonce | undefined;
  if (gasfree && typeof gasfree.user === "string" && typeof gasfree.nonce === "string") {
    return { payer: gasfree.user, nonce: gasfree.nonce };
  }

  return null;
}
