import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { WalletDependencies } from "@bankofai/agent-wallet";
import {
  defaultSecretProviderFactory,
  WalletCliClient,
  type SecretLease,
  type SecretProvider,
} from "@bankofai/agent-wallet/advanced";

const FACILITATOR_PASSWORD_REFERENCE = "facilitator:1password";

export class CachedWalletPassword implements SecretProvider {
  private cached?: Buffer;
  private pending?: Promise<void>;
  private readonly leases = new Set<Buffer>();
  private closed = false;

  constructor(private readonly load: () => Promise<string>) {}

  async acquire(): Promise<SecretLease> {
    if (this.closed) throw new Error("Wallet-cli password cache is closed");

    if (!this.cached) {
      this.pending ??= this.refresh().finally(() => { this.pending = undefined; });
      await this.pending;
    }
    if (this.closed) throw new Error("Wallet-cli password cache is closed");
    if (!this.cached) throw new Error("Wallet-cli password is unavailable");

    const bytes = Buffer.from(this.cached);
    this.leases.add(bytes);
    let consumed = false;
    return {
      writeTo: async destination => {
        if (!this.leases.has(bytes)) throw new Error("Wallet-cli password lease has been disposed");
        if (consumed) throw new Error("Wallet-cli password lease may only be consumed once");
        consumed = true;
        const stdin = destination as Writable;
        const flushed = finished(stdin, { readable: false, cleanup: true });
        try {
          stdin.end(bytes);
        } catch {
          stdin.destroy(new Error("Unable to write wallet-cli password to stdin"));
        }
        await flushed;
      },
      dispose: async () => {
        bytes.fill(0);
        this.leases.delete(bytes);
      },
    };
  }

  close(): void {
    this.closed = true;
    this.clearCache();
    for (const bytes of this.leases) bytes.fill(0);
    this.leases.clear();
  }

  private clearCache(): void {
    this.cached?.fill(0);
    this.cached = undefined;
  }

  private async refresh(): Promise<void> {
    let password: string;
    try {
      password = await this.load();
      if (!password.trim()) throw new Error("Empty password");
    } catch {
      throw new Error("Unable to read wallet-cli password from 1Password");
    }
    if (this.closed) throw new Error("Wallet-cli password cache is closed");

    this.cached = Buffer.from(password, "utf8");
  }
}

/** Keep 1Password credentials and the legacy password variable out of wallet-cli. */
export function walletCliDependencies(cache?: CachedWalletPassword): WalletDependencies {
  return {
    walletCli: {
      clientFactory: () => {
        const env = Object.fromEntries(Object.entries(process.env).filter(
          ([key]) => !/^OP_/i.test(key) && key.toUpperCase() !== "AGENT_WALLET_PASSWORD",
        ));
        return new WalletCliClient({ env });
      },
      secretProviderFactory: (value, context) => {
        if (value !== FACILITATOR_PASSWORD_REFERENCE) return defaultSecretProviderFactory(value, context);
        if (!cache) throw new Error("wallet-cli requires onepassword.agent_wallet_password for facilitator:1password");
        return cache;
      },
    },
  };
}
