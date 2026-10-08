import { describe, expect, it, vi, afterEach } from "vitest";
import { TronWeb, utils } from "tronweb";
import { createTronWebResourceSponsoringChain, TRON_NILE, type Trc20ApprovalResourceSponsoringRequest } from "@bankofai/x402-tron";
import { buildResourceOwnerSigner } from "../src/sponsoring/signer.js";
import { sponsoringConfigSchema } from "../src/sponsoring/config.js";

const wallet = vi.hoisted(() => ({ getAddress: vi.fn(), signTransaction: vi.fn() }));
vi.mock("@bankofai/agent-wallet", () => ({ resolveWallet: async () => wallet }));
const owner = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const payer = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
const active = TronWeb.address.fromHex(`41${"33".repeat(20)}`);
const settlement = TronWeb.address.fromHex(`41${"44".repeat(20)}`);
const config = sponsoringConfigSchema.parse({ network: TRON_NILE, database: "/tmp/unused-signer-test.sqlite", owner,
  wallet_id: "test-active", permission_id: 2, assets: [payer], pay_to: [settlement],
  energy_stake_sun: "100000000", bandwidth_stake_sun: "100000000", budget_sun: "1000000", management_bandwidth: "10000" });
const leg = { resource: "ENERGY" as const, stakeSun: 1000000n, requiredUnits: 100n, delegatedUnits: 100n };
const request = { network: TRON_NILE, payer } as Trc20ApprovalResourceSponsoringRequest;

function unsigned() {
  return { visible: false, raw_data: {
    contract: [{ type: "DelegateResourceContract", Permission_id: 2, parameter: {
      type_url: "type.googleapis.com/protocol.DelegateResourceContract", value: {
        owner_address: TronWeb.address.toHex(owner), receiver_address: TronWeb.address.toHex(payer),
        balance: 1000000, resource: "ENERGY", lock: false, lock_period: 0,
      },
    } }], ref_block_bytes: "1234", ref_block_hash: "0102030405060708",
    timestamp: Date.now(), expiration: Date.now() + 60000,
  } };
}
function encode(tx: ReturnType<typeof unsigned>) {
  const pb = utils.transaction.txJsonToPb(tx);
  return { ...tx, raw_data_hex: utils.transaction.txPbToRawDataHex(pb), txID: utils.transaction.txPbToTxID(pb).replace(/^0x/, "") };
}
async function harness(transaction = encode(unsigned()), prepared?: () => Promise<void>, assertOwnership?: () => Promise<void>) {
  wallet.getAddress.mockResolvedValue(active);
  wallet.signTransaction.mockImplementation(async tx => ({ family: "tron", transaction: { ...tx, signature: ["11".repeat(65)] } }));
  const permission = { id: 2, type: "Active", threshold: 1, operations: `${"00".repeat(7)}06${"00".repeat(24)}`,
    keys: [{ address: active, weight: 1 }] };
  const tron = { trx: { getAccount: async () => ({ active_permission: [permission] }) },
    transactionBuilder: { delegateResource: async () => transaction } } as unknown as TronWeb;
  const expirations: string[] = [];
  const signer = await buildResourceOwnerSigner(config, tron, settlement, async txID => { await prepared?.(); expirations.push(txID); }, assertOwnership);
  const chain = await createTronWebResourceSponsoringChain({ tronWeb: tron, network: TRON_NILE,
    resourceOwnerSigner: signer, readContract: async () => 0n, allowedAssets: [payer], permissionId: 2 });
  return { chain, permission, expirations };
}
afterEach(() => vi.resetAllMocks());

describe("published SDK and restricted signer boundary", () => {
  it("does not complete preparation before expiry persistence finishes", async () => {
    let release!: () => void;
    const { chain, expirations } = await harness(undefined, () => new Promise<void>(r => { release = r; }));
    let finished = false;
    const pending = chain.prepareDelegate(request, leg).then(value => { finished = true; return value; });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(finished).toBe(false);
    release();
    await pending;
    expect(expirations).toHaveLength(1);
  });
  it.each(["before-sign", "during-sign", "during-persist"])("rejects ownership lost %s", async phase => {
    let valid = phase !== "before-sign";
    const check = async () => { if (!valid) throw new Error("sponsor_owner_lock_lost"); };
    const { chain } = await harness(undefined, async () => { if (phase === "during-persist") valid = false; }, check);
    wallet.signTransaction.mockImplementation(async tx => {
      if (phase === "during-sign") valid = false;
      return { family: "tron", transaction: { ...tx, signature: ["11".repeat(65)] } };
    });
    await expect(chain.prepareDelegate(request, leg)).rejects.toThrow("sponsor_owner_lock_lost");
    if (phase === "before-sign") expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
  it("signs an exact protobuf-validated intent and records its expiration", async () => {
    const tx = encode(unsigned());
    const { chain, expirations } = await harness(tx);
    const prepared = await chain.prepareDelegate(request, leg);
    expect(prepared.txID).toBe(tx.txID);
    expect(expirations).toEqual([tx.txID]);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "receiver", "stake", "resource", "lock", "permission", "extra-contract", "raw-bytes", "txid"])(
    "rejects RPC manipulation of %s without reaching the wallet", async mutation => {
      const tx = unsigned();
      const contract = tx.raw_data.contract[0];
      const value = contract.parameter.value;
      if (mutation === "owner") value.owner_address = TronWeb.address.toHex(payer);
      if (mutation === "receiver") value.receiver_address = TronWeb.address.toHex(owner);
      if (mutation === "stake") value.balance += 1;
      if (mutation === "resource") value.resource = "BANDWIDTH";
      if (mutation === "lock") value.lock = true;
      if (mutation === "permission") contract.Permission_id = 3;
      if (mutation === "extra-contract") tx.raw_data.contract.push(structuredClone(contract));
      const encoded = encode(tx);
      if (mutation === "raw-bytes") encoded.raw_data_hex = "00";
      if (mutation === "txid") encoded.txID = "00".repeat(32);
      const { chain } = await harness(encoded);
      await expect(chain.prepareDelegate(request, leg)).rejects.toThrow();
      expect(wallet.signTransaction).not.toHaveBeenCalled();
    },
  );

  it("rechecks narrowed permission on every signature even after SDK caches its lookup", async () => {
    const { chain, permission } = await harness();
    await chain.prepareDelegate(request, leg);
    permission.operations = "ff".repeat(32);
    await expect(chain.prepareDelegate(request, leg)).rejects.toThrow("resource_owner_permission_invalid");
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects a wallet that mutates the signed raw data", async () => {
    const { chain, expirations } = await harness();
    wallet.signTransaction.mockImplementation(async tx => ({ family: "tron", transaction: { ...tx, raw_data_hex: "00", signature: ["11".repeat(65)] } }));
    await expect(chain.prepareDelegate(request, leg)).rejects.toThrow("resource_owner_signed_transaction_mismatch");
    expect(expirations).toEqual([]);
  });

  it("rejects a non-TRON artifact without recording a prepared transaction", async () => {
    const { chain, expirations } = await harness();
    wallet.signTransaction.mockResolvedValue({ family: "evm", rawTransaction: "00" });
    await expect(chain.prepareDelegate(request, leg)).rejects.toThrow("resource_owner_signed_transaction_family_invalid");
    expect(expirations).toEqual([]);
  });

  it.each(["expired", "long-lived"])("rejects %s resource transactions before wallet signing", async kind => {
    const tx = unsigned();
    tx.raw_data.expiration = kind === "expired" ? Date.now() - 1 : tx.raw_data.timestamp + 300001;
    const { chain } = await harness(encode(tx));
    await expect(chain.prepareDelegate(request, leg)).rejects.toThrow("resource_transaction_expiration_invalid");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
});
