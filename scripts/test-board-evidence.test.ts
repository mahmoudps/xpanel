import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { BOARD_LIMITS, REQUIRED_BOARD_SCREENS, assertBoardEvidence, evaluateBoardEvidence, evidenceDigest, scoreBoardPixels } from './board-evidence.mjs'
import { PNG } from 'pngjs'

const image = (width = 200, height = 200, black = false): Buffer => {
  const png = new PNG({ width, height })
  png.data.fill(black ? 0 : 255)
  if (black) for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255
  return PNG.sync.write(png)
}
const source = evidenceDigest('synthetic current source manifest')
const referenceInput = evidenceDigest('synthetic independent reference manifest')
const capture = (role: string, pngBytes: Buffer, negative = false) => {
  const candidate = role === 'candidate'
  const responseBytes = Buffer.from(candidate ? '<main>current renderer</main>' : '<main>independent reference</main>')
  const dom = negative ? '<main style="padding-inline-start:1px">current renderer</main>' : responseBytes.toString()
  return { captureId: `${role}-${negative ? 'negative' : 'normal'}`, processNonce: role, processId: candidate ? 102 : 101, url: `http://127.0.0.1:${candidate ? 31002 : 31001}/synthetic`, responseStatus: 200,
    inputDigest: candidate ? source : referenceInput, responseBytes, responseDigest: evidenceDigest(responseBytes), dom, domDigest: evidenceDigest(dom), pngBytes, pngDigest: evidenceDigest(pngBytes), capturedAt: '2026-10-24T00:00:00.000Z',
    layout: { modified: false, viewportWidth: 200, viewportHeight: 200, documentScrollWidth: 200, bodyScrollWidth: 200, documentScrollHeight: 200, bodyScrollHeight: 200, rootOverflowX: 'visible', rootOverflowY: 'visible', bodyOverflowX: 'visible', bodyOverflowY: 'visible' } }
}
const receipt = () => {
  const reference = capture('reference', image())
  const candidate = capture('candidate', image())
  return { referenceInputsAvailable: true, sourceBeforeDigest: source, sourceAfterDigest: source, screens: [{ id: 'synthetic', width: 200, height: 200, referenceInputDigest: referenceInput, reference, candidate,
    negativeControl: { kind: 'padding-inline-start', pixels: 1, baseDomDigest: candidate.domDigest, capture: capture('candidate', image(200, 200, true), true) } }] }
}

describe('strict board evidence qualification', () => {
  it('allows identical rendered PNGs with independent bound provenance', () => {
    const input = receipt()
    assert.equal(input.screens[0]!.reference.pngBytes.equals(input.screens[0]!.candidate.pngBytes), true)
    assert.equal(assertBoardEvidence(input, ['synthetic']).accepted, true)
  })
  it('does not turn blocked external references into a pass', () => {
    const input = { ...receipt(), referenceInputsAvailable: false }
    assert.equal(evaluateBoardEvidence(input, ['synthetic']).status, 'blocked')
    assert.throws(() => assertBoardEvidence(input, ['synthetic']), /blocked/)
  })
  it('requires every declared screen and rejects duplicates, omissions and an empty mandatory list', () => {
    assert.equal(evaluateBoardEvidence(receipt()).accepted, false)
    assert.equal(evaluateBoardEvidence(receipt(), []).accepted, false)
    const input = receipt()
    input.screens.push(input.screens[0]!)
    assert.equal(evaluateBoardEvidence(input, ['synthetic', 'missing']).accepted, false)
    assert.ok(REQUIRED_BOARD_SCREENS.includes('inbox'))
  })
  it('requires unique capture witnesses for every mandatory screen', () => {
    const input = receipt();const extra = receipt().screens[0]!
    extra.id = 'another';input.screens.push(extra)
    assert.equal(evaluateBoardEvidence(input, ['synthetic', 'another']).accepted, false)
    for (const side of [extra.reference, extra.candidate, extra.negativeControl.capture]) side.captureId += '-another'
    assert.equal(assertBoardEvidence(input, ['synthetic', 'another']).accepted, true)
  })
  it('rejects dimension mismatch instead of cropping', () => {
    assert.throws(() => scoreBoardPixels(image(), image(201, 200)), /dimensions/)
    const input = receipt()
    input.screens[0]!.candidate = capture('candidate', image(201, 200))
    assert.equal(evaluateBoardEvidence(input, ['synthetic']).accepted, false)
  })
  it('preserves page and local tile budgets, including partial boundary tiles', () => {
    assert.deepEqual(BOARD_LIMITS, { page: 0.005, tile: 0.01, tileSize: 200 })
    const candidate = new PNG({ width: 401, height: 401 });candidate.data.fill(255)
    const changed = ((400 * 401) + 400) * 4
    candidate.data[changed] = candidate.data[changed + 1] = candidate.data[changed + 2] = 0
    const score = scoreBoardPixels(image(401, 401), PNG.sync.write(candidate))
    assert.ok(score.pageRatio < BOARD_LIMITS.page)
    assert.equal(score.worstTileRatio, 1)
    assert.equal(score.pass, false)
  })
  it('rejects source drift, forged content hashes and same-process comparisons', () => {
    for (const kind of ['drift', 'digest', 'process', 'origin'] as const) {
      const input = receipt();const row = input.screens[0]!
      if (kind === 'drift') input.sourceAfterDigest = referenceInput
      if (kind === 'digest') row.candidate.pngDigest = referenceInput
      if (kind === 'process') row.candidate.processId = row.reference.processId
      if (kind === 'origin') row.candidate.url = row.reference.url
      assert.equal(evaluateBoardEvidence(input, ['synthetic']).accepted, false)
    }
  })
  it('rejects concealed overflow, actual overflow and missing layout observations', () => {
    for (const kind of ['rootOverflowX', 'bodyOverflowY', 'overflow', 'vertical', 'modified'] as const) {
      const input = receipt();const layout = input.screens[0]!.candidate.layout
      if (kind === 'overflow') layout.documentScrollWidth = 201
      else if (kind === 'vertical') layout.bodyScrollHeight = 201
      else if (kind === 'modified') layout.modified = true
      else layout[kind] = 'hidden'
      assert.equal(evaluateBoardEvidence(input, ['synthetic']).accepted, false)
    }
  })
  it('requires a bound negative control that actually fails its strict pixel budgets', () => {
    const input = receipt()
    input.screens[0]!.negativeControl.capture = capture('candidate', image(), true)
    assert.equal(evaluateBoardEvidence(input, ['synthetic']).accepted, false)
    const unbound = receipt();unbound.screens[0]!.negativeControl.baseDomDigest = referenceInput
    assert.equal(evaluateBoardEvidence(unbound, ['synthetic']).accepted, false)
  })
  it('fails qualification when any mandatory product screen exceeds its budget', () => {
    const input = receipt();const extra = receipt().screens[0]!
    extra.id = 'another';extra.candidate = capture('candidate', image(200, 200, true))
    for (const side of [extra.reference, extra.candidate, extra.negativeControl.capture]) side.captureId += '-another'
    input.screens.push(extra)
    assert.equal(evaluateBoardEvidence(input, ['synthetic', 'another']).accepted, false)
    assert.throws(() => assertBoardEvidence(input, ['synthetic', 'another']))
  })
})
