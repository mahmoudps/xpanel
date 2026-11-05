import { fail } from '@xpanel/core'
import { withReobservedReadonlyOperationDatabase, type Db, type ReadonlyOperationDatabase } from '@xpanel/db'
import { createLiveReaderSlot, heldObservationInDatabaseScope, type HeldScopedObservation } from './account-provisioning-database-scope.ts'

/** Producer-facing port: a live pinned read-only reader, never the writable control handle. */
export interface ProvisioningDatabaseReaderPort {
  readonly withReadonlyDatabase: <T>(work: (db: ReadonlyOperationDatabase) => Promise<T>) => Promise<T>
  /** The reader held by the currently executing observation unit; refuses outside that scope. */
  readonly database: () => Db
}

const unavailable = (): never => fail('PRECONDITION_FAILED', 'the account provisioning database reader is not held', {
  stateChanged: false, verificationRequired: true, reason: 'provisioning_database_reader_unavailable',
})

/**
 * Binds the pinned read-only opener to the account HTTP producer. The producer never receives the
 * writable control database, and every held-observation callback re-enters a live scope.
 */
export const createProvisioningDatabaseReaderPort = (databasePath: string): ProvisioningDatabaseReaderPort => {
  const slot = createLiveReaderSlot(<T>(work: (db: unknown) => Promise<T>) =>
    withReobservedReadonlyOperationDatabase(databasePath, db => work(db as ReadonlyOperationDatabase)))
  return Object.freeze({
    withReadonlyDatabase: <T>(work: (db: ReadonlyOperationDatabase) => Promise<T>): Promise<T> =>
      slot.withReadonlyDatabase(db => work(db as ReadonlyOperationDatabase)),
    database: (): Db => {
      const live = slot.database()
      return live === null ? unavailable() : live as Db
    },
  })
}

/** Wraps a held native observation so later assertions and release re-enter a live read-only scope. */
export const heldObservationInReaderScope = <H extends HeldScopedObservation>(
  port: Pick<ProvisioningDatabaseReaderPort, 'withReadonlyDatabase'>, held: H,
): H => heldObservationInDatabaseScope(port, held)
