import { TronWeb } from "tronweb";
import { TRON_NILE, normalizeTronNetwork } from "@bankofai/x402-tron";

export interface SponsoringAccess { network: string; ready: boolean; canRetryExisting?: boolean; requireApiKey?: boolean }

export function sponsoringAccessError(extensions: Record<string, unknown> | undefined,
  requirements: { network: string; payTo: string }, authenticated: boolean, access?: SponsoringAccess): string | undefined {
  if (!extensions || !("trc20ApprovalResourceSponsoring" in extensions)) return;
  // Fail closed unless both the deployment and requested network explicitly allow Nile anonymity.
  const anonymousNile = access?.requireApiKey === false && normalizeTronNetwork(access.network) === TRON_NILE
    && normalizeTronNetwork(requirements.network) === TRON_NILE;
  if (!authenticated && !anonymousNile) return "sponsor_auth_required";
  if (!access || normalizeTronNetwork(access.network) !== normalizeTronNetwork(requirements.network)) return "sponsor_network_disabled";
  if (!TronWeb.isAddress(requirements.payTo)) return "sponsor_pay_to_invalid";
  if (!access.ready && !access.canRetryExisting) return "sponsor_recovery_in_progress";
}
