import { fail, isXpanelError, type OsProfile, type ServerSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import type { StateStore } from '@xpanel/state'
import {
  applyWebStack,
  previewWebStack,
  readWebStack,
  validateWebStackSelection,
  type WebStackRouteDeps,
} from '../../agent/src/web-stack-builder.ts'
import {
  OLS_SERVICE_ACTIONS,
  previewOlsConfig,
  renderOlsManagedPreview,
  validateOlsConfigText,
  type OlsRouteDeps,
} from '../../agent/src/ols-manager.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readPanelConfigBody } from './panel-config-file.ts'

const unchanged = { stateChanged: false } as const
const WEB_STACK_ROUTE = '/api/server/web-stack'
const WEB_STACK_PREVIEW_ROUTE = '/api/server/web-stack/preview'
const WEB_STACK_APPLY_ROUTE = '/api/server/web-stack/apply'
const OLS_PREFIX = '/api/server/services/openlitespeed'

const DEFAULT_OS_PROFILE: OsProfile = profileFor('ID=ubuntu\nVERSION_ID=24.04')

export interface WhmWebStackHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getServerSettings'>
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
  readHost?: (caller: AuthenticatedCaller, path: string) => Promise<unknown>
  triggerReconcile?: ExtendedRouteHelpers['triggerReconcile']
  now?: () => Date
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

const sameCaller = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean =>
  a.principal.id === b.principal.id && a.principal.kind === b.principal.kind

function localWebStackDeps(caller: AuthenticatedCaller, helpers: WhmWebStackHelpers): WebStackRouteDeps {
  return {
    assertRoot: async () => ({ actor: caller.principal.username }),
    os: DEFAULT_OS_PROFILE,
    stateRoot: helpers.store.rootDir,
    readServerSettings: () => helpers.store.getServerSettings(),
    run: null,
    ...(helpers.now ? { now: helpers.now } : {}),
  }
}

function localOlsDeps(caller: AuthenticatedCaller, helpers: WhmWebStackHelpers): OlsRouteDeps {
  return {
    assertRoot: async () => ({ actor: caller.principal.username }),
    os: DEFAULT_OS_PROFILE,
    stateRoot: helpers.store.rootDir,
    readServerSettings: () => helpers.store.getServerSettings(),
    run: null,
    ...(helpers.now ? { now: helpers.now } : {}),
  }
}

async function hostRead(caller: AuthenticatedCaller, helpers: WhmWebStackHelpers, path: string): Promise<unknown> {
  if (helpers.readHost) return helpers.readHost(caller, path)
  if (helpers.callHost) return helpers.callHost(caller, path)
  return null
}

/** Root-only API routes for Web Stack Builder and OpenLiteSpeed Manager. */
export async function handleWhmWebStackRoutes(request: Request, url: URL, method: string, helpers: WhmWebStackHelpers): Promise<Response | null> {
  const path = url.pathname
  const isStack = path === WEB_STACK_ROUTE || path === WEB_STACK_PREVIEW_ROUTE || path === WEB_STACK_APPLY_ROUTE
  const isOls = path === OLS_PREFIX || path.startsWith(OLS_PREFIX + '/')
  if (!isStack && !isOls) return null

  const olsOp = isOls ? path.slice(OLS_PREFIX.length) : ''
  const isOlsRead = isOls && olsOp === ''
  const isOlsWrite = isOls && (olsOp === '/action' || olsOp === '/config/preview' || olsOp === '/config/apply' || olsOp === '/config/rollback')
  if (isOls && !isOlsRead && !isOlsWrite) return new Response(null, { status: 404 })

  const isRead = path === WEB_STACK_ROUTE || isOlsRead
  const expectedMethod = isRead ? 'GET' : 'POST'
  if (method !== expectedMethod) {
    return new Response(null, { status: 405, headers: { allow: expectedMethod } })
  }

  const caller = await helpers.requireCaller(request)
  const rootAction = isStack
    ? (path === WEB_STACK_ROUTE ? 'server.web_stack.read' : path === WEB_STACK_PREVIEW_ROUTE ? 'server.web_stack.preview' : 'server.web_stack.apply')
    : `server.openlitespeed.${isOlsRead ? 'read' : olsOp.slice(1).replace(/\//g, '.')}`
  await helpers.assertRoot(caller, rootAction)

  if (url.search) {
    return fail('VALIDATION', 'web stack and OpenLiteSpeed routes do not accept query selectors', unchanged)
  }

  const fresh = async (): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, rootAction)
    return sameCaller(caller, current) ? current : fail('FORBIDDEN', 'root authorization changed', unchanged)
  }

  // ---- Web Stack Builder ---------------------------------------------------
  if (path === WEB_STACK_ROUTE) {
    if (helpers.readHost || helpers.callHost) {
      try {
        const reply = await hostRead(caller, helpers, '/host/web-stack')
        await fresh()
        return json({ ...(isRecord(reply) ? reply : {}), hostConnected: true })
      } catch (error) {
        if (!isXpanelError(error) || error.code !== 'SERVICE_UNAVAILABLE') throw error
      }
    }
    const localView = await readWebStack(localWebStackDeps(caller, helpers))
    await fresh()
    return json({ ...localView, hostConnected: false })
  }

  if (path === WEB_STACK_PREVIEW_ROUTE) {
    const body = await readPanelConfigBody(request, 64 * 1024)
    validateWebStackSelection(body)
    if (helpers.callHost) {
      const reply = await helpers.callHost(caller, '/host/web-stack/preview', body)
      return json(reply)
    }
    return json(await previewWebStack(localWebStackDeps(caller, helpers), body))
  }

  if (path === WEB_STACK_APPLY_ROUTE) {
    const body = await readPanelConfigBody(request, 64 * 1024)
    const selection = validateWebStackSelection(body)
    const actor = await fresh()
    try {
      const reply = helpers.callHost
        ? await helpers.callHost(actor, '/host/web-stack/apply', body)
        : await applyWebStack(localWebStackDeps(actor, helpers), body, actor.principal.username)
      await helpers.emitAudit({
        actor: actor.principal.username,
        action: 'server.web_stack.applied',
        target: `web-stack:${selection.profileId}`,
        principalId: actor.principal.id,
        outcome: 'ok',
        detail: { engine: selection.engine, mpm: selection.mpm, modules: selection.modules, phpVersions: selection.phpVersions },
      })
      return json(reply)
    } catch (error) {
      if (!isXpanelError(error) || error.detail.stateChanged !== false) {
        await helpers.emitAudit({
          actor: actor.principal.username,
          action: 'server.web_stack.applied',
          target: `web-stack:${selection.profileId}`,
          principalId: actor.principal.id,
          outcome: 'failed',
          detail: { engine: selection.engine, mpm: selection.mpm },
        }).catch(() => undefined)
      }
      throw error
    }
  }

  // ---- OpenLiteSpeed Manager -----------------------------------------------
  if (isOlsRead) {
    if (helpers.readHost || helpers.callHost) {
      try {
        const reply = await hostRead(caller, helpers, '/host/services/openlitespeed')
        await fresh()
        return json({ ...(isRecord(reply) ? reply : {}), hostConnected: true })
      } catch (error) {
        if (!isXpanelError(error) || error.code !== 'SERVICE_UNAVAILABLE') throw error
      }
    }
    const now = (helpers.now ?? (() => new Date()))()
    const settings: ServerSettings | null = await helpers.store.getServerSettings()
    await fresh()
    return json({
      observedAt: now.toISOString(),
      installed: false,
      state: 'not_installed',
      unit: null,
      active: null,
      enabled: null,
      binaryPath: `${DEFAULT_OS_PROFILE.paths.olsRoot}/bin/lshttpd`,
      configPath: `${DEFAULT_OS_PROFILE.paths.olsRoot}/conf/httpd_config.conf`,
      config: null,
      revision: null,
      backups: [],
      logTail: [],
      renderedReference: renderOlsManagedPreview(settings),
      hostConnected: false,
    })
  }

  const body = await readPanelConfigBody(request, 512 * 1024)

  if (olsOp === '/config/preview') {
    if (body.generateBase !== true || body.text !== undefined) {
      validateOlsConfigText(body.text, DEFAULT_OS_PROFILE.paths.olsRoot)
    }
    if (helpers.callHost) {
      return json(await helpers.callHost(caller, '/host/services/openlitespeed/config/preview', body))
    }
    return json(await previewOlsConfig(localOlsDeps(caller, helpers), body))
  }

  if (olsOp === '/action') {
    if (typeof body.action !== 'string' || !(OLS_SERVICE_ACTIONS as readonly string[]).includes(body.action)) {
      return fail('VALIDATION', 'action must be one of start, stop, restart, enable, disable', { ...unchanged, reason: 'unsupported_ols_action' })
    }
    const actor = await fresh()
    if (!helpers.callHost) {
      return fail('PRECONDITION_FAILED', 'OpenLiteSpeed is not installed or host agent is unavailable', { ...unchanged, reason: 'openlitespeed_not_installed' })
    }
    try {
      const reply = await helpers.callHost(actor, '/host/services/openlitespeed/action', body)
      await helpers.emitAudit({
        actor: actor.principal.username,
        action: 'server.openlitespeed.service_action',
        target: 'service:openlitespeed',
        principalId: actor.principal.id,
        outcome: 'ok',
        detail: { action: body.action },
      })
      return json(reply)
    } catch (error) {
      if (!isXpanelError(error) || error.detail.stateChanged !== false) {
        await helpers.emitAudit({
          actor: actor.principal.username,
          action: 'server.openlitespeed.service_action',
          target: 'service:openlitespeed',
          principalId: actor.principal.id,
          outcome: 'failed',
          detail: { action: body.action },
        }).catch(() => undefined)
      }
      throw error
    }
  }

  if (olsOp === '/config/apply') {
    validateOlsConfigText(body.text, DEFAULT_OS_PROFILE.paths.olsRoot)
    const actor = await fresh()
    if (!helpers.callHost) {
      return fail('PRECONDITION_FAILED', 'OpenLiteSpeed is not installed or host agent is unavailable', { ...unchanged, reason: 'openlitespeed_not_installed' })
    }
    try {
      const reply = await helpers.callHost(actor, '/host/services/openlitespeed/config/apply', body)
      await helpers.emitAudit({
        actor: actor.principal.username,
        action: 'server.openlitespeed.config_applied',
        target: 'config:openlitespeed',
        principalId: actor.principal.id,
        outcome: 'ok',
        detail: { backupId: isRecord(reply) ? reply.backupId ?? null : null },
      })
      return json(reply)
    } catch (error) {
      if (!isXpanelError(error) || error.detail.stateChanged !== false) {
        await helpers.emitAudit({
          actor: actor.principal.username,
          action: 'server.openlitespeed.config_applied',
          target: 'config:openlitespeed',
          principalId: actor.principal.id,
          outcome: 'failed',
          detail: {},
        }).catch(() => undefined)
      }
      throw error
    }
  }

  // /config/rollback
  const actor = await fresh()
  if (!helpers.callHost) {
    return fail('PRECONDITION_FAILED', 'OpenLiteSpeed is not installed or host agent is unavailable', { ...unchanged, reason: 'openlitespeed_not_installed' })
  }
  try {
    const reply = await helpers.callHost(actor, '/host/services/openlitespeed/config/rollback', body)
    await helpers.emitAudit({
      actor: actor.principal.username,
      action: 'server.openlitespeed.config_rolled_back',
      target: 'config:openlitespeed',
      principalId: actor.principal.id,
      outcome: 'ok',
      detail: { backupId: isRecord(reply) ? reply.backupId ?? null : null },
    })
    return json(reply)
  } catch (error) {
    if (!isXpanelError(error) || error.detail.stateChanged !== false) {
      await helpers.emitAudit({
        actor: actor.principal.username,
        action: 'server.openlitespeed.config_rolled_back',
        target: 'config:openlitespeed',
        principalId: actor.principal.id,
        outcome: 'failed',
        detail: {},
      }).catch(() => undefined)
    }
    throw error
  }
}
