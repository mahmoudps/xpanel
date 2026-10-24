# Database transactions and operational authority

Use the registered runner returned by `createDb` from `@xpanel/db`. The raw
SQLite connection is not an operational repository or authority interface.
Before accepting work, explicitly run `await migrate(handle.runner)` followed
by `await initializeOperationalMetadata(handle.db)`. Initialization is a startup
write; reads must not create tables, initialize metadata, or allocate references.

## Ordinary transactions

Pass the callback's transaction runner to every repository operation belonging
to that transaction, and await those operations before returning:

```ts
await handle.db.transaction(async tx => {
  await repositoryOperation(tx)
})
```

Here `repositoryOperation` represents an application repository accepting a
`SqlRunner`; it is not a separate exported helper. Public access to the same
database owner from inside the callback is rejected rather than queued behind
itself. Nested transactions are unsupported. A transaction runner expires when
its callback ends and cannot be retained for later work. Exceptions roll back
the transaction; callers must not report success after a rejected operation.

Independent ordinary database work remains allowed inside an ordinary
transaction on another database. This does not make two independent databases
one atomic transaction. Ordinary test databases may be in memory; generic jobs
and permanent reference allocation do not require a strict connection.

## Strict operational transactions

Privileged operation acknowledgments and audited reference repair require a
genuine, active transaction from a registered strict connection. Construct it
with `createDb(path, { durability: 'strict' })`; strict mode requires a real file,
WAL, `synchronous = FULL`, and foreign keys. The implementation checks physical
file identity, rejects unsafe hardlink aliases, and verifies the initialized
issuer and reviewed migration checksums. A structurally similar object, raw
driver, copied receipt, or transaction from another connection is not authority.

While a strict transaction is active, public calls, nested transactions and
connection closure through another database are also rejected. Keep unrelated
work outside this scope and use only its supplied transaction runner. The
operation-specific binding must match the persisted intent, actor and purpose;
strict durability alone does not authorize a host operation.

## References and recovery

Public job references such as `XP-JOB-2026-000001` come from the persisted
server-side reference ledger. Read paths reuse that value without allocating.
Pruning a job must not make its reference reusable. Preserve existing official
references; legacy metadata repair is explicit, audited and idempotent.

Keep the identity database, its consistent WAL/snapshot, desired state and
operation evidence together during recovery. A successful SQL transaction or
portable test does not establish host-side completion, filesystem durability
after power loss, or native service qualification. Preserve uncertain operation
and recovery records until the corresponding authority checks resolve them.

The executable contracts are in `packages/db/src/sql-runner.ts`,
`client.ts`, and the operational repositories under `packages/db/src/repos/`.
