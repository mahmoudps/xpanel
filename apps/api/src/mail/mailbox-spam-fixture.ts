import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import type { MailboxToolsPorts } from './mailbox-spam-authority.ts'
export const TOOLS_ACCOUNT = '11111111-1111-4111-8111-111111111111', TOOLS_SERVICE = '22222222-2222-4222-8222-222222222222', TOOLS_MAILBOX = 'alice@example.test', TOOLS_LIST = '33333333-3333-4333-8333-333333333333', TOOLS_OTHER = '44444444-4444-4444-8444-444444444444'
export const toolsAuthority = { accountId: TOOLS_ACCOUNT, serviceUserId: TOOLS_SERVICE, mailbox: TOOLS_MAILBOX }
const directories: string[] = []
export async function cleanupMailboxToolsFixtures(): Promise<void> { for (const directory of directories.splice(0)) { if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xpanel-mail-tools-test-')) throw new Error('unsafe_test_cleanup'); await rm(directory, { recursive: true, force: true }) } }
export async function mailboxToolsFixture() {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-mail-tools-test-')); directories.push(root)
  let revoked = false, service = TOOLS_SERVICE, suspended = false
  const lease = { release: vi.fn(async () => {}), assertFencingToken: vi.fn(async () => {}) }, audit = vi.fn(async () => {})
  const ports: MailboxToolsPorts = { open: vi.fn(async () => { if (revoked) throw new Error('revoked'); return { record: { sessionId: 'sealed-session', accountId: TOOLS_ACCOUNT, serviceUserId: TOOLS_SERVICE, mailbox: TOOLS_MAILBOX }, password: 'sealed' } }),
    store: { rootDir: root, getWriterLock: () => ({ acquire: vi.fn(async () => lease) }), getServiceUserByLogin: async () => ({ id: service, accountId: TOOLS_ACCOUNT, login: TOOLS_MAILBOX, services: { email: true } }), getAccount: async () => ({ id: TOOLS_ACCOUNT, status: suspended ? 'suspended' : 'active' }), getDomainByName: async (name: string) => name === 'example.test' ? { id: TOOLS_OTHER, accountId: TOOLS_ACCOUNT, name, suspended: false } : null } as unknown as MailboxToolsPorts['store'], audit, now: () => new Date('2026-10-27T12:00:00.000Z') }
  const path = (...parts: string[]): string => join(root, 'extended', ...parts)
  const write = async (parts: string[], value: unknown): Promise<void> => { const target = path(...parts); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(value)) }
  const read = async (parts: string[]): Promise<unknown> => JSON.parse(await readFile(path(...parts), 'utf8'))
  return { root, ports, lease, audit, path, write, read, revoke: () => { revoked = true }, recreate: () => { service = TOOLS_OTHER }, suspend: () => { suspended = true } }
}
