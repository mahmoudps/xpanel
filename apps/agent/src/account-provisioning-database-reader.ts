import { withReobservedReadonlyOperationDatabase, type OperationalMigrationMode, type ReadonlyOperationDatabase } from '@xpanel/db'

/** Producer-facing port: a short pinned read-only reader per read, never the writable control handle. */
export interface ProvisioningDatabaseReaderPort {
  /** Runs one read in a fresh pinned reader; a WAL collision during that read is reobserved, never accepted. */
  readonly withReadonlyDatabase: <T>(work: (db: ReadonlyOperationDatabase) => Promise<T>) => Promise<T>
}

/**
 * Binds the pinned read-only opener to the account HTTP producer. No reader outlives one read: the
 * live control API keeps writing job progress while a held account HTTP request runs.
 */
export const createProvisioningDatabaseReaderPort = (databasePath: string, migrations: OperationalMigrationMode = 'complete'): ProvisioningDatabaseReaderPort => Object.freeze({
  withReadonlyDatabase: <T>(work: (db: ReadonlyOperationDatabase) => Promise<T>): Promise<T> =>
    withReobservedReadonlyOperationDatabase(databasePath, work, migrations),
})
