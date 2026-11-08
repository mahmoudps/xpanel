# Pre-migration reads of the operational database

Date: 2026-11-08.

## Problem

An upgrade runs the target release before that release migrates the database. Coordinator rotation, release acquisition, the coordinator service, upgrade admission and recovery all read `/var/lib/xpanel/control.db` from the target release, and every read required the applied migrations to equal the target's complete reviewed set (`OPERATIONAL_MIGRATION_NAMES`). A host with 0001 to 0006 applied could therefore never reach the migrate phase of a release that ships 0007 and 0008: rotation refused with `reviewed_schema_required` and `stateChanged: false`.

## Decision

`schema.ts` names two modes, `OperationalMigrationMode`:

- `complete`: the applied rows equal this build's complete reviewed set. This is the default for every connection and reader.
- `pre-migration`: the applied rows are an exact prefix of the reviewed set, compared row by row on version, name and checksum, at least `OPERATIONAL_SCHEMA_VERSION` (3) rows long. Rows are never filtered. A gap, an extra or unknown row, a changed name or checksum, a reordered row or an extra column refuses, as before.

The receipt rule is unchanged: the identity receipt (`OPERATIONAL_IDENTITY_MIGRATIONS_JSON`) is accepted, and an exact applied receipt must equal the exact applied set it was issued for, so a receipt issued for one prefix does not match a longer or shorter one.

A connection or reader takes its mode where it opens: `createDb(..., { migrations })`, the last argument of `withReadonlyOperationDatabase`, `withReobservedReadonlyOperationDatabase` and `withReadonlyClosedOperationDatabase`, and the `migrations` option of `withReopenedReadonlyHostOperationGuard`. Everything that receives that connection uses its mode: the strict origin (`getStrictOperationDatabaseOrigin`), `requireOperationalIdentity` and so jobs, host-operation guards and the operation audit authority.

## Where `pre-migration` is named

Only code of the target release that reads the host database before its migrate phase:

- coordinator rotation: `observePreparedAdoptionSource(prepared, 'pre-migration')` and `withCoordinatorDatabaseAuthority('pre-migration', ...)`, which passes the mode to its host-operation guard and root readers;
- release acquisition: `observeInstalledAcquisitionSource`, through the installation-transition observation readers;
- the coordinator service: the upgrade hand-off connection (`upgrade-coordinator-bootstrap.ts`) and the hosted-UID qualification readers;
- `lifecycle-root-safety.mjs`: the admission readers, the admission writer, the recovery observation readers, the issued-audit repair writer and the recovery generation reader. The initial installation value records `currentSchemaVersion` of that writer, so it records the host's own schema;
- the lifecycle canary reader in `native-runtime.ts`.

The API, the agent, installation, install finalization, adoption, coordinator install and the agent private-state migration keep `complete`.

## After the migrate phase

The production migrator calls `completeOperationalMigrations` after `migrate`, and when nothing is pending. On a `pre-migration` connection it proves the complete reviewed set and then switches the whole process to `complete`, so every later read of the upgrade, including readers already open, requires the complete set. If proof fails, the process stays in `pre-migration` and the upgrade aborts before the switch. A migration that fails part-way leaves an exact prefix, which the abort path can still read.

## Rollback restores the database

The previous release refuses a database with migrations it does not review, so no path may return to it while the migrated database stays. Every rollback path after the migrate phase now restores the control database from the copy the `snapshot` phase took (`<snapshot>.control.db`), bound to the hash this upgrade recorded:

| Path | Database |
|---|---|
| Switch failure | rewind step `index` restores the snapshot |
| Health-check failure | rewind step `index` restores the snapshot |
| Failure after a migration ran, before the switch | `abortBeforeSwitch` restores the snapshot before the panel starts; it used to restart the old release on the migrated database |
| Operator `recover` (`rollback` mode) | the resumed rewind restores the snapshot; `abort-before-transition` cannot follow a migration and refuses a changed schema (`LIFECYCLE_INITIAL_SCHEMA_CHANGED`) |
| Coordinator rotation rollback | the rotation journal is bound to HEAD and the installation receipt; every upgrade rewrites HEAD before it migrates, so a rollback after any upgrade refuses `COORDINATOR_ROTATION_CONTEXT_CHANGED` |

A missing copy refuses `LIFECYCLE_DATABASE_SNAPSHOT_MISSING`, a changed one `LIFECYCLE_DATABASE_SNAPSHOT_CHANGED`. The rollback then ends in `rollback_failed` with the lock retained, and the panel never starts on the migrated database. The receipt check in the engine, the scope binding in the native safety and the restore itself each compare the hash.

`restoreOperationalDatabaseSnapshot` restores in place: one SQLite backup transaction rewrites the pages of the same file, so its device, inode, WAL mode and protected origin stay. Writers are fenced from the snapshot to the end of the rollback, so the only later writes are the lifecycle's own. Values that must never rewind are carried into the restored image first: reference counters, execution epochs, `sqlite_sequence`, and the append-only audit log and reference ledger. A reference issued after the snapshot keeps its ledger row, tombstoned because its job is gone. Upgrade phases and the rolled-back generation's rows return to the snapshot. Restoring returns the process to `pre-migration` reads. Migrations being additive is not a reason to keep the newer database.
