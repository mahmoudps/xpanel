import { describe, expect, it } from 'vitest'
import { renderAsyncActionState } from '../tokens.ts'
import { projectActionState, type AsyncActionStateKind } from './action-state.ts'

const internalId = '00000000-0000-4000-8000-000000000007'
const officialReference = 'XP-JOB-2026-000007'

describe('neutral action feedback', () => {
  it.each([
    ['idle', 'status', false, false], ['loading', 'status', true, true],
    ['pending', 'status', true, true], ['succeeded', 'status', false, false],
    ['denied', 'alert', false, true], ['failed', 'alert', false, true],
    ['unavailable', 'alert', false, true], ['conflict', 'alert', false, true],
  ] as const)('retains %s accessibility, busy state and default draft policy', (state, role, busy, preserveDraft) => {
    const view = projectActionState({ state })
    expect(view).toMatchObject({ state, role, live: role === 'alert' ? 'assertive' : 'polite', busy, preserveDraft, retryable: false })
    expect(view.title.length).toBeGreaterThan(0)
    expect(view.message.length).toBeGreaterThan(0)
  })

  it('does not upgrade accepted work to verified success and retains explicit retry and draft decisions', () => {
    const view = projectActionState({ state: 'pending', httpStatus: 202, retryable: true, preserveDraft: false })
    expect(view).toMatchObject({ state: 'pending', busy: true, retryable: true, preserveDraft: false })
    expect(view.badge.text).toBe('Queued / Reconciling')
    expect(view.message).toContain('not yet active')
  })

  it('preserves caller text as plain data with ASCII digits rather than generating HTML', () => {
    const view = projectActionState({ state: 'failed', title: '<unsafe title>', message: 'Original message 409', errorCode: 'STALE_REVISION' })
    expect(view.title).toBe('<unsafe title>')
    expect(view.message).toBe('Original message 409')
    expect(view.metadata).toEqual([{ kind: 'error', value: 'STALE_REVISION' }])
    const html = renderAsyncActionState({ state: 'failed', title: view.title, message: view.message })
    expect(html).toContain('&lt;unsafe title&gt;')
    expect(html).not.toContain('<unsafe title>')
  })

  it('retains ordered generation, HTTP and error facts', () => {
    expect(projectActionState({ state: 'conflict', generationId: 142, httpStatus: 409, errorCode: 'CONFLICT' }).metadata).toEqual([
      { kind: 'generation', label: 'Generation', value: '#142' },
      { kind: 'http', value: 'HTTP 409' },
      { kind: 'error', value: 'CONFLICT' },
    ])
  })
})

describe('official job reference feedback', () => {
  it.each([undefined, '', '   '])('never uses an internal UUID as a visible reference when official code is %s', jobReferenceCode => {
    const props = { state: 'pending' as const, jobId: internalId, jobReferenceCode }
    const view = projectActionState(props)
    expect(view.internalJobId).toBe(internalId)
    expect(view.metadata).toEqual([{ kind: 'job-reference', label: 'Job Ref', value: 'Unnumbered' }])
    expect(JSON.stringify(view.metadata)).not.toContain(internalId)
    const html = renderAsyncActionState(props)
    expect(html).toContain('Job Ref: <code class="xp-mono"><bdi dir="ltr">Unnumbered</bdi></code>')
    expect(html).not.toContain(internalId)
  })

  it('shows the persisted official reference unchanged, with or without an internal ID', () => {
    for (const jobId of [internalId, undefined]) {
      const view = projectActionState({ state: 'pending', jobId, jobReferenceCode: officialReference })
      expect(view.metadata[0]).toEqual({ kind: 'job-reference', label: 'Job Ref', value: officialReference })
      expect(renderAsyncActionState({ state: 'pending', jobId, jobReferenceCode: officialReference }))
        .toContain(`<bdi dir="ltr">${officialReference}</bdi>`)
    }
  })

  it('keeps an explicitly supplied blank official reference visibly unnumbered', () => {
    expect(projectActionState({ state: 'pending', jobReferenceCode: '' }).metadata)
      .toEqual([{ kind: 'job-reference', label: 'Job Ref', value: 'Unnumbered' }])
    expect(projectActionState({ state: 'pending' }).metadata).toEqual([])
  })

  it.each(['en', 'ar'] as const)('renders all feedback states with isolated official references and ASCII digits in %s', locale => {
    for (const state of ['idle', 'loading', 'pending', 'succeeded', 'denied', 'failed', 'unavailable', 'conflict'] satisfies AsyncActionStateKind[]) {
      const html = renderAsyncActionState({ state, locale, jobId: internalId, jobReferenceCode: officialReference, generationId: 142, httpStatus: 409 })
      expect(html).toContain(`<bdi dir="ltr">${officialReference}</bdi>`)
      expect(html).toContain('<bdi dir="ltr">#142</bdi>')
      expect(html).not.toContain(internalId)
      expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    }
    if (locale === 'ar') {
      expect(renderAsyncActionState({ state: 'pending', locale, jobId: internalId })).toContain('غير مرقمة')
    }
  })
})
