import { createTronWebResourceSponsoringChain, type Trc20ApprovalResourceSponsoringRequest,
  type TronWebResourceSponsoringChainOptions } from "@bankofai/x402-tron";
import type { TronWeb } from "tronweb";

type BlockHeader = NonNullable<NonNullable<Parameters<TronWeb["transactionBuilder"]["undelegateResource"]>[4]>["blockHeader"]>;

/** Keep reclaim ordering in the facilitator. Each request supplies TronWeb's
 * public blockHeader option without modifying the SDK or the shared client. */
export async function createAnchoredSponsoringChain(options: TronWebResourceSponsoringChainOptions,
  blockHeader: (request: Trc20ApprovalResourceSponsoringRequest) => Promise<BlockHeader>) {
  const base = await createTronWebResourceSponsoringChain(options);
  return { ...base, async prepareUndelegate(...args: Parameters<typeof base.prepareUndelegate>) {
    const header = await blockHeader(args[0]);
    const original = options.tronWeb.transactionBuilder;
    const builder: typeof original = Object.create(original);
    builder.undelegateResource = async (amount, receiver, resource, owner, settings) => {
      const tx = await original.undelegateResource(amount, receiver, resource, owner, { ...settings, blockHeader: header });
      for (const [key, value] of Object.entries(header)) {
        if ((tx.raw_data as unknown as Record<string, unknown>)[key] !== value)
          throw new Error("sponsor_reclaim_header_mismatch");
      }
      return tx;
    };
    const scoped: TronWeb = Object.create(options.tronWeb);
    scoped.transactionBuilder = builder;
    const chain = await createTronWebResourceSponsoringChain({ ...options, tronWeb: scoped });
    return chain.prepareUndelegate(...args);
  } };
}
