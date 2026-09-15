import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTransactionAddress, recoverTypedDataAddress, type Hex } from "viem";
import { TronWeb, utils } from "tronweb";
import { ConfigWalletProvider } from "@bankofai/agent-wallet";
import * as agentWallet from "@bankofai/agent-wallet";
import { buildResourceOwnerSigner } from "../src/sponsoring/signer.js";
import type { SponsoringConfig } from "../src/sponsoring/config.js";
vi.mock("@bankofai/agent-wallet", { spy: true });
import { requireCanonicalNetwork } from "../src/network.js";
import { buildEvmAuthorizerSigner, buildTronAuthorizerSigner, buildEvmFacilitatorSigner, buildTronFacilitatorSigner } from "../src/signer.js";

// Observe the wallet passed to each real SDK adapter without replacing its behavior.
const captured = vi.hoisted(() => ({ wallets: {} as Record<string, {
  signTransaction(payload: Record<string, unknown>): Promise<unknown>;
}> }));
vi.mock("@bankofai/x402-evm/adapters/agent-wallet", async importOriginal => {
  const actual = await importOriginal<typeof import("@bankofai/x402-evm/adapters/agent-wallet")>();
  return { ...actual, createFacilitatorEvmSigner: (...args: Parameters<typeof actual.createFacilitatorEvmSigner>) => {
    captured.wallets.evm = args[0];
    return actual.createFacilitatorEvmSigner(...args);
  } };
});
vi.mock("@bankofai/x402-tron", async importOriginal => {
  const actual = await importOriginal<typeof import("@bankofai/x402-tron")>();
  return { ...actual, createFacilitatorTronSigner: (...args: Parameters<typeof actual.createFacilitatorTronSigner>) => {
    captured.wallets.tron = args[0];
    return actual.createFacilitatorTronSigner(...args);
  } };
});

describe("agent-wallet signing compatibility", () => {
  let dir: string;
  let key: Hex;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "x402-wallet-compat-"));
    key = generatePrivateKey();
    vi.stubEnv("AGENT_WALLET_DIR", dir);
    vi.stubEnv("AGENT_WALLET_PRIVATE_KEY", key);
    vi.stubEnv("AGENT_WALLET_MNEMONIC", "");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("passes a serialized, recoverable EVM transaction to the SDK boundary", async () => {
    await buildEvmFacilitatorSigner("eip155:97");
    const serialized = await captured.wallets.evm.signTransaction({ chainId: 97, to: privateKeyToAccount(key).address,
      value: 1n, nonce: 0, gas: 21000n, gasPrice: 1n, type: "legacy" });
    expect(typeof serialized).toBe("string");
    expect(await recoverTransactionAddress({ serializedTransaction: `0x${String(serialized).replace(/^0x/, "")}` })).toBe(privateKeyToAccount(key).address);
  });

  it("passes the signed TRON transaction, preserving its digest and recoverable signature", async () => {
    await buildTronFacilitatorSigner("tron:3448148188");
    const raw_data_hex = "0a020001";
    const txID = createHash("sha256").update(Buffer.from(raw_data_hex, "hex")).digest("hex");
    const signed = await captured.wallets.tron.signTransaction({ raw_data_hex, txID }) as { txID: string; raw_data_hex: string; signature: string[] };
    expect(signed.txID).toBe(txID);
    expect(signed.raw_data_hex).toBe(raw_data_hex);
    expect(utils.crypto.ecRecover(txID, signed.signature[0]).toLowerCase()).toBe(TronWeb.address.toHex(TronWeb.address.fromPrivateKey(key.slice(2)) as string));
  });

  it.each([
    ["evm", undefined, 1], ["tron", undefined, 728126428],
    ["evm", "eip155:97", 97], ["tron", "tron:3448148188", 3448148188],
  ] as const)("resolves and signs %s authorizer typed data on %s", async (family, network, chainId) => {
    const authorizer = family === "evm" ? await buildEvmAuthorizerSigner(network) : await buildTronAuthorizerSigner(network);
    const message = { domain: { name: "x402 compatibility", version: "1", chainId },
      types: { Claim: [{ name: "amount", type: "uint256" }] }, primaryType: "Claim", message: { amount: 123n } };
    const signature = await authorizer.signTypedData(message);
    expect(await recoverTypedDataAddress({ ...message, signature: signature as Hex })).toBe(privateKeyToAccount(key).address);
    expect(authorizer.address).toBe(family === "evm" ? privateKeyToAccount(key).address : TronWeb.address.fromPrivateKey(key.slice(2)));
    expect(agentWallet.resolveWallet).toHaveBeenCalledWith({ network: network ?? (family === "evm" ? "eip155:1" : "tron:728126428") });
  });

  it("signs a Resource Owner transaction using the explicitly selected temporary wallet", async () => {
    const provider = new ConfigWalletProvider(dir);
    provider.addWallet("active", { type: "raw_secret", params: { source: "private_key", private_key: key } });
    const keyAddress = TronWeb.address.fromPrivateKey(key.slice(2)) as string;
    const owner = TronWeb.address.fromPrivateKey(generatePrivateKey().slice(2)) as string;
    const settlement = TronWeb.address.fromPrivateKey(generatePrivateKey().slice(2)) as string;
    const tron = new TronWeb({ fullHost: "http://127.0.0.1:1" });
    const mask = Buffer.alloc(32); mask[7] = 6;
    vi.spyOn(tron.trx, "getAccount").mockResolvedValue({ active_permission: [{ id: 2, type: 2, threshold: 1,
      operations: mask.toString("hex"), keys: [{ address: keyAddress, weight: 1 }] }] } as never);
    const config = { network: "tron:3448148188", wallet_id: "active", wallet_dir: dir, owner, permission_id: 2 } as SponsoringConfig;
    let preparedId: string | undefined;
    const signer = await buildResourceOwnerSigner(config, tron, settlement, id => { preparedId = id; });
    const raw_data_hex = "0a020001";
    const txID = createHash("sha256").update(Buffer.from(raw_data_hex, "hex")).digest("hex");
    const transaction = { txID, raw_data_hex, raw_data: { timestamp: Date.now(), expiration: Date.now() + 60000 } };
    const result = await signer.signResourceTransaction({ transaction, intent: { network: config.network, owner,
      permissionId: 2, lock: false, action: "delegate", resource: "ENERGY", receiver: settlement, stakeSun: "1" } });
    expect(result.txID).toBe(txID);
    expect(preparedId).toBe(txID);
    expect(utils.crypto.ecRecover(txID, (result.signature as string[])[0]).toLowerCase()).toBe(TronWeb.address.toHex(keyAddress));
  });

  it.each(["evm", "tron"] as const)("rejects the wrong transaction artifact family for %s", async family => {
    vi.spyOn(agentWallet, "resolveWallet").mockResolvedValue({
      getAddress: async () => family === "evm" ? privateKeyToAccount(key).address : TronWeb.address.fromPrivateKey(key.slice(2)) as string,
      signTransaction: async () => family === "evm" ? { family: "tron", transaction: {} } : { family: "evm", rawTransaction: "00" },
    });
    if (family === "evm") await buildEvmFacilitatorSigner("eip155:97");
    else await buildTronFacilitatorSigner("tron:3448148188");
    await expect(captured.wallets[family].signTransaction({})).rejects.toThrow(/Expected .* signed transaction artifact/);
  });
});

describe("canonical network validation", () => {
  it("passes canonical CAIP-2 ids through unchanged", () => {
    expect(requireCanonicalNetwork("tron:0x2b6653dc")).toBe("tron:728126428");
    expect(requireCanonicalNetwork("eip155:97")).toBe("eip155:97");
  });

  it("rejects aliases and unknown networks", () => {
    expect(() => requireCanonicalNetwork("bsc:testnet")).toThrow(/Unsupported canonical CAIP-2 network/);
    expect(() => requireCanonicalNetwork("eip155:999")).toThrow(/Unsupported canonical CAIP-2 network/);
  });
});
