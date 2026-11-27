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
 * Extract the payer and nonce for the scheme being settled.
 *
 * @param payload - The scheme-specific payment payload.
 * @param scheme - The registered payment scheme.
 * @returns The payer and nonce, or null when the scheme has no usable identity.
 */
export function extractPayerNonce(
  payload: Record<string, unknown> | undefined,
  scheme: string,
): PayerNonce | null {
  if (!payload) return null;

  if (scheme === "exact" && hasFromNonce(payload.authorization)) {
    return { payer: payload.authorization.from, nonce: payload.authorization.nonce };
  }

  if ((scheme === "exact" || scheme === "upto") && hasFromNonce(payload.permit2Authorization)) {
    return { payer: payload.permit2Authorization.from, nonce: payload.permit2Authorization.nonce };
  }

  if (scheme === "exact_gasfree" && hasUserNonce(payload.gasfree)) {
    return { payer: payload.gasfree.user, nonce: payload.gasfree.nonce };
  }

  if (scheme !== "batch-settlement") return null;
  if (hasPayer(payload.channelConfig)) return { payer: payload.channelConfig.payer, nonce: null };

  const voucher = payload.voucher;
  const claimChannel = typeof voucher === "object" && voucher !== null
    ? (voucher as { channel?: unknown }).channel
    : undefined;
  return hasPayer(claimChannel) ? { payer: claimChannel.payer, nonce: null } : null;
}
