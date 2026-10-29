import type { ConfigurationHealthView } from './configuration-health.ts'

/** Self-contained boundary parser, also used by the API projection; no raw test output or command argv is exposed. */
export function readConfigurationHealthView(value: unknown): ConfigurationHealthView {
  const obj = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)
  const integer = (item: unknown, min = 0): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= min
  const bad = (): never => { throw new Error('invalid_configuration_health') }
  if (!obj(value) || !['read', 'unavailable'].includes(String(value.state)) || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || value.revision !== null && !hash(value.revision)
    || !['clean', 'drift', 'unavailable'].includes(String(value.drift)) || !['linked', 'missing', 'unavailable'].includes(String(value.manifest)) || value.pending !== null && typeof value.pending !== 'boolean' || value.managedFiles !== null && !integer(value.managedFiles, 1)
    || !Array.isArray(value.targets) || value.targets.length > 10000 || !Array.isArray(value.tests) || value.tests.length > 256 || typeof value.canRepair !== 'boolean' || !['ready', 'provider_unavailable', 'no_drift', 'observation_unavailable', 'pending_changes'].includes(String(value.repairReason))) return bad()
  const generation = value.generation === null ? null : obj(value.generation) && integer(value.generation.id, 1) && hash(value.generation.checksum) ? { id: value.generation.id, checksum: value.generation.checksum } : bad()
  const desired = value.desired === null ? null : obj(value.desired) && integer(value.desired.revision) && hash(value.desired.checksum) ? { revision: value.desired.revision, checksum: value.desired.checksum } : bad()
  const paths = new Set<string>(), tokens = new Set<string>(), names = new Set<string>()
  const targets = value.targets.map(raw => {
    if (!obj(raw) || !hash(raw.token) || tokens.has(raw.token) || typeof raw.path !== 'string' || raw.path.length > 1024 || !raw.path.startsWith('/') || raw.path.includes('//') || raw.path.split('/').some(part => part === '.' || part === '..') || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(raw.path) || paths.has(raw.path)
      || !['missing', 'content_mismatch', 'metadata_mismatch'].includes(String(raw.reason)) || !hash(raw.expectedChecksum) || raw.observedChecksum !== null && !hash(raw.observedChecksum) || raw.reason === 'missing' && raw.observedChecksum !== null || raw.reason !== 'missing' && raw.observedChecksum === null || raw.reason === 'content_mismatch' && raw.observedChecksum === raw.expectedChecksum || raw.reason === 'metadata_mismatch' && raw.observedChecksum !== raw.expectedChecksum) return bad()
    paths.add(raw.path); tokens.add(raw.token)
    return { token: raw.token, path: raw.path, reason: raw.reason as 'missing' | 'content_mismatch' | 'metadata_mismatch', expectedChecksum: raw.expectedChecksum, observedChecksum: raw.observedChecksum as string | null }
  })
  const tests = value.tests.map(raw => {
    if (!obj(raw) || typeof raw.name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(raw.name) || names.has(raw.name) || !['passed', 'failed', 'unavailable'].includes(String(raw.state)) || raw.exitCode !== null && (!integer(raw.exitCode) || raw.exitCode > 255)
      || raw.state === 'passed' && raw.exitCode !== 0 || raw.state === 'failed' && (raw.exitCode === null || raw.exitCode === 0) || raw.state === 'unavailable' && raw.exitCode !== null) return bad()
    names.add(raw.name)
    return { name: raw.name, state: raw.state as 'passed' | 'failed' | 'unavailable', exitCode: raw.exitCode as number | null }
  })
  if (value.state === 'read' ? !generation || !desired || !hash(value.revision) || value.manifest !== 'linked' || !integer(value.managedFiles, 1) || value.pending === null || value.drift !== (targets.length ? 'drift' : 'clean') || targets.length > Number(value.managedFiles) || value.canRepair !== (value.repairReason === 'ready') || value.canRepair && (!targets.length || value.pending) || value.pending && value.repairReason !== 'pending_changes'
    : value.revision !== null || value.drift !== 'unavailable' || value.pending !== null || value.managedFiles !== null || targets.length !== 0 || tests.length !== 0 || value.canRepair || value.repairReason !== 'observation_unavailable') return bad()
  return { state: value.state as ConfigurationHealthView['state'], observedAt: value.observedAt, revision: value.revision as string | null, generation, desired, drift: value.drift as ConfigurationHealthView['drift'], manifest: value.manifest as ConfigurationHealthView['manifest'], pending: value.pending as boolean | null, managedFiles: value.managedFiles as number | null, targets, tests, canRepair: value.canRepair, repairReason: value.repairReason as ConfigurationHealthView['repairReason'] }
}
export function readConfigurationHealthRepair(value: unknown, target: string, generation: { id: number; checksum: string }): ConfigurationHealthView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_configuration_repair')
  const raw = value as Record<string, unknown>, view = readConfigurationHealthView(raw.view)
  if (raw.outcome !== 'verified' || raw.target !== target || raw.recoveryVerified !== true || raw.verificationRequired !== false || !raw.generation || typeof raw.generation !== 'object' || (raw.generation as Record<string, unknown>).id !== generation.id || (raw.generation as Record<string, unknown>).checksum !== generation.checksum || view.state !== 'read' || view.generation?.id !== generation.id || view.generation.checksum !== generation.checksum || view.pending !== false || view.tests.length === 0 || view.tests.some(test => test.state !== 'passed') || view.targets.some(row => row.token === target)) throw new Error('invalid_configuration_repair')
  return view
}

