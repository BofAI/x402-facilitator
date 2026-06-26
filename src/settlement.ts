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
 *
 * batch-settlement has no per-payment authorization nonce — a payment channel is
 * claimed repeatedly — so it yields the channel payer with a null nonce: enough to
 * scope/query the row by payer, while leaving the success-dedup unique index inert
 * (NULL nonces are distinct in Postgres, so repeated claims aren't collapsed). The
 * payer lives on the channel config, not an `authorization` object:
 *
 *   batch deposit/voucher/refund : payload.channelConfig.payer
 *   batch claim                  : payload.voucher.channel.payer
 */
export interface PayerNonce {
  payer: string;
  /** Authorization nonce, or null for schemes without one (batch-settlement). */
  nonce: string | null;
}

interface FromNonce {
  from?: unknown;
  nonce?: unknown;
}

interface UserNonce {
  user?: unknown;
  nonce?: unknown;
}

interface ChannelPayerHolder {
  payer?: unknown;
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

  // batch-settlement: payer on the channel config, no per-payment nonce.
  const channelConfig = payload.channelConfig as ChannelPayerHolder | undefined;
  if (channelConfig && typeof channelConfig.payer === "string") {
    return { payer: channelConfig.payer, nonce: null };
  }

  // batch-settlement claim: channel nested under the voucher.
  const claimChannel = (payload.voucher as { channel?: ChannelPayerHolder } | undefined)?.channel;
  if (claimChannel && typeof claimChannel.payer === "string") {
    return { payer: claimChannel.payer, nonce: null };
  }

  return null;
}
