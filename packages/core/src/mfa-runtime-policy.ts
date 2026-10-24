export type MfaRuntimeMode = 'disabled' | 'optional'
export interface MfaRuntimePolicy { readonly mode: MfaRuntimeMode }

const OPTIONAL: MfaRuntimePolicy = Object.freeze({ mode: 'optional' })
const DEVELOPMENT: MfaRuntimePolicy = Object.freeze({ mode: 'disabled' })
const capturedPolicies = new WeakSet<MfaRuntimePolicy>()

/** Only the trusted development process environment disables factor verification. */
export const resolveMfaRuntimePolicy = (nodeEnvironment: string | undefined): MfaRuntimePolicy =>
  nodeEnvironment === 'development' ? DEVELOPMENT : OPTIONAL

/** Capture at startup; request data and later environment changes cannot retarget a listener. */
export const captureMfaRuntimePolicy = (): MfaRuntimePolicy => {
  const policy = Object.freeze({ ...resolveMfaRuntimePolicy(process.env.NODE_ENV) })
  capturedPolicies.add(policy)
  return policy
}

/** A dependency may share an actual startup capture, never an arbitrary mode override. */
export const bindMfaRuntimePolicy = (policy?: MfaRuntimePolicy): MfaRuntimePolicy => {
  if (policy === undefined) return captureMfaRuntimePolicy()
  if (!capturedPolicies.has(policy)) throw new Error('MFA runtime policy must be captured from the trusted process environment')
  return policy
}

/** The default for callers without a captured startup policy is always optional. */
export const DEFAULT_MFA_RUNTIME_POLICY = OPTIONAL
