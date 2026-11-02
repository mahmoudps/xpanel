import { describe, expect, it } from 'vitest'
import { projectActionState } from '../../../models/action-state.ts'
import type { AsyncActionStateKind } from '../../../models/action-state.ts'
import { actionState } from './action-state.ts'

describe('v2 action feedback', () => {
  const states: readonly AsyncActionStateKind[] = ['idle', 'loading', 'pending', 'succeeded', 'denied', 'failed', 'unavailable', 'conflict']
  it.each(states)('preserves the actual %s state and announcement semantics from core', state => {
    const view = projectActionState({ state })
    const html = actionState(view)
    expect(html).toContain(`data-action-state="${state}"`)
    expect(html).toContain(`role="${view.role}"`)
    expect(html).toContain(`aria-live="${view.live}"`)
    expect(html).toContain(`aria-busy="${view.busy}"`)
    expect(html).toContain(`data-preserve-draft="${view.preserveDraft}"`)
    expect(html).toContain('data-deceptive-success="false"')
  })

  it('keeps accepted work pending instead of claiming host verification', () => {
    const html = actionState(projectActionState({ state: 'pending' }))
    expect(html).toContain('Operation accepted and pending host verification')
    expect(html).not.toContain('Operation verified on host')
    expect(html).not.toContain('Verified &amp; Applied')
  })

  it('shows the official job reference and never leaks the internal routing identity', () => {
    const internal = '7be08535-f978-42a9-a6d7-c7b25bc2f44e'
    const html = actionState(projectActionState({ state: 'failed', jobId: internal, jobReferenceCode: 'JOB-2026-000021', generationId: 142, httpStatus: 409, errorCode: 'resource_locked' }))
    expect(html).toContain('JOB-2026-000021')
    expect(html).toContain('#142')
    expect(html).toContain('HTTP 409')
    expect(html).toContain('resource_locked')
    expect(html).not.toContain(internal)
    expect(html).not.toContain('internalJobId')
  })

  it('keeps an unnumbered job explicit without falling back to any part of its internal ID', () => {
    const html = actionState(projectActionState({ state: 'pending', jobId: '7be08535-f978-42a9-a6d7-c7b25bc2f44e' }))
    expect(html).toContain('Unnumbered')
    expect(html).not.toContain('7be08535')
  })

  it('preserves explicit draft and retry metadata without inventing a retry operation', () => {
    const html = actionState(projectActionState({ state: 'failed', retryable: true, preserveDraft: false }))
    expect(html).toContain('data-retryable="true"')
    expect(html).toContain('data-preserve-draft="false"')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<a ')
  })

  it('escapes all caller-authored feedback and metadata as text', () => {
    const html = actionState(projectActionState({ state: 'failed', title: '<img src=x>', message: '<script>alert(1)</script>', jobReferenceCode: 'JOB-<b>2</b>', errorCode: 'bad" onmouseover="x' }))
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('JOB-&lt;b&gt;2&lt;/b&gt;')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain(' onmouseover="x')
  })

  it('uses Arabic core messages with ASCII digits and inline isolated metadata', () => {
    const html = actionState(projectActionState({ state: 'conflict', locale: 'ar', generationId: 142, httpStatus: 409 }))
    expect(html).toContain('dir="ltr">#142</bdi>')
    expect(html).toContain('dir="ltr">HTTP 409</bdi>')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
