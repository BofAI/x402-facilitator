import type { Trc20SponsoringCoordinator, Trc20SponsoringOperation } from "@bankofai/x402-tron";

export interface OwnerBinding { network: string; owner: string; permissionId: number }
export interface CapacityLimits { energy: bigint; bandwidth: bigint; budget: bigint; management: bigint }
type Awaitable<T> = T | Promise<T>;
export interface SponsoringCoordinator extends Trc20SponsoringCoordinator {
  readonly instanceId: string;
  readonly binding: OwnerBinding;
  assertOwnership(): Promise<void>;
  checked(key: string): Awaitable<void>;
  noteDelegate(key: string, now: number): Awaitable<void>;
  deadlines(key: string): Awaitable<{ businessDeadline: number; forceReclaimAt?: number }>;
  findAction(txID: string): Promise<Trc20SponsoringOperation | undefined>;
  findApproval(bytes: string): Promise<Trc20SponsoringOperation | undefined>;
  rememberExpiration(txID: string, expiration: number): Awaitable<void>;
  expiration(txID: string): Awaitable<number | undefined>;
  close(): Awaitable<void>;
}
