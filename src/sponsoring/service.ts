import { TronWeb, providers } from "tronweb";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { createTrc20ApprovalResourceSponsoringRuntime,
  createStaticTrc20ResourceSponsoringPolicy, createTrc20ApprovalPolicy,
  type FacilitatorTronSigner, type Trc20ApprovalResourceSponsoringRuntime,
  normalizeTronNetwork, type Trc20SponsoringOperation, type Trc20ResourceLeg } from "@bankofai/x402-tron";
import { createSponsoringCoordinator } from "./store-factory.js";
import { guardSponsoringChain } from "./chain.js";
import { createAnchoredSponsoringChain } from "./sdk-chain.js";
import { createReclaimAnchor } from "./reclaim-anchor.js";
import { buildResourceOwnerSigner } from "./signer.js";
import { recoverExpiredOperation } from "./recovery.js";
import { RecoverableChainError, recoverableChainBoundary, storageBoundary } from "./recovery-errors.js";
import { hasUnresolvedResourceActions } from "./admission.js";
import type { SponsoringConfig } from "./config.js";
import { rpcFor, requireCanonicalNetwork } from "../network.js";
import { logger } from "../logger.js";
import type { SponsoringAccess } from "./access.js";
import { sponsoringReady, recoveryErrors, sponsorResults, activeSponsors } from "./metrics.js";

type HttpMethod = Parameters<InstanceType<typeof providers.HttpProvider>["request"]>[2];
class RecoverableHttpProvider extends providers.HttpProvider {
  override async request<T = unknown>(url: string, payload?: object,
    method?: HttpMethod): Promise<T> {
    return recoverableChainBoundary(() => super.request<T>(url, payload, method));
  }
}

export interface SponsoringService {
  runtime: Trc20ApprovalResourceSponsoringRuntime;
  access(): SponsoringAccess;
  readiness(): { ready: boolean; mode: string; network: string };
  start(): void;
  close(): Promise<void>;
}

/** FullNode allowance is provisional; resource receipts and inventory are solidified. */
export async function createSponsoringService(config: SponsoringConfig, settlement: FacilitatorTronSigner,
  options: { pool?: Pool } = {}): Promise<SponsoringService> {
  const endpoint = rpcFor(requireCanonicalNetwork(config.network));
  const headers = process.env.TRON_GRID_API_KEY ? { "TRON-PRO-API-KEY": process.env.TRON_GRID_API_KEY } : {};
  const provider = () => new RecoverableHttpProvider(endpoint, 15000, "", "", headers);
  const tron = new TronWeb({ fullNode: provider(), solidityNode: provider() });
  const store = await createSponsoringCoordinator(config, options.pool);
  try {
    const signer = await buildResourceOwnerSigner(config, tron, settlement.getAddresses()[0],
      (txID, expiration) => storageBoundary(() => store.rememberExpiration(txID, expiration)),
      () => storageBoundary(() => store.assertOwnership()));
    const reclaimAnchor = createReclaimAnchor(tron);
    const readContract: FacilitatorTronSigner["readContract"] = args =>
      recoverableChainBoundary(() => settlement.readContract(args));
    const base = await createAnchoredSponsoringChain({ tronWeb: tron, network: config.network,
      resourceOwnerSigner: signer, readContract, allowedAssets: config.assets,
      permissionId: config.permission_id, confirmationMode: "solidified", confirmationTimeoutMs: 90000,
      minimumApprovalBroadcastWindowMs: 285000, confirmationPollIntervalMs: 3000 }, reclaimAnchor.blockHeader);
    const chain = guardSponsoringChain({ ...base, async confirm(txID) {
      const result = await base.confirm(txID);
      if (result !== "unknown") return result;
      const expiration = await storageBoundary(() => store.expiration(txID));
      if (expiration === undefined) return result;
      // base.confirm intentionally folds transport failures into "unknown".
      // A successful fresh read is required before declaring an expired tx absent.
      const receipt = await tron.solidityNode.request<{ blockNumber?: number; receipt?: { result?: string }; Error?: string }>(
        "walletsolidity/gettransactioninfobyid", { value: txID }, "post");
      if (receipt.Error) throw new RecoverableChainError(new Error("sponsor_confirmation_unavailable"));
      if (receipt.blockNumber != null) return receipt.receipt?.result && receipt.receipt.result !== "SUCCESS" ? "failed" : "confirmed";
      const block = await tron.solidityNode.request<{ block_header: { raw_data: { timestamp: number } } }>("walletsolidity/getnowblock", {}, "post");
      return block.block_header.raw_data.timestamp > expiration ? "failed" : "unknown";
    } }, store, { assertReclaim: reclaimAnchor.assertBroadcast });
    const sdk = createTrc20ApprovalResourceSponsoringRuntime({ chain, coordinator: store,
      policy: createStaticTrc20ResourceSponsoringPolicy({ allowedNetworks: [config.network],
        allowedAssets: { [config.network]: config.assets }, maxReplacementCost: BigInt(config.budget_sun) }),
      approvalPolicy: createTrc20ApprovalPolicy({ allowedAssets: { [config.network]: config.assets } }) });
    let mode = "BOOTING";
    sponsoringReady.set({ network: config.network }, 0);
    let stopping = false;
    let running: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastInventoryCheck = 0;
    let inventoryValidated = false;
    const sponsorWork = new Set<Promise<unknown>>();

    async function refreshAdmission(): Promise<void> {
      const reserved = await store.listRecoverable(Number.MAX_SAFE_INTEGER);
      mode = reserved.some(hasUnresolvedResourceActions) ? "RECOVERING" : "READY";
      activeSponsors.set({ network: config.network }, reserved.length);
      sponsoringReady.set({ network: config.network }, mode === "READY" ? 1 : 0);
    }

    async function delegated(operation: Trc20SponsoringOperation, leg: Trc20ResourceLeg): Promise<bigint> {
      const result = await recoverableChainBoundary(() => tron.solidityNode.request<{ delegatedResource?: { from: string; to: string;
        frozen_balance_for_energy?: number; frozen_balance_for_bandwidth?: number }[]; Error?: string }>(
          "walletsolidity/getdelegatedresourcev2", { fromAddress: TronWeb.address.toHex(config.owner),
            toAddress: TronWeb.address.toHex(operation.payer) }, "post"));
      if (result.Error || (result.delegatedResource !== undefined && !Array.isArray(result.delegatedResource)))
        throw new RecoverableChainError(new Error("sponsor_inventory_unavailable"));
      let total = 0n;
      for (const row of result.delegatedResource ?? []) {
        if (row.from.toLowerCase() !== TronWeb.address.toHex(config.owner).toLowerCase() ||
            row.to.toLowerCase() !== TronWeb.address.toHex(operation.payer).toLowerCase()) throw new Error("sponsor_inventory_inconsistent");
        const amount = leg.resource === "ENERGY" ? row.frozen_balance_for_energy : row.frozen_balance_for_bandwidth;
        if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) throw new Error("sponsor_inventory_inconsistent");
        total += BigInt(amount ?? 0);
      }
      return total;
    }

    async function tick(): Promise<void> {
      await store.runExclusive("resource-owner", async () => {
        if (stopping) return;
        const recovering = mode !== "READY";
        const operations = await store.listRecoverable(100);
        let recoveryFailure: RecoverableChainError | undefined;
        for (const operation of operations) {
          try {
            if (Date.now() >= (await store.deadlines(operation.key)).businessDeadline) {
              await store.runExclusive(`${operation.network}:${operation.payer}`, async () => {
                await recoverExpiredOperation(operation, store, chain, delegated);
              });
            }
          } catch (error) {
            if (!(error instanceof RecoverableChainError)) throw error;
            recoveryFailure ??= error;
          }
          // A failed first record must rotate too, otherwise every subsequent
          // timer tick retries it and other local delegations never recover.
          await store.checked(operation.key);
        }
        await sdk.reconcile(100);
        if (recoveryFailure) throw recoveryFailure;
        if (Date.now() - lastInventoryCheck >= 300000 || recovering) {
          const local = await store.listRecoverable(Number.MAX_SAFE_INTEGER);
          const index = await tron.solidityNode.request<{ toAccounts?: string[]; Error?: string }>(
            "walletsolidity/getdelegatedresourceaccountindexv2", { value: TronWeb.address.toHex(config.owner) }, "post");
          if (index.Error || (index.toAccounts !== undefined && !Array.isArray(index.toAccounts)))
            throw new Error("sponsor_inventory_unavailable");
          for (const receiver of index.toAccounts ?? []) {
            const operation = local.find(op => TronWeb.address.toHex(op.payer).toLowerCase() === TronWeb.address.toHex(receiver).toLowerCase());
            if (!operation) throw new Error("sponsor_capacity_inconsistent");
            for (const resource of ["ENERGY", "BANDWIDTH"] as const) {
              const leg = operation.plan.legs.find(leg => leg.resource === resource);
              const amount = await delegated(operation, leg ?? { resource, stakeSun: 0n, requiredUnits: 0n, delegatedUnits: 0n });
              if (amount > (leg?.stakeSun ?? 0n)) throw new Error("sponsor_capacity_inconsistent");
            }
          }
          lastInventoryCheck = Date.now();
          inventoryValidated = true;
        }
        await refreshAdmission();
      });
    }

    function schedule() {
      if (stopping) return;
      running = tick().catch(error => {
        if (error instanceof Error && error.message === "sponsor_owner_busy") return;
        mode = "DEGRADED";
        inventoryValidated = false;
        sponsoringReady.set({ network: config.network }, 0);
        recoveryErrors.inc({ network: config.network });
        logger.error("Resource sponsoring recovery failed", { network: config.network });
      }).finally(() => {
        running = undefined;
        if (!stopping) { timer = setTimeout(schedule, 15000); timer.unref(); }
      });
    }

    function assertRequest(request: Parameters<Trc20ApprovalResourceSponsoringRuntime["verify"]>[0]) {
      if (request.network !== config.network) throw new Error("sponsor_network_disabled");
      // SDK guarantees ten minutes from construction completion, while raw
      // timestamp precedes the RPC round trip. Allow bounded construction skew.
      if (BigInt(request.approvalExpiration) - BigInt(request.approvalTimestamp) > 630000n)
        throw new Error("sponsor_approval_lifetime_exceeded");
      if (!config.pay_to.some(address => TronWeb.address.toHex(address).toLowerCase() === TronWeb.address.toHex(request.paymentRequirements.payTo).toLowerCase()))
        throw new Error("sponsor_pay_to_forbidden");
    }

    async function existingOperation(request: Trc20SponsoringOperation["request"]) {
      // Keep the SDK's legacy Nile operation keys readable without moving records.
      for (const network of [config.network, `tron:0x${BigInt(config.network.split(":")[1]).toString(16)}`]) {
        const operation = await store.get(`${network}:${request.approvalTxID.toLowerCase()}`);
        if (operation) return operation;
      }
    }

    function retryRequest(request: Trc20SponsoringOperation["request"]) {
      return { ...request, network: normalizeTronNetwork(request.network),
        requiredAllowance: request.requiredAllowance ?? request.paymentRequirements.amount,
        paymentRequirements: { ...request.paymentRequirements, network: normalizeTronNetwork(request.paymentRequirements.network) },
        paymentPayload: { ...request.paymentPayload, accepted: { ...request.paymentPayload.accepted,
          network: normalizeTronNetwork(request.paymentPayload.accepted.network) } } };
    }

    function unavailable(error: unknown): string {
      if (error instanceof Error && error.message === "sponsor_owner_busy") return "sponsor_owner_busy";
      mode = "DEGRADED";
      inventoryValidated = false;
      sponsoringReady.set({ network: config.network }, 0);
      return "sponsor_storage_unavailable";
    }

    function canRetryExisting() { return !stopping && inventoryValidated && mode === "RECOVERING"; }

    return {
      runtime: {
        async verify(request) {
          try { assertRequest(request); } catch (error) { return { isValid: false, invalidReason: (error as Error).message }; }
          if (stopping || (mode !== "READY" && !canRetryExisting())) return { isValid: false, invalidReason: "sponsor_recovery_in_progress" };
          try {
            const existing = await existingOperation(request);
            if (mode !== "READY" && !existing) return { isValid: false, invalidReason: "sponsor_recovery_in_progress" };
            // SDK verify is read-only preflight, not its digest-aware execution path.
            // Conservatively reject changed retries here; sponsor still uses SDK digest checks.
            if (existing && !isDeepStrictEqual(retryRequest(existing.request), retryRequest(request)))
              return { isValid: false, invalidReason: "approval_transaction_reused" };
            // A bound retry with effective allowance needs no fresh Approval
            // broadcast window. Payment validity remains the scheme's responsibility.
            if (existing && await chain.allowanceSufficient(request)) return { isValid: true };
            return await sdk.verify(request);
          } catch (error) { return { isValid: false, invalidReason: unavailable(error) }; }
        },
        async sponsor(request, options) {
          if (stopping) return { success: false, errorReason: "sponsor_recovery_in_progress" };
          const work = store.runExclusive("resource-owner", async () => {
            try { assertRequest(request); } catch (error) { return { success: false, errorReason: (error as Error).message }; }
            if (stopping || (mode !== "READY" && !canRetryExisting())) return { success: false, errorReason: "sponsor_recovery_in_progress" };
            const existing = await existingOperation(request);
            const pending = await store.listRecoverable(Number.MAX_SAFE_INTEGER);
            await refreshAdmission();
            if (pending.some(operation => operation.key !== existing?.key && hasUnresolvedResourceActions(operation)))
              return { success: false, errorReason: "sponsor_recovery_in_progress" };
            if (!existing && mode !== "READY") return { success: false, errorReason: "sponsor_recovery_in_progress" };
            if (!existing) {
              for (const resource of ["ENERGY", "BANDWIDTH"] as const) {
                const amount = await delegated({ payer: request.payer } as Trc20SponsoringOperation,
                  { resource, stakeSun: 0n, requiredUnits: 0n, delegatedUnits: 0n });
                if (amount > 0n) return { success: false, errorReason: "sponsor_existing_delegation" };
              }
            }
            // All owner writes are serialized across HTTP requests and the worker.
            const result = await sdk.sponsor(request, options);
            sponsorResults.inc({ network: config.network, result: result.success ? "success" : "failure" });
            await refreshAdmission();
            logger.info("Resource sponsoring execution finished", { network: config.network, success: result.success });
            return result;
          });
          sponsorWork.add(work);
          try { return await work; }
          catch (error) { return { success: false, errorReason: unavailable(error) }; }
          finally { sponsorWork.delete(work); }
        },
      },
      access: () => ({ network: config.network, payTo: config.pay_to, ready: mode === "READY" && !stopping,
        canRetryExisting: canRetryExisting() }),
      readiness: () => ({ ready: mode === "READY" && !stopping, mode, network: config.network }),
      start() { if (!running && !timer) schedule(); },
      async close() {
        stopping = true;
        sponsoringReady.set({ network: config.network }, 0);
        if (timer) clearTimeout(timer);
        await running;
        await Promise.allSettled([...sponsorWork]);
        await store.close();
      },
    };
  } catch (error) { await store.close(); throw error; }
}
