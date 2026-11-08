import { fail } from '@xpanel/core'
import type { OperationalMigrationMode } from './schema.ts'

// Package-internal; the package index never exports this module, so no caller can rebind a runner.
const bound = new WeakMap<object, OperationalMigrationMode>()
let migrated = false

export const assertMigrationMode = (mode: unknown): OperationalMigrationMode =>
  mode === 'complete' || mode === 'pre-migration' ? mode : fail('VALIDATION', 'migrations must be complete or pre-migration')

/** Genuine runners bind the mode named where their connection opened, before they are handed out. */
export const bindMigrationMode = (runner: object, mode: OperationalMigrationMode): void => { bound.set(runner, mode) }

/** After this process has applied this build's migrations, every scope requires the complete reviewed set. */
export const effectiveMigrationMode = (mode: OperationalMigrationMode): OperationalMigrationMode => migrated ? 'complete' : mode

export const migrationModeOf = (runner: unknown): OperationalMigrationMode =>
  effectiveMigrationMode((typeof runner === 'object' && runner !== null ? bound.get(runner) : undefined) ?? 'complete')

export const markOperationalMigrationsApplied = (): void => { migrated = true }
/** A restored pre-migration snapshot makes this process read the shorter reviewed prefix again. */
export const markOperationalMigrationsRestored = (): void => { migrated = false }
