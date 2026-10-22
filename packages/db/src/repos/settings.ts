import { eq } from 'drizzle-orm'
import { fail, validateApacheWorkers, validateDomainName, validateNginxWorkers } from '@xpanel/core'
import type { ApacheMpm, Engine, ServerSettings } from '@xpanel/core'
import type { Db } from '../client.ts'
import { serverSettingsFromRow, serverSettingsToRow } from '../mappers.ts'
import { withPgErrors } from '../pg-errors.ts'
import { serverSettings } from '../schema.ts'
import { assertEmail, assertInt, oneOf } from '../validate.ts'
import { first } from './util.ts'

const ENGINES: readonly Engine[] = ['apache', 'openlitespeed']
const MPMS: readonly ApacheMpm[] = ['itk', 'prefork']
const NAMESERVERS_MAX = 8

const port = (v: unknown, what: string): number => assertInt(v, 1, 65535, what)

/** Workers follow core's nginx/Apache rules; ports must be distinct and off 80/443. */
export const validateServerSettings = (s: ServerSettings): ServerSettings => {
  if (typeof s !== 'object' || s === null) return fail('VALIDATION', 'settings must be an object')
  if (!Array.isArray(s.nameservers) || s.nameservers.length > NAMESERVERS_MAX) fail('VALIDATION', `at most ${NAMESERVERS_MAX} nameservers`)
  const ports = {
    panelPort: port(s.panelPort, 'panelPort'),
    sshPort: port(s.sshPort, 'sshPort'),
    backendPort: port(s.backendPort, 'backendPort'),
    backendTlsPort: port(s.backendTlsPort, 'backendTlsPort'),
  }
  const used = Object.values(ports)
  if (new Set([...used, 80, 443]).size !== used.length + 2) fail('VALIDATION', 'panel, ssh and backend ports must differ from each other and from 80/443')
  const nameservers = s.nameservers.map((x) => validateDomainName(x))
  if (new Set(nameservers).size !== nameservers.length) fail('VALIDATION', 'nameservers must be distinct')
  return {
    hostname: validateDomainName(s.hostname),
    nameservers,
    adminEmail: assertEmail(s.adminEmail, 'adminEmail'),
    engine: oneOf(s.engine, ENGINES, 'engine'),
    apacheMpm: oneOf(s.apacheMpm, MPMS, 'apacheMpm'),
    ...ports,
    nginx: validateNginxWorkers(s.nginx),
    apache: validateApacheWorkers(s.apache),
  }
}

/** null until the first-login wizard has saved the settings. */
export const getServerSettings = async (db: Db): Promise<ServerSettings | null> => {
  const row = first(await db.select().from(serverSettings).where(eq(serverSettings.id, 1)))
  return row ? serverSettingsFromRow(row) : null
}

export const saveServerSettings = (db: Db, s: ServerSettings): Promise<ServerSettings> =>
  withPgErrors(async () => {
    const { id: _id, ...values } = serverSettingsToRow(validateServerSettings(s))
    const [row] = await db
      .insert(serverSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: serverSettings.id, set: values })
      .returning()
    return serverSettingsFromRow(row as typeof serverSettings.$inferSelect)
  })

export const isSetupComplete = async (db: Db): Promise<boolean> => {
  const row = first(await db.select({ at: serverSettings.setupCompletedAt }).from(serverSettings).where(eq(serverSettings.id, 1)))
  return row?.at != null
}

export const markSetupComplete = (db: Db): Promise<void> =>
  withPgErrors(async () => {
    const rows = await db.update(serverSettings).set({ setupCompletedAt: new Date() }).where(eq(serverSettings.id, 1)).returning({ id: serverSettings.id })
    if (rows.length === 0) fail('PRECONDITION_FAILED', 'save the server settings before completing setup')
  })
