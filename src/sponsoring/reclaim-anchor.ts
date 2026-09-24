import { createHash } from "node:crypto";
import { utils, type TronWeb } from "tronweb";
import type { PreparedTronAction, Trc20ApprovalResourceSponsoringRequest } from "@bankofai/x402-tron";
import { RecoverableChainError } from "./recovery-errors.js";

interface Block {
  blockID: string;
  block_header: { raw_data: { number: number; timestamp: number } };
  transactions?: { txID: string; ret?: { contractRet?: string }[] }[];
}
interface Receipt { id?: string; blockNumber?: number; receipt?: { result?: string } }

/** An RPC-backed ordering proof, not finality: the signed reclaim must reference
 * a block containing the successful Approval, or a block later than its expiry.
 * All reads use FullNode. TAPOS prevents replay on a fork without that anchor. */
export function createReclaimAnchor(tron: TronWeb, now = Date.now) {
  async function rpc<T>(path: string, body: object): Promise<T> {
    let result: T & { Error?: string };
    try { result = await tron.fullNode.request<T & { Error?: string }>(path, body, "post"); }
    catch (error) { throw new RecoverableChainError(error); }
    if (!result || typeof result !== "object" || result.Error)
      throw new RecoverableChainError(new Error("sponsor_reclaim_rpc_unavailable"));
    return result;
  }
  function checkedBlock(block: Block, expectedNumber?: number): Block {
    const raw = block.block_header?.raw_data;
    if (!raw || !Number.isSafeInteger(raw.number) || raw.number < 0 ||
        !Number.isSafeInteger(raw.timestamp) || raw.timestamp <= 0 ||
        !/^[0-9a-f]{64}$/i.test(block.blockID ?? "") ||
        BigInt(`0x${block.blockID.slice(0, 16)}`) !== BigInt(raw.number) ||
        (expectedNumber !== undefined && raw.number !== expectedNumber))
      throw new Error("sponsor_reclaim_block_invalid");
    return block;
  }
  function expiration(request: Trc20ApprovalResourceSponsoringRequest): number {
    const value = Number(request.approvalExpiration);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("sponsor_approval_expiration_invalid");
    return value;
  }
  async function receipt(request: Trc20ApprovalResourceSponsoringRequest): Promise<Receipt> {
    const result = await rpc<Receipt>("wallet/gettransactioninfobyid", { value: request.approvalTxID });
    if (result.id?.toLowerCase() !== request.approvalTxID.toLowerCase() ||
        !Number.isSafeInteger(result.blockNumber) || result.blockNumber! < 0 || result.receipt?.result !== "SUCCESS")
      throw new Error("sponsor_approval_not_in_block");
    return result;
  }
  function assertIncluded(block: Block, request: Trc20ApprovalResourceSponsoringRequest) {
    if (!Array.isArray(block.transactions) || !block.transactions.some(tx =>
      tx.txID?.toLowerCase() === request.approvalTxID.toLowerCase() && tx.ret?.[0]?.contractRet === "SUCCESS"))
      throw new Error("sponsor_approval_not_in_block");
  }
  const readHead = async () => checkedBlock(await rpc<Block>("wallet/getnowblock", {}));
  const readBlock = async (number: number) => checkedBlock(await rpc<Block>("wallet/getblockbynum", { num: number }), number);
  const reference = (block: Block) => ({
    ref_block_bytes: block.blockID.slice(12, 16).toLowerCase(),
    ref_block_hash: block.blockID.slice(16, 32).toLowerCase(),
  });
  return {
    async blockHeader(request: Trc20ApprovalResourceSponsoringRequest) {
      const head = await readHead();
      let anchor = head;
      if (head.block_header.raw_data.timestamp <= expiration(request)) {
        const info = await receipt(request);
        if (info.blockNumber! > head.block_header.raw_data.number) throw new Error("sponsor_approval_not_in_block");
        anchor = await readBlock(info.blockNumber!);
        assertIncluded(anchor, request);
      }
      const timestamp = Math.max(now(), head.block_header.raw_data.timestamp);
      return { ...reference(anchor), timestamp, expiration: timestamp + 60_000 };
    },
    async assertBroadcast(request: Trc20ApprovalResourceSponsoringRequest, action: PreparedTronAction): Promise<void> {
      if (!/^(?:[0-9a-f]{2})+$/i.test(action.signedTransaction)) throw new Error("sponsor_reclaim_bytes_invalid");
      const rawBytes = Buffer.from(utils.crypto.getRowBytesFromTransactionBase64(
        Buffer.from(action.signedTransaction, "hex").toString("base64")));
      if (createHash("sha256").update(rawBytes).digest("hex") !== action.txID.toLowerCase())
        throw new Error("sponsor_reclaim_bytes_invalid");
      const raw = utils.deserializeTx.deserializeTransaction("UnDelegateResourceContract", rawBytes.toString("hex"));
      if (!/^[0-9a-f]{4}$/i.test(raw.ref_block_bytes) || !/^[0-9a-f]{16}$/i.test(raw.ref_block_hash))
        throw new Error("sponsor_reclaim_reference_invalid");
      const head = await readHead();
      const headNumber = head.block_header.raw_data.number;
      let height = Math.floor(headNumber / 65536) * 65536 + Number.parseInt(raw.ref_block_bytes, 16);
      if (height > headNumber) height -= 65536;
      if (height < 0) throw new Error("sponsor_reclaim_reference_invalid");
      const anchor = await readBlock(height);
      if (reference(anchor).ref_block_hash !== raw.ref_block_hash.toLowerCase())
        throw new Error("sponsor_reclaim_anchor_changed");
      if (anchor.block_header.raw_data.timestamp > expiration(request)) return;
      const info = await receipt(request);
      if (info.blockNumber !== height) throw new Error("sponsor_reclaim_anchor_changed");
      assertIncluded(anchor, request);
    },
  };
}
