import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { RenderedFile } from '@xpanel/core'
import { system } from '@xpanel/render'
import { atomicWriteJson } from '@xpanel/state'
import { CTR_REGISTRY } from './ctr-command.ts'
import { assertComposeSyntax, parseStackEnv, STACK_LIMITS, STACK_NAME } from './ctr-compose.ts'
import { CTR_REGISTRIES_CONF } from './ctr-policy-paths.ts'

export { CTR_REGISTRIES_CONF, CTR_REGISTRIES_DIR } from './ctr-policy-paths.ts'

/** Host-wide desired state: which registries images may come from, their pull mirrors, and the stack templates. */
export const CTR_STATE_DIR = 'extended/containers'
export interface CtrRegistry { host: string; namespace: string | null; mirror: string | null }
export interface CtrTemplate { name: string; description: string; yaml: string; env: string }
export interface CtrPolicy { registries: CtrRegistry[]; templates: CtrTemplate[]; feedUrl: string | null }
export const CTR_DEFAULT_POLICY: CtrPolicy = { registries: system.CONTAINER_REGISTRIES.map(host => ({ host, namespace: null, mirror: null })), templates: [], feedUrl: null }
const NAMESPACE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,3}$/
const MIRROR = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::[0-9]{2,5})?(?:\/[A-Za-z0-9._-]+){0,4}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, list: string[]): boolean => Object.keys(value).sort().join() === [...list].sort().join()
const unchanged = { stateChanged: false }

export function parseCtrPolicy(raw: unknown): CtrPolicy {
  const bad = (message: string): never => fail('VALIDATION', message, unchanged)
  if (!object(raw) || !keys(raw, ['registries', 'templates', 'feedUrl']) || !(raw.feedUrl === null || typeof raw.feedUrl === 'string' && raw.feedUrl.length <= 512 && raw.feedUrl.startsWith('https://')) || !Array.isArray(raw.registries) || raw.registries.length > 32 || !Array.isArray(raw.templates) || raw.templates.length > 50) return bad('the container policy is invalid')
  const registries = raw.registries.map((r: unknown): CtrRegistry => {
    if (!object(r) || !keys(r, ['host', 'namespace', 'mirror']) || typeof r.host !== 'string' || !CTR_REGISTRY.test(r.host) || !(r.namespace === null || typeof r.namespace === 'string' && NAMESPACE.test(r.namespace)) || !(r.mirror === null || typeof r.mirror === 'string' && MIRROR.test(r.mirror))) return bad('a registry needs a host, an optional namespace and an optional mirror host')
    return { host: r.host, namespace: r.namespace, mirror: r.mirror }
  })
  if (new Set(registries.map(r => r.host + '/' + (r.namespace ?? ''))).size !== registries.length) return bad('a registry is listed twice')
  const templates = raw.templates.map((t: unknown): CtrTemplate => {
    if (!object(t) || !keys(t, ['name', 'description', 'yaml', 'env']) || typeof t.name !== 'string' || !STACK_NAME.test(t.name) || typeof t.description !== 'string' || t.description.length > STACK_LIMITS.notes || /[\u0000-\u001f\u007f]/.test(t.description) || typeof t.yaml !== 'string' || typeof t.env !== 'string') return bad('a template needs a name, a description, a compose file and env content')
    assertComposeSyntax(t.yaml)
    parseStackEnv(t.env)
    return { name: t.name, description: t.description, yaml: t.yaml, env: t.env }
  })
  if (new Set(templates.map(t => t.name)).size !== templates.length) return bad('a template name is listed twice')
  return { registries, templates, feedUrl: raw.feedUrl }
}
export const ctrPolicyPath = (root: string): string => join(root, CTR_STATE_DIR, 'policy.json')
export const ctrPolicyRevision = (policy: CtrPolicy): string => createHash('sha256').update(JSON.stringify(policy)).digest('hex')
export async function readCtrPolicy(root: string): Promise<CtrPolicy> {
  let text: string
  try { text = await readFile(ctrPolicyPath(root), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return CTR_DEFAULT_POLICY
    return fail('PRECONDITION_FAILED', 'the saved container policy is unreadable', unchanged)
  }
  try { return parseCtrPolicy(JSON.parse(text)) } catch { return fail('PRECONDITION_FAILED', 'the saved container policy is invalid', unchanged) }
}
export const writeCtrPolicy = (root: string, policy: CtrPolicy): Promise<void> => atomicWriteJson(ctrPolicyPath(root), policy, 0o600)

export const isTrustedImage = (policy: CtrPolicy, image: string): boolean => {
  const host = system.containerImageHost(image)
  return host !== null && policy.registries.some(r => r.host === host && (r.namespace === null || image.startsWith(host + '/' + r.namespace + '/')))
}
export function assertTrustedImage(policy: CtrPolicy, image: string): void {
  if (!isTrustedImage(policy, image)) fail('PRECONDITION_FAILED', 'the container trust policy does not admit this registry', { ...unchanged, reason: 'untrusted_registry', image })
}
/** Pull mirrors reach every rootless store through containers-registries.conf(5); there is no daemon to restart. */
export function renderRegistriesConf(policy: CtrPolicy): RenderedFile | null {
  const mirrors = [...new Map(policy.registries.filter(r => r.mirror).map(r => [r.host, r.mirror!])).entries()]
  if (!mirrors.length) return null
  const content = ['# Managed by xPanel. Change pull mirrors on the Container engine page.', ...mirrors.flatMap(([host, mirror]) => ['', '[[registry]]', `prefix = "${host}"`, `location = "${host}"`, '', '[[registry.mirror]]', `location = "${mirror}"`]), ''].join('\n')
  return { path: CTR_REGISTRIES_CONF, content, mode: 0o644, owner: 'root', group: 'root' }
}
