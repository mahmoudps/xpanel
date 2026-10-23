# Desired-state concurrency

Hosting configuration remains authoritative in JSON entity files. The control database has separate identity, security and operational authority. A successful state revision does not prove that a host service has applied that revision.

## Writer exclusion

All desired-state writers and orphan recovery use a dedicated local SQLite guard, `.writer-mutex.sqlite`, under the state root. A separate connection holds `BEGIN IMMEDIATE` for the complete writer or recovery scope. Contention uses a zero SQLite busy timeout and bounded asynchronous retries. The guard contains no hosting entities and is not the control database.

The guard file is permanent. Never unlink, rename, restore over, hash or copy it while writers may run. Raw file access can interfere with POSIX locking; see [SQLite's locking cautions](https://www.sqlite.org/howtocorrupt.html). Exclude these operational files before opening them in any state walker:

```text
.writer-mutex.sqlite
.writer-mutex.sqlite-journal
.writer-mutex.sqlite-wal
.writer-mutex.sqlite-shm
```

Use a trusted local state directory and a filesystem with working SQLite locks. Network filesystems are not qualified by the portable test suite. API and agent processes need the configured shared writer permissions; unrelated users must not be able to replace the guard or its parent directory.

`.lock/owner.json` records provenance for the guarded scope. A live or ambiguous legacy owner requires a stopped-writer upgrade. Neither ordinary acquisition nor explicit recovery can displace a process that still holds the kernel guard.

First creation uses a separate `.writer-mutex.sqlite-init` directory. An abandoned initializer fails closed and requires stopped-writer inspection; runtime code does not silently repair an arbitrary existing mutex file. Shared metadata assumes the configured services use `UMask=0007`. Native root-to-API recovery, restrictive CLI umasks and ownership of restored directories still require qualification, including a subsequent API mutation after a root-run restore.

## Authority and recovery

An acquired writer persists a strictly greater fencing token before canonical effects. Aborting does not rewind that token. A lease is explicit in canonical write helpers and becomes unusable when release begins. Public operations cannot borrow another request's lease.

Journals identify their lease and base revision. Recovery validates the complete journal, confined paths and preimages before performing rollback. A failed validation or rollback preserves the evidence and fails closed. Allocated UIDs remain burned across abort and recovery. Complete preimage journals currently cover account creation, hostname changes and generation restore. Other ordinary mutations still need crash-atomic transaction journals; exclusion alone does not make an interrupted write a committed revision.

Authority records include `committedLeaseId`. Every commit writes that identity, including operations that do not increment the business revision. Recovery uses this persisted identity to distinguish a completed commit from an interrupted operation; an unchanged revision alone is insufficient.

Generation restore records its stage, backup and planned canonical entries before the first swap. It retains recovery evidence until commitment and cleanup are proved. Interrupted recovery must preserve the union of burned UID allocations, including when the live allocator has already moved to the backup tree.

## Coherent reads

Full snapshots read authority at a guarded barrier before and after scanning the entity tree. A snapshot is returned only if both revision and fencing token remain unchanged. Unstable reads, including transient validation errors, are retried. A stable validation or I/O error remains an error.

After bounded optimistic attempts, the reader holds a real writer lease while scanning. There is no unchecked fallback. Account workspace reads remain bounded to the requested account and its dependencies. Reentrant public reads or mutations fail explicitly rather than inheriting write authority.

## Deployment and qualification limits

Stop all old API, agent and other state writers before changing writer protocols. Do not mix binaries that use only the historical directory lock with guard-aware binaries. Keep the permanent guard inode outside generation swaps and backup restoration.

The existing raw state-tar upgrade adapter still requires guard filtering and consistent backup qualification before live integration. State journals do not restore a principal or security record created in another store. Cross-store lifecycle recovery, derived-index coordination, native Linux interruption tests and power-loss durability remain separate acceptance work.

The runtime already uses [Node's SQLite binding](https://nodejs.org/api/sqlite.html); its API maturity remains a release-candidate dependency risk. Portable process-crash tests do not establish Linux service qualification or production readiness. See [TESTING.md](TESTING.md) for environment boundaries.
