/**
 * Scope adapter for the account HTTP producer's read-only operation database.
 *
 * A held native observation outlives the call that opened it, while a pinned read-only
 * database scope never outlives its own callback. This module re-enters a fresh scope for
 * each callback of the held observation and exposes the live reader only inside that scope.
 * It keeps no runtime imports so its invariants are testable without a workspace install.
 */

export interface ReadonlyDatabaseScope {
  /** Runs one observation unit inside a fresh pinned read-only operation database scope. */
  readonly withReadonlyDatabase: <T>(work: (db: unknown) => Promise<T>) => Promise<T>
  /** The reader held by the currently executing observation unit, or null outside one. */
  readonly database: () => unknown | null
}

export interface HeldScopedObservation {
  assertCurrent(): Promise<void>
  close(): Promise<void>
}

export interface LiveReaderSlot extends ReadonlyDatabaseScope {
  /** Current live reader; null when no observation unit is executing. */
  readonly database: () => unknown | null
}

/** Binds one injected read-only opener to a slot that the producer reads synchronously. */
export const createLiveReaderSlot = (
  withReadonlyDatabase: <T>(work: (db: unknown) => Promise<T>) => Promise<T>,
): LiveReaderSlot => {
  let live: unknown | null = null
  const scoped = async <T>(work: (db: unknown) => Promise<T>): Promise<T> => {
    const previous = live
    try {
      return await withReadonlyDatabase(async db => {
        live = db
        try { return await work(db) } finally { live = previous }
      })
    } finally { live = previous }
  }
  return Object.freeze({ withReadonlyDatabase: scoped, database: (): unknown | null => live })
}

/**
 * Re-enters a fresh read-only scope for every later assertion or release of a held observation.
 * The producer independently re-checks the pinned generation and authority on each call, so a
 * replacement reader can never turn a stale observation into a current one.
 */
export const heldObservationInDatabaseScope = <H extends HeldScopedObservation>(
  port: Pick<ReadonlyDatabaseScope, 'withReadonlyDatabase'>, held: H,
): H => {
  let closing: Promise<void> | undefined
  const wrapped = {
    ...held,
    assertCurrent: (): Promise<void> => port.withReadonlyDatabase(async () => held.assertCurrent()),
    close: (): Promise<void> => closing ??= port.withReadonlyDatabase(async () => held.close()),
  }
  return Object.freeze(wrapped) as unknown as H
}
