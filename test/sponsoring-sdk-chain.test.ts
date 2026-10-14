import { describe, expect, it, vi } from "vitest";
import { TronWeb, utils } from "tronweb";
import type { Trc20ApprovalResourceSponsoringRequest } from "@bankofai/x402-tron";
import { createAnchoredSponsoringChain } from "../src/sponsoring/sdk-chain.js";

const owner = "TGRjCWwtr3MTX3GKmnTQqo8GAhAFwRCNV9";
const payer = "TFmohhTQMoD4nuZnD7H7hqZ8HUZa924vFF";
const header = { ref_block_bytes: "1234", ref_block_hash: "0123456789abcdef", timestamp: 1000, expiration: 61000 };

function fixture(corrupt = false) {
  const tron = new TronWeb({ fullHost: "https://example.invalid" });
  vi.spyOn(tron.trx, "getAccount").mockResolvedValue({ active_permission: [{ id: 2, operations: "00".repeat(7) + "06" + "00".repeat(24) }] } as never);
  const builder = vi.spyOn(tron.transactionBuilder, "undelegateResource").mockImplementation(async (amount, receiver, resource, address, options) => {
    const tx = { visible: false, raw_data: { ...options?.blockHeader, ...(corrupt ? { ref_block_bytes: "ffff" } : {}),
      contract: [{ type: "UnDelegateResourceContract", Permission_id: 2, parameter: {
        type_url: "type.googleapis.com/protocol.UnDelegateResourceContract", value: {
          owner_address: TronWeb.address.toHex(address as string), receiver_address: TronWeb.address.toHex(receiver),
          balance: amount, resource,
        },
      } }] } };
    const pb = utils.transaction.txJsonToPb(tx as never);
    return { ...tx, raw_data_hex: utils.transaction.txPbToRawDataHex(pb), txID: utils.transaction.txPbToTxID(pb).replace(/^0x/, "") } as never;
  });
  const sign = vi.fn(async ({ transaction }) => ({ ...transaction, signature: ["11".repeat(65)] }));
  const options = { tronWeb: tron, network: "tron:3448148188", permissionId: 2, allowedAssets: [payer],
    resourceOwnerSigner: { getAddress: async () => owner, signResourceTransaction: sign }, readContract: async () => 0n };
  return { tron, builder, sign, options };
}

describe("published SDK reclaim adapter", () => {
  it("supplies isolated block headers through TronWeb without replacing the shared builder", async () => {
    const { tron, builder, options } = fixture();
    const request = { payer } as Trc20ApprovalResourceSponsoringRequest;
    let n = 0;
    const chain = await createAnchoredSponsoringChain(options, async () => ({ ...header, timestamp: ++n + 1000 }));
    const results = await Promise.all([1, 2].map(() => chain.prepareUndelegate(request, { resource: "ENERGY", stakeSun: 1000000n, requiredUnits: 1n, delegatedUnits: 1n })));
    expect(results[0].txID).not.toBe(results[1].txID);
    expect(builder.mock.calls.map(call => call[4]?.blockHeader?.timestamp)).toEqual([1001, 1002]);
    expect(builder.mock.calls.every(call => call[4]?.permissionId === 2)).toBe(true);
    expect(tron.transactionBuilder.undelegateResource).toBe(builder);
  });

  it("rejects a builder that ignores the required anchor before signing", async () => {
    const { options, sign } = fixture(true);
    const chain = await createAnchoredSponsoringChain(options, async () => header);
    await expect(chain.prepareUndelegate({ payer } as Trc20ApprovalResourceSponsoringRequest,
      { resource: "ENERGY", stakeSun: 1000000n, requiredUnits: 1n, delegatedUnits: 1n })).rejects.toThrow("sponsor_reclaim_header_mismatch");
    expect(sign).not.toHaveBeenCalled();
  });
});
