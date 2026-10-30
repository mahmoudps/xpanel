import { fail, isUuid } from '@xpanel/core'
import type { AgentApp } from '@xpanel/agent'
import { assertProvisioningReply, canonicalProvisioningIdentity, type ProvisioningReconcilePort, type ProvisioningReconcileReply } from './account-provisioning-port.ts'

/**
 * Dedicated authenticated admission, not generic /reconcile.
 * The lifecycle's trusted actor id is sent as x-xpanel-principal-id. The JSON actor is only a claim.
 */
export function createAuthenticatedProvisioningPort(source: { fetch: AgentApp['fetch']; token: string }): ProvisioningReconcilePort {
  if (!source.token || /[\r\n]/.test(source.token)) fail('SERVICE_UNAVAILABLE', 'account provisioning transport credential is unavailable')
  return {
    async reconcile(request, context) {
      if (request.binding !== canonicalProvisioningIdentity(request.authority)) {
        return fail('PRECONDITION_FAILED', 'account provisioning request binding is invalid', { stateChanged: false })
      }
      const principalId = request.authority.actor?.id
      if (!isUuid(principalId)) fail('UNAUTHENTICATED', 'an authenticated principal is required', { stateChanged: false })
      await context.assertAuthority()
      const timeout = AbortSignal.timeout(180_000)
      let reply: ProvisioningReconcileReply
      try {
        const response = await source.fetch(new Request('http://agent.local/host/account-provisioning', {
          method: 'POST', headers: {
            'x-xpanel-agent-token': source.token,
            'x-xpanel-principal-id': principalId,
            'content-type': 'application/json',
          },
          body: JSON.stringify(request), signal: AbortSignal.any([context.signal, timeout]),
        }))
        if (!response.ok || !response.body) throw new Error('unacknowledged reply')
        const reader = response.body.getReader(), chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.length
            if (size > 1024 * 1024) throw new Error('oversized reply')
            chunks.push(chunk.value)
          }
        } finally { await reader.cancel().catch(() => undefined) }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid reply')
        reply = value as ProvisioningReconcileReply
      } catch {
        return fail('PRECONDITION_FAILED', 'account provisioning transport did not acknowledge a verified outcome', { stateChanged: true, verificationRequired: true })
      }
      await context.assertAuthority()
      assertProvisioningReply(request, reply)
      return reply
    },
  }
}
