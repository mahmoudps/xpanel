import { assertEmail, fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from '../auth.ts'
import type { ExtendedRouteHelpers } from '../extended-routes.ts'
import { authorizeAccountOwner } from '../account-ssh-workspace.ts'
import {
  DEVICE_SETUP_FILES, MAIL_CLIENT_ENDPOINTS, buildDeviceSetupView, dispatchDeviceSetupInstructions,
  normalizeDeviceSetupHostname, renderAppleMailProfile, renderMailAutoconfig,
} from './device-setup.ts'
import { mailboxJson, methodNotAllowed } from './folder-admin.ts'

export const ACCOUNT_CONNECT_DEVICES_PATH = '/api/account/email/connect-devices'
export const ACCOUNT_CONNECT_DEVICES_AUTOCONFIG_PATH = '/api/account/email/connect-devices/autoconfig.xml'
export const ACCOUNT_CONNECT_DEVICES_APPLE_PATH = '/api/account/email/connect-devices/apple.mobileconfig'
export const ACCOUNT_CONNECT_DEVICES_SEND_PATH = '/api/account/email/connect-devices/send-instructions'

export interface AccountConnectDevicesPorts {
  store: StateStore
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  readHostname: () => Promise<unknown>
  sendEmail: (message: { to: string[]; subject: string; text: string }) => Promise<void>
  emitAudit?: ExtendedRouteHelpers['emitAudit']
  now?: () => number
}

const unchanged = { stateChanged: false } as const
const TOOLS = ['email-accounts', 'connect-devices'] as const

const readMailboxQuery = (url: URL): string | null => {
  for (const key of url.searchParams.keys()) {
    if (key !== 'mailbox' || url.searchParams.getAll('mailbox').length !== 1) {
      return fail('VALIDATION', 'connect devices accepts only an optional mailbox selector', unchanged)
    }
  }
  const value = url.searchParams.get('mailbox')
  if (value === null) return null
  return assertEmail(value, 'mailbox')
}

async function resolveOwnedMailboxes(store: StateStore, accountId: string): Promise<string[]> {
  return (await store.listServiceUsers(accountId))
    .filter(user => user.accountId === accountId && user.services.email)
    .map(user => user.login.trim().toLowerCase())
    .sort((left, right) => left.localeCompare(right))
}

function buildAccountDownloads(mailbox: string, hostname: string | null) {
  if (!hostname) return []
  const query = '?mailbox=' + encodeURIComponent(mailbox)
  return [
    { kind: 'autoconfig' as const, path: ACCOUNT_CONNECT_DEVICES_AUTOCONFIG_PATH + query, ...DEVICE_SETUP_FILES.autoconfig },
    { kind: 'apple' as const, path: ACCOUNT_CONNECT_DEVICES_APPLE_PATH + query, ...DEVICE_SETUP_FILES.apple },
  ]
}

/**
 * Account-owner bridge for mail client setup across any owned email-enabled mailbox:
 * GET /api/account/email/connect-devices, /autoconfig.xml, /apple.mobileconfig, and POST /send-instructions.
 */
export async function handleAccountConnectDevicesRoute(
  request: Request,
  url: URL,
  method: string,
  ports: AccountConnectDevicesPorts,
): Promise<Response | null> {
  if (url.pathname === ACCOUNT_CONNECT_DEVICES_SEND_PATH) {
    if (method !== 'POST') return methodNotAllowed(['POST'])
    if (url.search) return fail('VALIDATION', 'send-instructions accepts no query selectors', unchanged)
    const first = await authorizeAccountOwner(ports, request, TOOLS, 'Connect devices')
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return fail('VALIDATION', 'JSON is required', unchanged)
    }
    const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > 4096) return fail('VALIDATION', 'the request is too large', unchanged)
    let body: unknown
    try { body = JSON.parse(raw) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
      || !Object.hasOwn(body, 'mailbox') || !Object.hasOwn(body, 'email')) {
      return fail('VALIDATION', 'a JSON body with mailbox and email is required', unchanged)
    }
    const mailbox = assertEmail((body as { mailbox: unknown }).mailbox, 'mailbox')
    const mailboxes = await resolveOwnedMailboxes(ports.store, first.account.id)
    if (!mailboxes.includes(mailbox)) return fail('NOT_FOUND', 'mailbox not found', unchanged)
    const fresh = await authorizeAccountOwner(ports, request, TOOLS, 'Connect devices')
    if (fresh.caller.principal.id !== first.caller.principal.id || fresh.account.id !== first.account.id) {
      return fail('FORBIDDEN', 'account authorization changed', unchanged)
    }
    const freshMailboxes = await resolveOwnedMailboxes(ports.store, fresh.account.id)
    if (!freshMailboxes.includes(mailbox)) return fail('NOT_FOUND', 'mailbox not found', unchanged)
    const email = await dispatchDeviceSetupInstructions(mailbox, (body as { email: unknown }).email, ports)
    if (ports.emitAudit) {
      await ports.emitAudit({
        actor: fresh.caller.principal.username,
        principalId: fresh.caller.principal.id,
        action: 'account.email.connect_devices_sent',
        target: 'mailbox:' + mailbox,
        outcome: 'ok',
        detail: { to: email },
      })
    }
    return mailboxJson({ sent: true, mailbox })
  }

  const route = ({
    [ACCOUNT_CONNECT_DEVICES_PATH]: 'view',
    [ACCOUNT_CONNECT_DEVICES_AUTOCONFIG_PATH]: 'autoconfig',
    [ACCOUNT_CONNECT_DEVICES_APPLE_PATH]: 'apple',
  } as Record<string, 'view' | 'autoconfig' | 'apple' | undefined>)[url.pathname]
  if (!route) return null
  if (method !== 'GET') return methodNotAllowed(['GET'])
  if (request.body !== null) return fail('VALIDATION', 'connect devices read accepts no request body', unchanged)

  const requestedMailbox = readMailboxQuery(url)
  const first = await authorizeAccountOwner(ports, request, TOOLS, 'Connect devices')
  const mailboxes = await resolveOwnedMailboxes(ports.store, first.account.id)
  const mailbox = requestedMailbox === null ? (mailboxes[0] ?? null) : (mailboxes.includes(requestedMailbox) ? requestedMailbox : fail('NOT_FOUND', 'mailbox not found', unchanged))
  const hostname = normalizeDeviceSetupHostname(await ports.readHostname())

  const fresh = await authorizeAccountOwner(ports, request, TOOLS, 'Connect devices')
  if (fresh.caller.principal.id !== first.caller.principal.id || fresh.account.id !== first.account.id) {
    return fail('FORBIDDEN', 'account authorization changed', unchanged)
  }
  const freshMailboxes = await resolveOwnedMailboxes(ports.store, fresh.account.id)
  if (mailbox !== null && !freshMailboxes.includes(mailbox)) {
    return fail('NOT_FOUND', 'mailbox not found', unchanged)
  }

  if (route === 'view') {
    if (mailbox === null) {
      return mailboxJson({
        context: { username: fresh.account.username, mailboxes: freshMailboxes },
        mailbox: null,
        username: null,
        hostname,
        incoming: [...MAIL_CLIENT_ENDPOINTS.incoming],
        outgoing: [...MAIL_CLIENT_ENDPOINTS.outgoing],
        pop3: 'not-offered',
        authentication: 'password',
        passwordIncluded: false,
        certificate: 'not-verified-by-this-page',
        downloads: [],
      })
    }
    return mailboxJson({
      context: { username: fresh.account.username, mailboxes: freshMailboxes },
      ...buildDeviceSetupView(mailbox, hostname, buildAccountDownloads(mailbox, hostname)),
    })
  }

  if (mailbox === null) return fail('NOT_FOUND', 'mailbox not found', unchanged)
  if (!hostname) {
    return fail('PRECONDITION_FAILED', 'the server hostname has not been saved, so no setup file can be generated', { ...unchanged, reason: 'hostname_unavailable' })
  }
  const file = route === 'autoconfig' ? DEVICE_SETUP_FILES.autoconfig : DEVICE_SETUP_FILES.apple
  return new Response(route === 'autoconfig' ? renderMailAutoconfig(mailbox, hostname) : renderAppleMailProfile(mailbox, hostname), {
    headers: {
      'content-type': file.contentType,
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
