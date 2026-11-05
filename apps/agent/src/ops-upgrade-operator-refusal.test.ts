import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  ROOT_OPERATOR_MACHINE_CODE, encodeRootOperatorRefusal, parseRootOperatorRefusal, rootOperatorRefusalJournalLine,
  rootOperatorReviewRecord, rootOperatorServerRefusal, rootOperatorServerRefusalCode, stableMachineCode,
} from './ops-upgrade-operator-refusal.ts'

// Only the pure refusal rules are covered here; no socket, filesystem or authority is used.
const operationId = '11111111-1111-4111-8111-111111111111'
const stable = (message: string, code: string): Error => Object.assign(new Error(message), { code })

test('stableMachineCode unwraps a cause chain to the stable callback code', () => {
  const cause = stable('LIFECYCLE_DATABASE_ADMISSION_REQUIRED', 'LIFECYCLE_DATABASE_ADMISSION_REQUIRED')
  const wrapped = Object.assign(new Error('Archive callback failed'), { code: 'ARCHIVE_USE_UNCERTAIN', cause })
  assert.equal(stableMachineCode(wrapped), 'LIFECYCLE_DATABASE_ADMISSION_REQUIRED')
  const deep = Object.assign(new Error('outer wrapper'), { code: 'ARCHIVE_USE_UNCERTAIN', cause: Object.assign(new Error('inner'), { cause }) })
  assert.equal(stableMachineCode(deep), 'LIFECYCLE_DATABASE_ADMISSION_REQUIRED')
  assert.equal(stableMachineCode(stable('ARCHIVE_USE_UNCERTAIN', 'ARCHIVE_USE_UNCERTAIN')), 'ARCHIVE_USE_UNCERTAIN')
  assert.equal(stableMachineCode(stable('COORDINATOR_OWNERSHIP_SCOPE_REQUIRED', 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')), 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')
  // Existing rule forwards any stable-code-shaped value, e.g. a kernel errno code.
  assert.equal(stableMachineCode(Object.assign(new Error('open /root/private failed'), { code: 'ENOENT' })), 'ENOENT')
  // The client-facing review record still hides unknown plain errors behind the generic code.
  assert.equal(stableMachineCode(new Error('open /root/private failed')), 'ROOT_OPERATOR_REVIEW_REQUIRED')
  assert.equal(stableMachineCode(new TypeError('input must be a string')), 'ROOT_OPERATOR_REVIEW_REQUIRED')
  assert.equal(stableMachineCode(new AggregateError([new Error('x')], 'retirement requires inspection')), 'ROOT_OPERATOR_REVIEW_REQUIRED')
})

test('a plain server error maps to one fixed server-error code', () => {
  assert.equal(rootOperatorServerRefusalCode(new Error('open /etc/shadow: EACCES')), 'ROOT_OPERATOR_SERVER_ERROR')
  assert.equal(rootOperatorServerRefusalCode(new TypeError('input must be a string')), 'ROOT_OPERATOR_SERVER_ERROR')
  assert.equal(rootOperatorServerRefusalCode(new AggregateError([new Error('x')], 'retirement requires inspection')), 'ROOT_OPERATOR_SERVER_ERROR')
  assert.equal(rootOperatorServerRefusalCode('not an error'), 'ROOT_OPERATOR_SERVER_ERROR')
  assert.equal(rootOperatorServerRefusalCode(undefined), 'ROOT_OPERATOR_SERVER_ERROR')
  // Stable codes are forwarded unchanged, including through an archive wrapper cause chain.
  assert.equal(rootOperatorServerRefusalCode(stable('x', 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')), 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')
  assert.equal(rootOperatorServerRefusalCode(Object.assign(new Error('open failed'), { code: 'ENOENT' })), 'ENOENT')
  assert.equal(rootOperatorServerRefusalCode(Object.assign(new Error('wrapper'), { code: 'ARCHIVE_USE_UNCERTAIN',
    cause: stable('LIFECYCLE_OWNED_COORDINATOR_REQUIRED', 'LIFECYCLE_OWNED_COORDINATOR_REQUIRED') })), 'LIFECYCLE_OWNED_COORDINATOR_REQUIRED')
})

test('the server refusal frame is exactly one newline-terminated single-key JSON object', () => {
  const refusal = rootOperatorServerRefusal(new Error('open /root/private: EACCES'))
  assert.equal(refusal.code, 'ROOT_OPERATOR_SERVER_ERROR')
  const text = refusal.frame.toString('utf8')
  assert.equal(text, '{"refused":"ROOT_OPERATOR_SERVER_ERROR"}\n')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.indexOf('\n'), text.length - 1)
  const parsed = JSON.parse(text.slice(0, -1)) as Record<string, unknown>
  assert.deepEqual(Reflect.ownKeys(parsed), ['refused'])
  assert.equal(parsed.refused, refusal.code)
  assert.equal(ROOT_OPERATOR_MACHINE_CODE.test(String(parsed.refused)), true)
  // No raw message, stack, path or payload ever appears in the frame.
  assert.equal(text.includes('/'), false)
  assert.equal(text.includes('EACCES'), false)
  assert.equal(text.includes('Error'), false)
  // One bounded sanitized journal line carries the same code and nothing else.
  assert.equal(refusal.journalLine, 'xpanel-root-operator-refused code=ROOT_OPERATOR_SERVER_ERROR\n')
  assert.equal(refusal.journalLine.indexOf('\n'), refusal.journalLine.length - 1)
  assert.equal(refusal.journalLine.length <= 120, true)
  assert.equal(rootOperatorRefusalJournalLine('COORDINATOR_OWNERSHIP_SCOPE_REQUIRED'), 'xpanel-root-operator-refused code=COORDINATOR_OWNERSHIP_SCOPE_REQUIRED\n')
  // A free-form message or malformed code can never be encoded as a refusal.
  for (const invalid of ['open /root/private', 'ROOT_OPERATOR_SERVER_ERROR\n', 'root_operator_server_error', '']) {
    assert.throws(() => encodeRootOperatorRefusal(invalid), /ROOT_OPERATOR_REFUSAL_CODE_INVALID/)
    assert.throws(() => rootOperatorRefusalJournalLine(invalid), /ROOT_OPERATOR_REFUSAL_CODE_INVALID/)
  }
})

test('the client parses exactly one refusal frame and reports the code without retry', () => {
  const frame = rootOperatorServerRefusal(stable('wrapper', 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')).frame
  const code = parseRootOperatorRefusal(frame)
  assert.equal(code, 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')
  const reported = rootOperatorReviewRecord(operationId, Object.assign(new Error(code!), { code, operationId, unknownOutcome: true }))
  assert.deepEqual(reported, { operationId, state: 'review_required', code: 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED', retryAllowed: false })
  // A plain server-side error is now distinguishable from a silently lost reply.
  assert.equal(parseRootOperatorRefusal(rootOperatorServerRefusal(new TypeError('input must be a string')).frame), 'ROOT_OPERATOR_SERVER_ERROR')
  // Every other shape is not a refusal, so the single exchange falls through to the signed response path or a generic review.
  for (const invalid of [
    Buffer.from('{"refused":"ROOT_OPERATOR_SERVER_ERROR"}'),
    Buffer.from('{"refused":"ROOT_OPERATOR_SERVER_ERROR"}\n{"refused":"ROOT_OPERATOR_SERVER_ERROR"}\n'),
    Buffer.from('{"refused":"ROOT_OPERATOR_SERVER_ERROR","path":"/etc/shadow"}\n'),
    Buffer.from('{"refused":"root_operator_server_error"}\n'),
    Buffer.from('{"code":"ROOT_OPERATOR_SERVER_ERROR"}\n'),
    Buffer.from('[{"refused":"ROOT_OPERATOR_SERVER_ERROR"}]\n'),
    Buffer.from('refused\n'),
    Buffer.from('\n'),
  ]) assert.equal(parseRootOperatorRefusal(invalid), null)
  assert.equal(parseRootOperatorRefusal('not a buffer' as unknown as Buffer), null)
  // Single-shot client model: one connect, one settlement, no retry after a refusal.
  let attempts = 0, settlements = 0, reportedCode = ''
  const exchangeOnce = (chunks: readonly Buffer[]): void => {
    attempts += 1
    let bytes = Buffer.alloc(0), frameSeen = false
    for (const chunk of chunks) {
      bytes = Buffer.concat([bytes, chunk])
      if (!bytes.includes(10)) continue
      frameSeen = true
      const refusedCode = parseRootOperatorRefusal(bytes)
      if (refusedCode) { reportedCode = refusedCode; settlements += 1; return }
    }
    if (!frameSeen) settlements += 1
  }
  exchangeOnce([frame])
  assert.deepEqual({ attempts, settlements, reportedCode }, { attempts: 1, settlements: 1, reportedCode: 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED' })
})
