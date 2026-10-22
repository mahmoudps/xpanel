import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { assertNoSecrets, buildReview, countActiveTransfers, createTransferSession, detectConflicts, itemPercent, itemStatus, parseTransferAuth, reviewDigest, transferStatus, transition } from './session.ts'
import type { LocalInventory, SourceAccount, TransferEvent, TransferSession } from './session.ts'

const FP = `SHA256:${'A'.repeat(43)}`
const T0 = '2026-10-22T01:35:00.000Z'
const SSH = { kind: 'ssh-key', host: 'old.example.net', port: 22, user: 'root', keyId: 'transfer-key-1', hostKeyFingerprint: FP }

const alice: SourceAccount = { username: 'alice', uid: 1001, primaryDomain: 'alice.example', domains: ['alice.example', 'shop.example', 'blog.alice.example'], plan: 'gold', diskBytes: 5_000_000, databases: ['alice_wp'], mailboxes: 3, phpVersions: ['8.3', '5.6'] }
const bob: SourceAccount = { username: 'bob', uid: 1002, primaryDomain: 'bob.example', domains: ['bob.example'], plan: 'silver', diskBytes: 1_000, databases: [], mailboxes: 0, phpVersions: ['8.2'] }
const admin: SourceAccount = { username: 'admin', uid: 1003, primaryDomain: 'admin.example', domains: ['admin.example'], plan: 'gold', diskBytes: 10, databases: ['admin_x'], mailboxes: 0, phpVersions: [] }

const local: LocalInventory = { usernames: ['bob'], domains: ['shop.example', 'carol.example'], uids: [1001, 1004], plans: ['gold'] }

const run = (events: TransferEvent[], s: TransferSession = createTransferSession({ id: 'tr-1', actor: 'root:root', now: T0, auth: SSH })): TransferSession =>
  events.reduce((acc, e) => transition(acc, e, T0), s)

const inventoried = (): TransferSession => run([
  { type: 'connected', source: { hostname: 'old.example.net', version: '1.4.2' } },
  { type: 'inventory', accounts: [alice, bob, admin], plans: [{ name: 'gold' }, { name: 'silver' }] },
])

const selected = (): TransferSession => transition(inventoried(), { type: 'select', accounts: ['alice', 'bob'], plans: ['silver'], local }, T0)

const resolvedAll = (): TransferSession => run([
  { type: 'resolve', conflictId: 'username:bob', resolution: { action: 'rename', to: 'bob2' } },
  { type: 'resolve', conflictId: 'domain:alice:shop.example', resolution: { action: 'drop-domain' } },
], selected())

describe('transfer auth', () => {
  it('accepts an ssh key or an api token by reference only', () => {
    expect(parseTransferAuth(SSH)).toEqual(SSH)
    expect(parseTransferAuth({ kind: 'api-token', url: 'https://old.example.net:2087/api/', tokenId: 'tok-1', tlsFingerprint: null })).toEqual({ kind: 'api-token', url: 'https://old.example.net:2087/api', tokenId: 'tok-1', tlsFingerprint: null })
  })

  it('never keeps a source password or raw secret', () => {
    expect(() => parseTransferAuth({ ...SSH, password: 'hunter2' })).toThrow(/looks like a secret/)
    expect(() => parseTransferAuth({ kind: 'api-token', url: 'https://h.example', tokenId: 'x', tlsFingerprint: null, token: 'abc' })).toThrow(/looks like a secret/)
    expect(() => parseTransferAuth({ ...SSH, extra: { privateKey: '-----BEGIN' } })).toThrow(/looks like a secret/)
    expect(() => assertNoSecrets({ a: { b: { passphrase: 'x' } } })).toThrow(XpanelError)
    expect(() => parseTransferAuth({ kind: 'password', host: 'h.example', password: 'x' })).toThrow(XpanelError)
  })

  it('rejects unpinned hosts, credentials in urls and hostile values', () => {
    for (const bad of [
      { ...SSH, hostKeyFingerprint: undefined },
      { ...SSH, hostKeyFingerprint: 'MD5:aa' },
      { ...SSH, host: 'old.example.net;id' },
      { ...SSH, host: '-oProxyCommand=sh' },
      { ...SSH, port: 0 },
      { ...SSH, port: 70000 },
      { ...SSH, user: 'admin' },
      { ...SSH, keyId: '../id_rsa' },
      { ...SSH, extra: 1 },
      { kind: 'api-token', url: 'http://h.example', tokenId: 'x', tlsFingerprint: null },
      { kind: 'api-token', url: 'https://u:p@h.example', tokenId: 'x', tlsFingerprint: null },
      { kind: 'api-token', url: 'https://h.example/?q=1', tokenId: 'x', tlsFingerprint: null },
      { kind: 'api-token', url: 'https://h.example', tokenId: 'x', tlsFingerprint: 'zz' },
      { kind: 'api-token', url: 'not a url', tokenId: 'x', tlsFingerprint: null },
      null,
    ]) expect(() => parseTransferAuth(bad), JSON.stringify(bad)).toThrow(XpanelError)
  })

  it('validates the session identity', () => {
    expect(() => createTransferSession({ id: '../x', actor: 'root', now: T0, auth: SSH })).toThrow(XpanelError)
    expect(() => createTransferSession({ id: 'tr', actor: 'root\nforged', now: T0, auth: SSH })).toThrow(XpanelError)
  })
})

describe('transfer session', () => {
  it('walks connect, inventory, select, resolve, review, confirm, progress and complete', () => {
    let s = resolvedAll()
    s = transition(s, { type: 'review' }, T0)
    expect(s.state).toBe('reviewed')
    const review = buildReview(s)
    expect(review).toEqual({
      source: { hostname: 'old.example.net', version: '1.4.2' },
      accounts: [
        { source: 'alice', target: 'alice', plan: 'gold', domains: ['alice.example', 'blog.alice.example'], droppedDomains: ['shop.example'], databases: ['alice_wp'], mailboxes: 3, diskBytes: 5_000_000, uid: 'new', phpFallback: ['5.6'] },
        { source: 'bob', target: 'bob2', plan: 'silver', domains: ['bob.example'], droppedDomains: [], databases: [], mailboxes: 0, diskBytes: 1_000, uid: 'new', phpFallback: [] },
      ],
      skipped: [],
      plans: [{ source: 'silver', action: 'create', target: 'silver' }],
      sharedServices: 'reload-only',
    })
    s = transition(s, { type: 'confirm', digest: s.reviewDigest as string }, T0)
    expect(s.state).toBe('applying')
    expect(transferStatus(s)).toBe('running')
    expect(s.progress.bob).toEqual({ targetUsername: 'bob2', phase: 'pending', bytes: 0, totalBytes: 1000, error: null })
    for (const phase of ['exporting', 'copying', 'importing', 'reconciling', 'done'] as const) s = transition(s, { type: 'progress', account: 'alice', phase, bytes: phase === 'copying' ? 2_500_000 : undefined }, T0)
    s = transition(s, { type: 'progress', account: 'bob', phase: 'failed', error: 'disk full on target' }, T0)
    expect(s.progress.bob).toMatchObject({ phase: 'failed', error: 'disk full on target' })
    s = transition(s, { type: 'complete' }, T0)
    expect(s.state).toBe('completed')
    expect(transferStatus(s)).toBe('succeeded')
    expect(s.log.map((l) => l.event)).toEqual(['connected', 'inventory', 'select', 'resolve', 'resolve', 'review', 'confirm', 'progress', 'progress', 'progress', 'progress', 'progress', 'progress', 'complete'])
  })

  it('detects username, uid, domain and plan conflicts with their choices', () => {
    const s = selected()
    expect(s.conflicts.map((c) => [c.id, c.choices])).toEqual([
      ['uid:alice', ['new-uid', 'skip']],
      ['domain:alice:shop.example', ['drop-domain', 'skip']],
      ['username:bob', ['rename', 'skip']],
    ])
    expect(s.resolutions).toEqual({ 'uid:alice': { action: 'new-uid' } })
    expect(transferStatus(s)).toBe('review')
  })

  it('flags names above or below a domain that another account owns here, and reserved names', () => {
    const c = detectConflicts([{ ...bob, domains: ['bob.example', 'x.carol.example'] }, admin], [], { usernames: [], domains: ['carol.example', 'example.bob.example'], uids: [], plans: ['gold', 'silver'] })
    expect(c.map((x) => x.id)).toEqual(['domain:bob:bob.example', 'domain:bob:x.carol.example', 'username:admin'])
    expect(c[0]?.detail).toMatch(/overlaps/)
    expect(c[2]).toMatchObject({ detail: 'this name is reserved here', choices: ['rename', 'skip'] })
    expect(c[0]?.choices).toEqual(['skip'])
  })

  it('flags plans missing here and plan name collisions', () => {
    const c = detectConflicts([bob], ['gold'], { usernames: [], domains: [], uids: [], plans: ['gold'] })
    expect(c.map((x) => [x.id, x.choices])).toEqual([['plan-missing:bob', ['map-plan', 'skip']], ['plan:gold', ['map-plan', 'rename', 'skip']]])
  })

  it('refuses review while conflicts are open and confirm with a stale digest', () => {
    expect(() => transition(selected(), { type: 'review' }, T0)).toThrow(/unresolved conflicts: domain:alice:shop.example, username:bob/)
    const reviewed = transition(resolvedAll(), { type: 'review' }, T0)
    expect(() => transition(reviewed, { type: 'confirm', digest: '0'.repeat(64) }, T0)).toThrow(/review again/)
    const changed = transition(reviewed, { type: 'resolve', conflictId: 'username:bob', resolution: { action: 'skip' } }, T0)
    expect(changed.state).toBe('selected')
    expect(changed.reviewDigest).toBeNull()
    expect(() => transition(changed, { type: 'confirm', digest: reviewed.reviewDigest as string }, T0)).toThrow(XpanelError)
  })

  it('skipping a conflict skips the account; skipping a plan skips its accounts', () => {
    let s = run([
      { type: 'resolve', conflictId: 'username:bob', resolution: { action: 'skip' } },
      { type: 'resolve', conflictId: 'domain:alice:shop.example', resolution: { action: 'drop-domain' } },
      { type: 'review' },
    ], selected())
    expect(buildReview(s).skipped).toEqual(['bob'])
    s = transition(s, { type: 'confirm', digest: s.reviewDigest as string }, T0)
    expect(s.progress.bob?.phase).toBe('skipped')
    expect(itemStatus(s.progress.bob as never)).toBe('skipped')

    const p = transition(inventoried(), { type: 'select', accounts: ['bob'], plans: ['silver'], local: { ...local, usernames: [], plans: ['silver'] } }, T0)
    const q = transition(p, { type: 'resolve', conflictId: 'plan:silver', resolution: { action: 'skip' } }, T0)
    expect(() => transition(q, { type: 'review' }, T0)).toThrow(/nothing left to transfer/)
  })

  it('validates resolutions', () => {
    const s = selected()
    const bad: [string, unknown][] = [
      ['username:bob', { action: 'rename', to: 'root' }],
      ['username:bob', { action: 'rename', to: 'bob' }],
      ['username:bob', { action: 'rename', to: 'alice' }],
      ['username:bob', { action: 'rename', to: 'Bob2' }],
      ['username:bob', { action: 'drop-domain' }],
      ['username:bob', { action: 'rename', to: 'bob3', extra: 1 }],
      ['domain:alice:shop.example', { action: 'rename', to: 'x' }],
      ['nope', { action: 'skip' }],
    ]
    for (const [id, r] of bad) expect(() => transition(s, { type: 'resolve', conflictId: id, resolution: r as never }, T0), `${id} ${JSON.stringify(r)}`).toThrow(XpanelError)
    const p = transition(inventoried(), { type: 'select', accounts: ['bob'], plans: ['gold'], local }, T0)
    expect(() => transition(p, { type: 'resolve', conflictId: 'plan:gold', resolution: { action: 'map-plan', to: 'platinum' } }, T0)).toThrow(/does not exist/)
    expect(() => transition(p, { type: 'resolve', conflictId: 'plan:gold', resolution: { action: 'rename', to: 'gold' } }, T0)).toThrow(/already exists/)
    const renamed = transition(p, { type: 'resolve', conflictId: 'plan:gold', resolution: { action: 'rename', to: 'gold-imported' } }, T0)
    expect(renamed.resolutions['plan:gold']).toEqual({ action: 'rename', to: 'gold-imported' })
  })

  it('keeps valid resolutions when the selection changes and drops stale ones', () => {
    const s = transition(resolvedAll(), { type: 'select', accounts: ['bob'], plans: [], local }, T0)
    expect(s.resolutions).toEqual({ 'username:bob': { action: 'rename', to: 'bob2' } })
    expect(s.conflicts.map((c) => c.id)).toEqual(['username:bob', 'plan-missing:bob'])
  })

  it('re-checks kept choices against a new selection, so two accounts never share a target name', () => {
    const carol: SourceAccount = { ...bob, username: 'carol', uid: 1005, primaryDomain: 'carol.example', domains: ['carol.example'], plan: 'gold' }
    let s = run([
      { type: 'connected', source: { hostname: 'old.example.net', version: '1.4.2' } },
      { type: 'inventory', accounts: [alice, bob, carol], plans: [{ name: 'gold' }, { name: 'silver' }] },
      { type: 'select', accounts: ['bob'], plans: ['silver'], local },
      { type: 'resolve', conflictId: 'username:bob', resolution: { action: 'rename', to: 'carol' } },
    ])
    expect(s.resolutions['username:bob']).toEqual({ action: 'rename', to: 'carol' })
    s = transition(s, { type: 'select', accounts: ['bob', 'carol'], plans: ['silver'], local: { ...local, domains: [] } }, T0)
    expect(s.resolutions['username:bob']).toBeUndefined()
    expect(() => transition(s, { type: 'review' }, T0)).toThrow(/unresolved conflicts: username:bob/)
  })

  it('a missing plan mapped onto a name keeps the plan called that here, even when a source plan of that name is renamed', () => {
    const lone: LocalInventory = { usernames: [], domains: [], uids: [], plans: ['silver'] }
    let s = transition(inventoried(), { type: 'select', accounts: ['alice'], plans: ['silver'], local: lone }, T0)
    expect(s.conflicts.map((c) => c.id)).toEqual(['plan-missing:alice', 'plan:silver'])
    s = run([
      { type: 'resolve', conflictId: 'plan:silver', resolution: { action: 'rename', to: 'silver-old' } },
      { type: 'resolve', conflictId: 'plan-missing:alice', resolution: { action: 'map-plan', to: 'silver' } },
      { type: 'review' },
    ], s)
    const review = buildReview(s)
    expect(review.plans).toEqual([{ source: 'silver', action: 'rename', target: 'silver-old' }])
    expect(review.accounts[0]?.plan).toBe('silver')
  })

  it('refuses a review whose accounts would land on a plan that is not there', () => {
    let s = transition(inventoried(), { type: 'select', accounts: ['alice'], plans: ['silver'], local: { usernames: [], domains: [], uids: [], plans: [] } }, T0)
    s = run([
      { type: 'resolve', conflictId: 'plan-missing:alice', resolution: { action: 'map-plan', to: 'silver' } },
    ], s)
    // the mapped-to plan is then dropped from the selection: the stale choice is asked again
    s = transition(s, { type: 'select', accounts: ['alice', 'bob'], plans: [], local: { usernames: [], domains: [], uids: [], plans: [] } }, T0)
    expect(s.resolutions['plan-missing:alice']).toBeUndefined()
    expect(() => transition(s, { type: 'review' }, T0)).toThrow(/unresolved conflicts/)
  })

  it('re-checks a stored session on review: target names stay unique, free and valid', () => {
    const stored = structuredClone(resolvedAll())
    stored.resolutions['username:bob'] = { action: 'rename', to: 'alice' }
    expect(() => transition(stored, { type: 'review' }, T0)).toThrow(/two accounts would be named alice/)
    stored.resolutions['username:bob'] = { action: 'rename', to: 'root' }
    expect(() => transition(stored, { type: 'review' }, T0)).toThrow(/root is not a valid account name here/)
    stored.resolutions['username:bob'] = { action: 'rename', to: 'bob' }
    expect(() => transition(stored, { type: 'review' }, T0)).toThrow(/account bob already exists here/)
  })

  it('validates timestamps and the local inventory', () => {
    expect(() => createTransferSession({ id: 'tr-5', actor: 'root:root', now: 'yesterday', auth: SSH })).toThrow(/RFC 3339/)
    expect(() => transition(inventoried(), { type: 'review' }, 'now')).toThrow(XpanelError)
    expect(() => transition(inventoried(), { type: 'select', accounts: ['bob'], plans: [], local: { ...local, uids: ['1001' as never] } }, T0)).toThrow(/local inventory/)
    expect(() => transition(inventoried(), { type: 'select', accounts: ['bob'], plans: [], local: { ...local, usernames: [7 as never] } }, T0)).toThrow(/local inventory/)
  })

  it('refuses events out of order and after the end', () => {
    const fresh = createTransferSession({ id: 'tr-2', actor: 'root:root', now: T0, auth: SSH })
    expect(() => transition(fresh, { type: 'review' }, T0)).toThrow(/cannot review/)
    expect(() => transition(fresh, { type: 'inventory', accounts: [], plans: [] }, T0)).toThrow(XpanelError)
    const applying = transition(transition(resolvedAll(), { type: 'review' }, T0), { type: 'confirm', digest: transition(resolvedAll(), { type: 'review' }, T0).reviewDigest as string }, T0)
    expect(() => transition(applying, { type: 'complete' }, T0)).toThrow(/still running/)
    expect(() => transition(applying, { type: 'progress', account: 'alice', phase: 'importing' }, T0)).not.toThrow()
    expect(() => transition(applying, { type: 'progress', account: 'alice', phase: 'pending' }, T0)).toThrow(/cannot go from/)
    expect(() => transition(applying, { type: 'progress', account: 'carol', phase: 'exporting' }, T0)).toThrow(XpanelError)
    expect(() => transition(applying, { type: 'progress', account: 'alice', phase: 'copying', bytes: -1 }, T0)).toThrow(XpanelError)
    const cancelled = transition(applying, { type: 'cancel' }, T0)
    expect(cancelled.state).toBe('cancelled')
    expect(Object.values(cancelled.progress).map((p) => p.phase)).toEqual(['skipped', 'skipped'])
    expect(() => transition(cancelled, { type: 'fail', reason: 'x' }, T0)).toThrow(XpanelError)
    expect(() => transition(cancelled, { type: 'unknown' } as never, T0)).toThrow(XpanelError)
  })

  it('a fail event ends the session with the reason', () => {
    const s = transition(selected(), { type: 'fail', reason: 'source unreachable' }, T0)
    expect(s).toMatchObject({ state: 'failed', error: 'source unreachable' })
    expect(transferStatus(s)).toBe('failed')
  })

  it('validates the inventory and source identity', () => {
    const connected = run([{ type: 'connected', source: { hostname: 'old.example.net', version: '1.4.2' } }])
    const inv = (accounts: SourceAccount[]) => () => transition(connected, { type: 'inventory', accounts, plans: [] }, T0)
    expect(inv([{ ...alice, username: 'Alice' }])).toThrow(XpanelError)
    expect(inv([{ ...alice, primaryDomain: 'nope' }])).toThrow(XpanelError)
    expect(inv([{ ...alice, domains: ['shop.example'] }])).toThrow(XpanelError)
    expect(inv([{ ...alice, databases: ['bob_wp'] }])).toThrow(XpanelError)
    expect(inv([{ ...alice, databases: ['alice_wp; drop'] }])).toThrow(XpanelError)
    expect(inv([{ ...alice, plan: '../gold' }])).toThrow(XpanelError)
    expect(inv([{ ...alice, uid: -1 }])).toThrow(XpanelError)
    expect(inv([{ ...alice, phpVersions: ['8.3;id'] }])).toThrow(XpanelError)
    expect(inv([alice, alice])).toThrow(/duplicate/)
    expect(inv([alice, { ...bob, domains: ['bob.example', 'shop.example'] }])).toThrow(/both alice and bob/)
    expect(inv([admin])).not.toThrow()
    const created = createTransferSession({ id: 'tr-3', actor: 'root:root', now: T0, auth: SSH })
    expect(() => transition(created, { type: 'connected', source: { hostname: 'x;y', version: '1.0.0' } }, T0)).toThrow(XpanelError)
    expect(() => transition(created, { type: 'connected', source: { hostname: 'old.example.net', version: 'latest' } }, T0)).toThrow(XpanelError)
  })

  it('reports progress for the transfer_items table', () => {
    const p = { targetUsername: 'a', phase: 'copying' as const, bytes: 50, totalBytes: 100, error: null }
    expect(itemPercent(p)).toBe(50)
    expect(itemPercent({ ...p, phase: 'pending' })).toBe(0)
    expect(itemPercent({ ...p, phase: 'done' })).toBe(100)
    expect(itemPercent({ ...p, phase: 'reconciling' })).toBe(80)
    expect(itemPercent({ ...p, bytes: 100 })).toBe(99)
    expect(itemStatus(p)).toBe('running')
    expect(itemStatus({ ...p, phase: 'done' })).toBe('succeeded')
  })

  it('counts active sessions for the upgrade preflight', () => {
    const created = createTransferSession({ id: 'tr-4', actor: 'root:root', now: T0, auth: SSH })
    expect(countActiveTransfers([created, selected(), transition(selected(), { type: 'cancel' }, T0)])).toBe(1)
  })

  it('digests are stable for the same review', () => {
    const a = transition(resolvedAll(), { type: 'review' }, T0)
    expect(reviewDigest(buildReview(a))).toBe(a.reviewDigest)
    expect(a.reviewDigest).toMatch(/^[0-9a-f]{64}$/)
  })
})
