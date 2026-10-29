import { fail, isUuid } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'

/** Shared immutable candidate publication for manual and prepared ACME material. */
export async function publishCertificateCandidate(input: { executor: AgentExecutor; certificateId: string; fullchain: string; privateKey: string }) {
  if (!isUuid(input.certificateId)) return fail('VALIDATION', 'a fresh certificate identity is required', { stateChanged: false })
  const plan = services.certInstall(input.certificateId, { fullchain: input.fullchain, privkey: input.privateKey })
  const certFile = plan.files.find(file => file.path.endsWith('/fullchain.pem')), keyFile = plan.files.find(file => file.path.endsWith('/privkey.pem'))
  if (!certFile || !keyFile || plan.files.length !== 2 || keyFile.mode !== 0o600 || keyFile.owner !== 'root' || keyFile.group !== 'root') return fail('PRECONDITION_FAILED', 'certificate installation plan is unavailable', { stateChanged: false })
  for (const file of plan.files) if (await input.executor.readFile(file.path) !== null) return fail('CONFLICT', 'fresh certificate candidate already exists', { stateChanged: false })
  await input.executor.preflight({ files: plan.files, preActions: plan.actions, postActions: [] })
  try {
    for (const action of plan.actions) await input.executor.runAction(action)
    for (const file of plan.files) await input.executor.writeFile(file)
    for (const file of plan.files) if (await input.executor.readFile(file.path) !== file.content) throw new Error('candidate_readback_mismatch')
  } catch {
    let recovered = true
    for (const file of [...plan.files].reverse()) {
      try {
        const current = await input.executor.readFile(file.path)
        if (current === null) continue
        if (current !== file.content) { recovered = false; continue }
        await input.executor.removePath(file.path)
        if (await input.executor.readFile(file.path) !== null) recovered = false
      } catch { recovered = false }
    }
    return fail('SERVICE_UNAVAILABLE', 'certificate candidate installation requires recovery review', {
      stateChanged: true, verificationRequired: true, unknownOutcome: true, candidateFilesRemoved: recovered, preparationMayRemain: true,
    })
  }
  return { certPath: certFile.path, keyPath: keyFile.path }
}
