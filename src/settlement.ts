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
  from: string;
  nonce: string;
}

interface UserNonce {
  user: string;
  nonce: string;
}

interface ChannelPayerHolder {
  payer: string;
}

function hasFromNonce(v: unknown): v is FromNonce {
  return typeof v === "object" && v !== null &&
    typeof (v as FromNonce).from === "string" &&
    typeof (v as FromNonce).nonce === "string";
}

function hasUserNonce(v: unknown): v is UserNonce {
  return typeof v === "object" && v !== null &&
    typeof (v as UserNonce).user === "string" &&
    typeof (v as UserNonce).nonce === "string";
}

function hasPayer(v: unknown): v is ChannelPayerHolder {
  return typeof v === "object" && v !== null && typeof (v as ChannelPayerHolder).payer === "string";
}

/**
 * Extract the paying address and authorization nonce from a scheme payload.
 *
 * @param payload - The `PaymentPayload.payload` (scheme-specific) object.
 * @returns The payer + nonce, or null if the payload matches no known scheme.
 */
export function extractPayerNonce(payload: Record<string, unknown> | undefined): PayerNonce | null {
  if (!payload) return null;

  const auth = payload.authorization;
  if (hasFromNonce(auth)) {
    return { payer: auth.from, nonce: auth.nonce };
  }

  const permit2 = payload.permit2Authorization;
  if (hasFromNonce(permit2)) {
    return { payer: permit2.from, nonce: permit2.nonce };
  }

  const gasfree = payload.gasfree;
  if (hasUserNonce(gasfree)) {
    return { payer: gasfree.user, nonce: gasfree.nonce };
  }

  // batch-settlement: payer on the channel config, no per-payment nonce.
  const channelConfig = payload.channelConfig;
  if (hasPayer(channelConfig)) {
    return { payer: channelConfig.payer, nonce: null };
  }

  // batch-settlement claim: channel nested under the voucher.
  const voucher = payload.voucher;
  const claimChannel = typeof voucher === "object" && voucher !== null
    ? (voucher as { channel?: unknown }).channel
    : undefined;
  if (hasPayer(claimChannel)) {
    return { payer: claimChannel.payer, nonce: null };
  }

  return null;
}
