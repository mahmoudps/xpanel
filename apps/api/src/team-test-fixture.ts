import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { MIN_ARGON2_MEMORY_KIB, type PhpSettings, type TeamRole } from '@xpanel/core'
import { createDb, createTestDb, createUserPrincipal } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { hashPasswordArgon2id } from './auth.ts'
import type { TeamMember } from './acct-team-workspace.ts'
import { teamFileReader } from './team-session.ts'

// Test-only accounts, owners and team files for the team sign-in tests.
const php: PhpSettings = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
export const OWNER_PASSWORD = 'TeamOwnerFixture!2026'
export const MEMBER_PASSWORD = 'TeamMemberFixture!2026'

interface CachedStateFile { relPath: string; bytes: Buffer }
async function snapshotStateFiles(rootDir: string, mutexFilePath: string, lockDirPath: string): Promise<CachedStateFile[]> {
  const files: CachedStateFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (full === mutexFilePath || full.startsWith(mutexFilePath + '-') || full === lockDirPath || full.startsWith(lockDirPath + sep)) continue
      if (entry.isDirectory()) await walk(full)
      else files.push({ relPath: relative(rootDir, full), bytes: await readFile(full) })
    }
  }
  await walk(rootDir)
  return files
}
async function restoreStateFiles(rootDir: string, files: readonly CachedStateFile[]): Promise<void> {
  const dirs = new Set(files.map(file => dirname(join(rootDir, file.relPath))))
  for (const dir of dirs) await mkdir(dir, { recursive: true, mode: 0o750 })
  await Promise.all(files.map(file => writeFile(join(rootDir, file.relPath), file.bytes, { mode: 0o640 })))
}

let baselinePromise: Promise<{
  sqlite: Uint8Array
  stateFiles: CachedStateFile[]
  ownerHash: string
  memberHash: string
  alice: Awaited<ReturnType<Awaited<ReturnType<typeof createTestStateStore>>['store']['createAccount']>>
  bob: Awaited<ReturnType<Awaited<ReturnType<typeof createTestStateStore>>['store']['createAccount']>>
  aliceOwner: Awaited<ReturnType<typeof createUserPrincipal>>
  bobOwner: Awaited<ReturnType<typeof createUserPrincipal>>
}> | undefined

function getTeamBaseline() {
  if (!baselinePromise) {
    baselinePromise = (async () => {
      const database = await createTestDb()
      const state = await createTestStateStore()
      try {
        // Cheap fixture costs: every sign-in verifies against these parameters.
        const ownerHash = await hashPasswordArgon2id(OWNER_PASSWORD, { memoryKiB: MIN_ARGON2_MEMORY_KIB, timeCost: 1, parallelism: 1 })
        const memberHash = await hashPasswordArgon2id(MEMBER_PASSWORD, { memoryKiB: MIN_ARGON2_MEMORY_KIB, timeCost: 1, parallelism: 1 })
        const featureList = await state.store.createFeatureList({ name: 'Team Feature List', ownerId: null, disabled: [] })
        const plan = await state.store.createPlan({
          name: 'Team Plan', ownerId: null, featureListId: featureList.id,
          resources: { diskMb: 5000, bandwidthMbMonth: 50000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
          caps: { addonDomains: 10, aliasDomains: 10, subdomains: 10, mailboxes: 10, forwarders: 10, mailingLists: 10, ftpAccounts: 10, databases: 10, phpWorkers: 8 },
          dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 250,
        })
        await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
        const account = (username: string, primaryDomain: string) => state.store.createAccount({ username, passwordHash: ownerHash, primaryDomain, planId: plan.id, ownerId: null, contactEmail: `owner@${primaryDomain}`, ipv4: '192.0.2.10', shell: 'jailed', php })
        const alice = await account('alice', 'alice.example.test'), bob = await account('bobby', 'bob.example.test')
        const aliceOwner = await createUserPrincipal(database.db, { username: alice.username, accountId: alice.id, passwordHash: ownerHash })
        const bobOwner = await createUserPrincipal(database.db, { username: bob.username, accountId: bob.id, passwordHash: ownerHash })
        const lock = state.store.getWriterLock()
        const stateFiles = await snapshotStateFiles(state.rootDir, lock.mutexFilePath, lock.lockDirPath)
        return { sqlite: database.sqlite.serialize(), stateFiles, ownerHash, memberHash, alice, bob, aliceOwner, bobOwner }
      } finally {
        await state.close()
        await database.close()
      }
    })()
  }
  return baselinePromise
}

export async function createTeamFixture() {
  const baseline = await getTeamBaseline()
  const database = createDb(':memory:')
  database.sqlite.deserialize(baseline.sqlite)
  const state = await createTestStateStore()
  await restoreStateFiles(state.rootDir, baseline.stateFiles)
  const { memberHash, alice, bob, aliceOwner, bobOwner } = baseline
  const teamPath = (accountId: string) => join(state.store.rootDir, 'extended', 'accounts', 'team', `${accountId}.json`)
  const member = (overrides: Partial<TeamMember> = {}): TeamMember => ({
    id: '77777777-7777-4777-8777-000000000001', username: 'sam', roles: ['email'], contactEmail: 'sam@alice.example.test', notes: '', expiresAt: null, expiryReason: null,
    status: 'active', suspendReason: null, createdAt: '2026-10-27T10:00:00.000Z', createdBy: 'alice', updatedAt: '2026-10-27T10:00:00.000Z', updatedBy: 'alice', ...overrides,
  })
  /** Saves members and gives each the member password directly, as a used password link would. */
  const seed = async (accountId: string, members: TeamMember[], withPassword = true): Promise<void> => {
    await atomicWriteJson(teamPath(accountId), members)
    const now = new Date().toISOString()
    if (withPassword) for (const item of members) await database.db.query(
      `INSERT INTO team_credentials (member_id, account_id, password_hash, password_set_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, $4)
       ON CONFLICT (member_id) DO UPDATE SET password_hash = excluded.password_hash, password_set_at = excluded.password_set_at`, [item.id, accountId, memberHash, now])
  }
  const roles = async (accountId: string, id: string, next: TeamRole[]): Promise<void> => {
    const list = (await teamFileReader(state.store.rootDir)(accountId)) as TeamMember[]
    await atomicWriteJson(teamPath(accountId), list.map(item => item.id === id ? { ...item, roles: next } : item))
  }
  const close = async (): Promise<void> => { await state.close(); await database.close() }
  return { database, state, alice, bob, aliceOwner, bobOwner, member, seed, roles, readTeam: teamFileReader(state.store.rootDir), close }
}
export type TeamFixture = Awaited<ReturnType<typeof createTeamFixture>>
