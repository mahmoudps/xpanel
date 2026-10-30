import { describe, expect, it } from 'vitest'
import { assertControllerReviewMappings, assertSelectorReview, nonliteralSelectorSites, selectorSourceDigest } from './theme-controller-audit.mjs'
import type { SelectorSourceReview } from '../apps/web/src/themes/selector-audit-data.ts'

const path = 'apps/web/src/synthetic-client.ts'
const reviewed = (source: string): SelectorSourceReview => ({
  path, sha256: selectorSourceDigest(source), sites: nonliteralSelectorSites(source).map(site => ({
    ...site, classification: 'finite-required-controls', controllers: ['synthetic-controller'],
  })),
})

describe('controller source classifications', () => {
  it('counts all five selector APIs without treating literals, comments or regular expressions as sites', () => {
    const source = `function bind(root, key, guard, id) {
      root.querySelector('[data-part-' + key + ']')
      root.querySelectorAll(key)
      root.closest(guard)
      root.matches(guard)
      document.getElementById(id)
      root.querySelector('[data-literal]')
      // root.querySelector(unreviewed)
      const example = /querySelector(fake)/
    }`
    expect(nonliteralSelectorSites(source).map(site => site.method)).toEqual([
      'querySelector', 'querySelectorAll', 'closest', 'matches', 'getElementById',
    ])
    expect(assertSelectorReview(path, source, reviewed(source))).toHaveLength(5)
  })

  it('preserves source coordinates for embedded browser templates and distinguishes lexical helper sites', () => {
    const source = 'function first(root,key){return root.querySelector(key)}\n'
      + 'const script = `<script>function second(root,key){return root.querySelector(key)}</script>`'
    const sites = nonliteralSelectorSites(source)
    expect(sites).toHaveLength(2)
    expect(sites[0]!.line).toBe(1)
    expect(sites[1]!.line).toBe(2)
    expect(sites[0]!.offset).not.toBe(sites[1]!.offset)
  })

  it('fails when a required helper changes even if its missing control has never appeared in rendered markup', () => {
    const source = "function bind(root,key){return root.querySelector('[data-part-' + key + ']')}"
    const review = reviewed(source)
    const changed = source + "; bind(root,'new-required-control')"
    expect(() => assertSelectorReview(path, changed, review)).toThrow(/SELECTOR_SOURCE_DRIFT/)
  })

  it('fails on unclassified new sites and on classifications that silently disappear', () => {
    const source = 'function bind(root,key){return root.querySelector(key)}'
    const review = reviewed(source)
    expect(() => assertSelectorReview(path, source, undefined)).toThrow(/UNCLASSIFIED_SELECTOR_SOURCE/)
    expect(() => assertSelectorReview(path, source, { ...review, sites: [] })).toThrow(/UNCLASSIFIED_SELECTOR_SITE/)
    expect(() => assertSelectorReview(path, '', { ...review, sha256: selectorSourceDigest('') })).toThrow(/STALE_SELECTOR_CLASSIFICATION/)
  })

  it('fails when a classified controller loses its independently authored required scope', () => {
    const source = "function find(root,key){return root.querySelector('[data-part-' + key + ']')}"
    const review = reviewed(source)
    const declaration = { id: 'synthetic-controller', rootSelector: '[data-controller]', requiredSelectors: ['[data-part-save]'] }
    expect(() => assertControllerReviewMappings([review], [declaration])).not.toThrow()
    expect(() => assertControllerReviewMappings([review], [])).toThrow(/MISSING_CONTROLLER_DECLARATION/)
    expect(() => assertControllerReviewMappings([review], [declaration, declaration])).toThrow(/DUPLICATE_CONTROLLER_DECLARATION/)
    const policy = { ...review, sites: review.sites.map(site => ({ ...site, controllers: ['ancestor-eligibility-policy'] })) }
    expect(() => assertControllerReviewMappings([policy], [])).toThrow(/MISSING_CONTROLLER_DECLARATION/)
    const eligibility = { ...policy, sites: policy.sites.map(site => ({ ...site, classification: 'literal-ineligibility-ancestor-policy' })) }
    expect(() => assertControllerReviewMappings([eligibility], [])).not.toThrow()
  })

  it('rejects duplicate or empty decisions and is portable across CRLF/LF checkouts', () => {
    const source = 'function bind(root,key){\nreturn root.querySelector(key)\n}'
    const review = reviewed(source)
    expect(assertSelectorReview(path, source.replaceAll('\n', '\r\n'), review)).toHaveLength(1)
    expect(() => assertSelectorReview(path, source, { ...review, sites: [...review.sites, ...review.sites] })).toThrow(/INVALID_SELECTOR_CLASSIFICATION/)
    expect(() => assertSelectorReview(path, source, { ...review, sites: review.sites.map(site => ({ ...site, classification: '' })) })).toThrow(/INVALID_SELECTOR_CLASSIFICATION/)
  })
})
