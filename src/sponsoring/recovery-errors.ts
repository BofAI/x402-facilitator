type Awaitable<T> = T | Promise<T>;

export class SponsoringStorageError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "sponsor_storage_unavailable", { cause });
    this.name = "SponsoringStorageError";
  }
}

export class RecoverableChainError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "sponsor_chain_unavailable", { cause });
    this.name = "RecoverableChainError";
  }
}

/** A reclaim guard rejected durable bytes before this attempt broadcast them.
 * A prior process may still have broadcast the same bytes, so recovery must
 * preserve the txID as unknown while treating the validation failure as fatal. */
export class ReclaimValidationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "sponsor_reclaim_validation_failed", { cause });
    this.name = "ReclaimValidationError";
  }
}

export async function storageBoundary<T>(work: () => Awaitable<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof SponsoringStorageError) throw error;
    throw new SponsoringStorageError(error);
  }
}

export async function recoverableChainBoundary<T>(work: () => Awaitable<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof SponsoringStorageError || error instanceof RecoverableChainError) throw error;
    throw new RecoverableChainError(error);
  }
}
