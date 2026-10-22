import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { AuditEntry, HostAction, Principal } from '@xpanel/core'
import { parseOsRelease } from '@xpanel/os'
import type { OsRelease } from '@xpanel/os'
import type { AuditPort, ClockPort, ExecResult, FsPort, HostPort } from '../ports.ts'

// In-memory fakes for unit tests. Not exported from the package entry point.

type FakeNode =
  | { type: 'file'; content: string; mode: number }
  | { type: 'dir'; mode: number }
  | { type: 'symlink'; target: string }

const err = (code: string, msg: string): Error => Object.assign(new Error(`${code}: ${msg}`), { code })

export class FakeFs implements FsPort {
  nodes = new Map<string, FakeNode>()
  /** every path a mutating call touched, in order */
  writes: string[] = []
  /** throw from a mutating call when the predicate matches */
  failWhen: ((op: string, path: string) => boolean) | null = null

  constructor(seed: Record<string, FakeNode> = {}) {
    this.nodes.set('/', { type: 'dir', mode: 0o755 })
    for (const [p, n] of Object.entries(seed)) {
      this.ensureParents(p)
      this.nodes.set(p, n)
    }
  }

  private ensureParents(p: string): void {
    let d = posix.dirname(p)
    const missing: string[] = []
    while (!this.nodes.has(d)) { missing.push(d); d = posix.dirname(d) }
    for (const m of missing) this.nodes.set(m, { type: 'dir', mode: 0o755 })
  }

  private touch(op: string, p: string): void {
    this.writes.push(p)
    if (this.failWhen?.(op, p)) throw err('EIO', `${op} ${p} failed (injected)`)
  }

  private requireParent(p: string): void {
    const parent = this.nodes.get(posix.dirname(p))
    if (!parent || parent.type !== 'dir') throw err('ENOENT', `parent of ${p}`)
  }

  file(path: string, content: string, mode = 0o644): void {
    this.ensureParents(path)
    this.nodes.set(path, { type: 'file', content, mode })
  }

  async exists(p: string): Promise<boolean> { return this.nodes.has(p) }

  async readlink(p: string): Promise<string | null> {
    const n = this.nodes.get(p)
    return n?.type === 'symlink' ? n.target : null
  }

  async readFile(p: string): Promise<string | null> {
    const n = this.nodes.get(p)
    return n?.type === 'file' ? n.content : null
  }

  async sha256(p: string): Promise<string> {
    const n = this.nodes.get(p)
    if (n?.type !== 'file') throw err('ENOENT', p)
    return createHash('sha256').update(n.content).digest('hex')
  }

  async symlink(target: string, p: string): Promise<void> {
    this.touch('symlink', p)
    this.requireParent(p)
    if (this.nodes.has(p)) throw err('EEXIST', p)
    this.nodes.set(p, { type: 'symlink', target })
  }

  async rename(from: string, to: string): Promise<void> {
    this.touch('rename', from)
    this.touch('rename', to)
    const n = this.nodes.get(from)
    if (!n) throw err('ENOENT', from)
    this.requireParent(to)
    const dest = this.nodes.get(to)
    if (dest?.type === 'dir' && this.children(to).length > 0) throw err('ENOTEMPTY', to)
    const moved = [from, ...this.children(from)]
    const entries = moved.map((m) => [m, this.nodes.get(m) as FakeNode] as const)
    for (const [m] of entries) this.nodes.delete(m)
    for (const [m, node] of entries) this.nodes.set(to + m.slice(from.length), node)
  }

  async mkdirp(p: string, mode: number): Promise<void> {
    this.touch('mkdirp', p)
    const existing = this.nodes.get(p)
    if (existing && existing.type !== 'dir') throw err('EEXIST', p)
    this.ensureParents(p)
    if (!existing) this.nodes.set(p, { type: 'dir', mode })
  }

  async writeFileExclusive(p: string, content: string, mode: number): Promise<void> {
    this.touch('write', p)
    if (this.nodes.has(p)) throw err('EEXIST', p)
    this.requireParent(p)
    this.nodes.set(p, { type: 'file', content, mode })
  }

  async remove(p: string): Promise<void> {
    this.touch('remove', p)
    for (const c of this.children(p)) this.nodes.delete(c)
    this.nodes.delete(p)
  }

  children(p: string): string[] {
    const prefix = p === '/' ? '/' : `${p}/`
    return [...this.nodes.keys()].filter((k) => k !== p && k.startsWith(prefix))
  }
}

type HostHandler = (action: HostAction) => ExecResult | undefined | Promise<ExecResult | undefined>

export class FakeHost implements HostPort {
  actions: HostAction[] = []
  handler: HostHandler | null = null

  async apply(action: HostAction): Promise<ExecResult> {
    this.actions.push(action)
    const r = this.handler ? await this.handler(action) : undefined
    return r ?? { code: 0, stdout: '', stderr: '' }
  }

  systemd(): { verb: string; unit: string }[] {
    return this.actions.flatMap((a) => (a.kind === 'systemd' ? [{ verb: a.verb, unit: a.unit }] : []))
  }

  argv0(): string[] {
    return this.actions.flatMap((a) => (a.kind === 'exec' ? [a.argv[0] ?? ''] : []))
  }
}

export class FakeClock implements ClockPort {
  t: number
  sleeps: number[] = []
  constructor(iso = '2026-10-22T01:35:00.000Z') { this.t = Date.parse(iso) }
  now(): Date { return new Date(this.t) }
  async sleep(ms: number): Promise<void> { this.sleeps.push(ms); this.t += ms }
}

export class MemoryAudit implements AuditPort {
  entries: AuditEntry[] = []
  async record(entry: AuditEntry): Promise<void> { this.entries.push(entry) }
  actions(): string[] { return this.entries.map((e) => e.action) }
}

/** A promise you resolve from the outside; used to hold a flow mid-step. */
export const gate = (): { promise: Promise<void>; open: () => void } => {
  let open = (): void => {}
  const promise = new Promise<void>((r) => { open = r })
  return { promise, open }
}

export const ROOT: Principal = { kind: 'root', id: 'p-root', username: 'root' }
export const RESELLER: Principal = { kind: 'reseller', id: 'p-res', username: 'resel' }

export const osRelease = (id: string, versionId: string, extra = ''): OsRelease =>
  parseOsRelease(`ID=${id}\nVERSION_ID="${versionId}"\n${extra}`)
