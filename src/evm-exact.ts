import { ExactEvmScheme as OfficialExactEvmScheme } from "@x402/evm/exact/facilitator";

/** Preserve SDK2's EIP-3009 verify error contract at the application boundary.
 * Permit2 errors and settlement remain owned by the official implementation. */
export class ExactEvmScheme extends OfficialExactEvmScheme {
  override async verify(...args: Parameters<OfficialExactEvmScheme["verify"]>): ReturnType<OfficialExactEvmScheme["verify"]> {
    const [payment] = args;
    if ("permit2Authorization" in payment.payload) return super.verify(...args);
    try {
      return await super.verify(...args);
    } catch {
      const authorization = payment.payload.authorization;
      const payer = authorization !== null && typeof authorization === "object" &&
        "from" in authorization && typeof authorization.from === "string" ? authorization.from : undefined;
      return { isValid: false, invalidReason: "invalid_exact_evm_unexpected_error",
        invalidMessage: "EIP-3009 verification failed", payer };
    }
  }
}
