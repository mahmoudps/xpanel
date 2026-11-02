import { describe, expect, it } from 'vitest'
import { matchesHook, parseMarkup } from './markup.ts'
import { checkControllerDeclarations, type ControllerDeclaration } from './controller-conformance.ts'

const context = { route: '/home', surface: 'xpanel' as const, qualified: true }
const declaration = (overrides: Partial<ControllerDeclaration> = {}): ControllerDeclaration => ({
  id: 'test-controller',
  rootSelector: '[data-controller]',
  applicableRoutes: ['/home'],
  requiredSelectors: ['[data-save]'],
  ...overrides,
})
const check = (html: string, declarations: readonly ControllerDeclaration[] = [declaration()]) =>
  checkControllerDeclarations(parseMarkup(html), declarations, context)
const missing = (html: string, selector: string, declarations: readonly ControllerDeclaration[] = [declaration()]) =>
  check(html, declarations).some(issue => issue.name === selector)

describe('authoritative controller requirements', () => {
  it('accepts the declared live control without deriving authority from an observation snapshot', () => {
    expect(check('<section data-controller><button data-save type="button"></button></section>')).toEqual([])
  })

  it('reports a required control even when the document never contained that hook', () => {
    expect(missing('<section data-controller><p>Read only</p></section>', '[data-save]')).toBe(true)
  })

  it('requires the entire centrally declared controller root on its admitted route', () => {
    expect(check('<main><button data-save></button></main>').some(issue => issue.kind === 'controller')).toBe(true)
  })

  it('does not accept an unrelated matching control outside the controller root', () => {
    expect(missing('<button data-save></button><section data-controller></section>', '[data-save]')).toBe(true)
  })

  it('permits a genuinely optional empty collection', () => {
    const rule = declaration({ requiredSelectors: ['[data-status]'], optionalSelectors: ['[data-row]'] })
    expect(check('<section data-controller><p data-status></p></section>', [rule])).toEqual([])
  })

  it('checks a state row when mounted while allowing the initial empty state', () => {
    const rule = declaration({
      requiredSelectors: [],
      nestedScopes: [{ id: 'state-row', rootSelector: '[data-row]', rootRequired: false, requiredSelectors: ['[data-name]'] }],
    })
    expect(check('<section data-controller></section>', [rule])).toEqual([])
    expect(missing('<section data-controller><article data-row></article></section>', '[data-name]', [rule])).toBe(true)
  })

  it('checks only the mounted finite variant instead of requiring every variant at once', () => {
    const rule = declaration({
      requiredSelectors: [],
      variants: [
        { id: 'apps', rootSelector: '[data-kind="apps"]', rootRequired: false, requiredSelectors: ['[data-deploy]'] },
        { id: 'cache', rootSelector: '[data-kind="cache"]', rootRequired: false, requiredSelectors: ['[data-flush]'] },
      ],
    })
    expect(check('<section data-controller><div data-kind="apps"><button data-deploy></button></div></section>', [rule])).toEqual([])
    expect(missing('<section data-controller><div data-kind="cache"></div></section>', '[data-flush]', [rule])).toBe(true)
  })

  it('keeps a denied read state distinct from a missing control in an active workspace', () => {
    const rule = declaration({ rootAttributeExclusions: { 'data-read-state': 'denied' } })
    expect(check('<section data-controller data-read-state="denied"></section>', [rule])).toEqual([])
    expect(missing('<section data-controller data-read-state="ready"></section>', '[data-save]', [rule])).toBe(true)
  })
})

describe('selected control semantics', () => {
  it('rejects a same-named hook on the wrong element type', () => {
    const rule = declaration({ requiredSelectors: [], elements: [{ selector: '[data-mode]', tags: ['select'] }] })
    expect(check('<section data-controller><select data-mode></select></section>', [rule])).toEqual([])
    expect(check('<section data-controller><input data-mode type="text"></section>', [rule]).some(issue => issue.kind === 'element')).toBe(true)
  })

  it('requires the checkbox type actually used by the controller', () => {
    const rule = declaration({
      requiredSelectors: [],
      elements: [{ selector: '[data-websocket]', tags: ['input'], attributes: { type: 'checkbox' } }],
    })
    const good = '<section data-controller><input data-websocket type="checkbox"></section>'
    expect(check(good, [rule])).toEqual([])
    expect(check(good.replace('type="checkbox"', 'type="text"'), [rule]).some(issue => issue.kind === 'element')).toBe(true)
  })

  it('distinguishes the first selected control from an explicit every-match requirement', () => {
    const html = '<section data-controller><button data-run type="button"></button><span data-run></span></section>'
    const first = declaration({ requiredSelectors: [], elements: [{ selector: '[data-run]', tags: ['button'], attributes: { type: 'button' } }] })
    const every = declaration({ requiredSelectors: [], elements: [{ selector: '[data-run]', tags: ['button'], attributes: { type: 'button' }, occurrence: 'every' }] })
    expect(check(html, [first])).toEqual([])
    expect(check(html, [every]).some(issue => issue.kind === 'element')).toBe(true)
  })
})

describe('controller query scopes', () => {
  it('supports the explicitly declared ancestor lookup without admitting an unrelated external result', () => {
    const rule = declaration({ lookupScope: { kind: 'closest', selector: '[data-page]' }, requiredSelectors: ['[data-summary]'] })
    expect(check('<main data-page><p data-summary></p><section data-controller></section></main>', [rule])).toEqual([])
    expect(missing('<p data-summary></p><main data-page><section data-controller></section></main>', '[data-summary]', [rule])).toBe(true)
  })

  it('limits a descendant lookup to its declared child card', () => {
    const rule = declaration({ lookupScope: { kind: 'descendant', selector: '[data-card]' } })
    expect(check('<section data-controller><article data-card><button data-save></button></article></section>', [rule])).toEqual([])
    expect(missing('<section data-controller><button data-save></button><article data-card></article></section>', '[data-save]', [rule])).toBe(true)
  })

  it('allows a deliberate document-level projection outside the controller root', () => {
    const rule = declaration({ lookupScope: { kind: 'document' }, requiredSelectors: ['#page-summary'] })
    expect(check('<p id="page-summary"></p><section data-controller></section>', [rule])).toEqual([])
  })

  it('requires a controller form to remain inside its declared workspace', () => {
    const rule = declaration({ rootSelector: '[data-form]', parentRootSelector: '[data-workspace]' })
    expect(check('<main data-workspace><form data-form><button data-save></button></form></main>', [rule])).toEqual([])
    expect(check('<main data-workspace></main><form data-form><button data-save></button></form>', [rule]).length).toBeGreaterThan(0)
  })

  it('matches compound attribute and descendant semantics rather than independent global fragments', () => {
    const rule = declaration({ requiredSelectors: ['[data-time] time', 'input[name="host"][type="text"]'] })
    const good = '<section data-controller><p data-time><time></time></p><input name="host" type="text"></section>'
    expect(check(good, [rule])).toEqual([])
    expect(check(good.replace('<p data-time><time></time></p>', '<p data-time></p><time></time>'), [rule]).length).toBeGreaterThan(0)
    expect(check(good.replace('type="text"', 'type="checkbox"'), [rule]).length).toBeGreaterThan(0)
  })
})

describe('finite pager collections', () => {
  it('requires previous and next across the scoped collection rather than inside every button', () => {
    const rule = declaration({
      requiredSelectors: [],
      perMatchRequired: [{ selector: '[data-page="compare"]', eachAttributes: { 'data-direction': ['previous', 'next'] } }],
    })
    const good = '<section data-controller><button data-page="compare" data-direction="previous"></button><button data-page="compare" data-direction="next"></button></section>'
    expect(check(good, [rule])).toEqual([])
    expect(check(good.replace('<button data-page="compare" data-direction="next"></button>', ''), [rule]).length).toBeGreaterThan(0)
  })
})

describe('template projections', () => {
  const rule = declaration({
    requiredSelectors: [],
    templateScopes: [{ templateSelector: '[data-row-template]', requiredSelectors: ['[data-xp-slot="name"]'] }],
  })

  it('finds a slot in the owning template content', () => {
    expect(check('<section data-controller><template data-row-template><span data-xp-slot="name"></span></template></section>', [rule])).toEqual([])
  })

  it('does not satisfy a template slot with live markup or another template', () => {
    const html = '<section data-controller><span data-xp-slot="name"></span><template data-row-template></template><template data-other><span data-xp-slot="name"></span></template></section>'
    expect(missing(html, '[data-xp-slot="name"]', [rule])).toBe(true)
  })

  it('checks every copy of a template because any copy may be cloned', () => {
    const html = '<section data-controller><template data-row-template><span data-xp-slot="name"></span></template><template data-row-template></template></section>'
    expect(missing(html, '[data-xp-slot="name"]', [rule])).toBe(true)
  })

  it('does not treat a nested template content as part of its outer fragment', () => {
    const html = '<section data-controller><template data-row-template><template data-nested><span data-xp-slot="name"></span></template></template></section>'
    expect(missing(html, '[data-xp-slot="name"]', [rule])).toBe(true)
  })

  it('does not accept an owning template placed outside its controller', () => {
    const html = '<section data-controller></section><template data-row-template><span data-xp-slot="name"></span></template>'
    expect(check(html, [rule]).length).toBeGreaterThan(0)
  })
})

describe('conditional requirements', () => {
  const rule = declaration({
    requiredSelectors: ['[name="username"]', '[name="password"]'],
    conditionalRequirements: [{
      documentAttributes: { 'data-mfa-mode': { not: 'disabled' } },
      requiredSelectors: ['[name="totpCode"]', '[name="recoveryCode"]'],
    }],
  })
  const fields = '<form data-controller><input name="username"><input name="password"></form>'

  it('does not require omitted factor fields in the explicit disabled mode', () => {
    expect(check(`<html data-mfa-mode="disabled"><body>${fields}</body></html>`, [rule])).toEqual([])
  })

  it('requires the factor fields in the optional enrollment mode', () => {
    const issues = check(`<html data-mfa-mode="optional"><body>${fields}</body></html>`, [rule])
    expect(issues.some(issue => issue.name === '[name="totpCode"]')).toBe(true)
    expect(issues.some(issue => issue.name === '[name="recoveryCode"]')).toBe(true)
  })

  it('checks a conditional form only after its owning section is mounted', () => {
    const conditional = declaration({
      requiredSelectors: [],
      conditionalRequirements: [{ whenScopeMounted: '[data-editor]', requiredSelectors: ['[data-confirm]'] }],
    })
    expect(check('<section data-controller></section>', [conditional])).toEqual([])
    expect(missing('<section data-controller><form data-editor></form></section>', '[data-confirm]', [conditional])).toBe(true)
  })
})

describe('ID and control relationships', () => {
  const passwordRule = declaration({
    requiredSelectors: [],
    relations: [{
      ownerSelector: '[data-reveal]',
      idAttribute: 'data-target',
      sameIdAttributes: ['aria-controls'],
      targetTag: 'input',
      targetName: 'password',
      targetTypes: ['password', 'text'],
      targetAutocomplete: 'new-password',
      sameForm: '[data-owner-form]',
      targetMustBeUnique: true,
    }],
  })
  const password = (type = 'password') => `<section data-controller><form data-owner-form><button data-reveal data-target="new-password" aria-controls="new-password"></button><input id="new-password" name="password" type="${type}" autocomplete="new-password"></form></section>`

  it.each(['password', 'text'])('accepts the authorized %s input in its owning form', type => {
    expect(check(password(type), [passwordRule])).toEqual([])
  })

  it('does not count an ID in inert template content as a second live target', () => {
    const inert = '<template><input id="new-password" name="password" type="password" autocomplete="new-password"></template>'
    expect(check(password() + inert, [passwordRule])).toEqual([])
  })

  it('preserves a legitimate disabled or read-only control state', () => {
    const html = password().replace('autocomplete="new-password"', 'autocomplete="new-password" disabled readonly')
    expect(check(html, [passwordRule])).toEqual([])
  })

  it('rejects a duplicate ID even when one matching input has correct semantics', () => {
    expect(check(password() + '<input id="new-password" name="password" type="password" autocomplete="new-password">', [passwordRule]).some(issue => issue.kind === 'relation')).toBe(true)
  })

  it('rejects a target in a different form', () => {
    const html = '<section data-controller><form data-owner-form><button data-reveal data-target="new-password" aria-controls="new-password"></button></form><form data-owner-form><input id="new-password" name="password" type="password" autocomplete="new-password"></form></section>'
    expect(check(html, [passwordRule]).some(issue => issue.kind === 'relation')).toBe(true)
  })

  it.each([
    ['type="password"', 'type="checkbox"'],
    ['name="password"', 'name="other"'],
    ['autocomplete="new-password"', 'autocomplete="off"'],
  ])('rejects a target whose %s constraint is lost', (before, after) => {
    expect(check(password().replace(before, after), [passwordRule]).some(issue => issue.kind === 'relation' || issue.kind === 'element')).toBe(true)
  })

  it('requires the accessibility reference and the actual lookup target to agree', () => {
    expect(check(password().replace('aria-controls="new-password"', 'aria-controls="another"'), [passwordRule]).some(issue => issue.kind === 'relation')).toBe(true)
  })

  it('keeps an ARIA-controlled target inside the owning root', () => {
    const panelRule = declaration({
      requiredSelectors: [],
      relations: [{ ownerSelector: '[data-toggle]', idAttribute: 'aria-controls', targetTag: 'ul', targetHook: '[data-panel]', sameRoot: '[data-controller]', targetMustBeUnique: true }],
    })
    const good = '<section data-controller><button data-toggle aria-controls="group-tools"></button><ul id="group-tools" data-panel></ul></section>'
    expect(check(good, [panelRule])).toEqual([])
    expect(check('<section data-controller><button data-toggle aria-controls="group-tools"></button></section><ul id="group-tools" data-panel></ul>', [panelRule]).some(issue => issue.kind === 'relation')).toBe(true)
  })
})

describe('keyed reading projections', () => {
  const rule = declaration({
    requiredSelectors: [],
    keyedTargets: [{ fromSelector: '[data-open]', fromAttribute: 'data-open', templateSelector: '#reading-store', targetSelector: '[data-reading-id]', targetAttribute: 'data-reading-id' }],
  })

  it('allows an empty message collection without inventing a reading pane', () => {
    expect(check('<section data-controller><template id="reading-store"></template></section>', [rule])).toEqual([])
  })

  it('binds each loaded message to the matching pane in the owning template', () => {
    const good = '<section data-controller><button data-open="m1"></button><template id="reading-store"><article data-reading-id="m1"></article></template></section>'
    expect(check(good, [rule])).toEqual([])
    expect(check(good.replace('data-reading-id="m1"', 'data-reading-id="m2"'), [rule]).some(issue => issue.kind === 'relation')).toBe(true)
  })

  it('does not use a live or unrelated-template pane to satisfy the keyed relation', () => {
    const html = '<section data-controller><button data-open="m1"></button><article data-reading-id="m1"></article><template id="reading-store"></template><template data-other><article data-reading-id="m1"></article></template></section>'
    expect(check(html, [rule]).some(issue => issue.kind === 'relation')).toBe(true)
  })
})

describe('optional typed controls', () => {
  it('allows absence but checks the semantics of an optional control when mounted', () => {
    const rule = declaration({
      requiredSelectors: [],
      elements: [{ selector: '[data-optional-control]', tags: ['input'], attributes: { type: 'checkbox' }, required: false }],
    })
    expect(check('<section data-controller></section>', [rule])).toEqual([])
    expect(check('<section data-controller><input data-optional-control type="checkbox"></section>', [rule])).toEqual([])
    expect(check('<section data-controller><input data-optional-control type="text"></section>', [rule]).some(issue => issue.kind === 'element')).toBe(true)
    expect(check('<section data-controller><span data-optional-control></span></section>', [rule]).some(issue => issue.kind === 'element')).toBe(true)
  })
})

describe('conditional typed controls', () => {
  it('checks a typed field only in the source-declared active kind', () => {
    const rule = declaration({
      requiredSelectors: [],
      conditionalRequirements: [{
        rootAttributes: { 'data-kind': 'cache' },
        elements: [{ selector: '[data-cache-size]', tags: ['input'], attributes: { type: 'number' } }],
      }],
    })
    expect(check('<section data-controller data-kind="apps"></section>', [rule])).toEqual([])
    expect(check('<section data-controller data-kind="cache"><input data-cache-size type="number"></section>', [rule])).toEqual([])
    expect(check('<section data-controller data-kind="cache"><input data-cache-size type="text"></section>', [rule]).some(issue => issue.kind === 'element')).toBe(true)
    expect(check('<section data-controller data-kind="cache"></section>', [rule]).some(issue => issue.kind === 'element')).toBe(true)
  })
})

describe('fail-closed metadata', () => {
  it('names unsupported required selector grammar instead of counting it as satisfied', () => {
    const rule = declaration({ requiredSelectors: ['[data-save]:has(*)'] })
    expect(() => check('<section data-controller><button data-save></button></section>', [rule])).toThrow(/unsupported.*selector|selector.*unsupported/i)
  })

  it('rejects an unsupported pseudo-selector even behind an unmounted optional root', () => {
    const rule = declaration({ rootRequired: false, requiredSelectors: ['input:disabled'] })
    expect(() => check('<main></main>', [rule])).toThrow(/unsupported.*selector|selector.*unsupported/i)
  })

  it('validates an anchored target ID policy before an optional owner can be skipped', () => {
    const rule = declaration({
      rootRequired: false,
      relations: [{ ownerSelector: '[data-toggle]', idAttribute: 'aria-controls', targetIdPattern: 'panel-[0-9]+' }],
    })
    expect(() => check('<main></main>', [rule])).toThrow(/unsupported.*(?:pattern|relation)|(?:pattern|relation).*unsupported/i)
  })

  it('validates inactive conditional branches even when the optional root is not mounted', () => {
    const rule = declaration({
      rootRequired: false,
      conditionalRequirements: [{ unsupportedCondition: true, requiredSelectors: ['[data-guarded]'] }],
    } as unknown as Partial<ControllerDeclaration>)
    expect(() => check('<main></main>', [rule])).toThrow(/unsupported.*condition|condition.*unsupported/i)
  })

  it('rejects an unknown condition instead of silently dropping its requirement', () => {
    const rule = declaration({
      conditionalRequirements: [{ unsupportedCondition: true, requiredSelectors: ['[data-guarded]'] }],
    } as unknown as Partial<ControllerDeclaration>)
    expect(() => check('<section data-controller><button data-save></button></section>', [rule])).toThrow(/unsupported.*condition|condition.*unsupported/i)
  })
})


describe('live HTML control identity', () => {
  const buttonRule = declaration({
    elements: [{ selector: '[data-save]', tags: ['button'], attributes: { type: 'button' } }],
  })

  it('does not count a scripting-enabled noscript fallback as a live control', () => {
    const html = '<section data-controller><noscript><button data-save type="button"></button></noscript></section>'
    expect(check(html, [buttonRule]).length).toBeGreaterThan(0)
  })

  it('does not end a noscript fallback at a longer closing-tag name', () => {
    const html = '<section data-controller><noscript></noscript-extra><button data-save type="button"></button></noscript></section>'
    expect(check(html, [buttonRule]).length).toBeGreaterThan(0)
  })

  it('rejects a same-named SVG button where an HTML button is required', () => {
    const html = '<section data-controller><svg><button data-save type="button"></button></svg></section>'
    expect(check(html, [buttonRule]).some(issue => issue.kind === 'element')).toBe(true)
  })

  it('rejects a same-named MathML button where an HTML button is required', () => {
    const html = '<section data-controller><math><button data-save type="button"></button></math></section>'
    expect(check(html, [buttonRule]).some(issue => issue.kind === 'element')).toBe(true)
  })

  it('accepts an HTML control inside the SVG foreignObject integration point', () => {
    const html = '<section data-controller><svg><foreignObject><button data-save type="button"></button></foreignObject></svg></section>'
    expect(check(html, [buttonRule])).toEqual([])
  })

  it('accepts an HTML control inside a MathML text integration point', () => {
    const html = '<section data-controller><math><mtext><button data-save type="button"></button></mtext></math></section>'
    expect(check(html, [buttonRule])).toEqual([])
  })

  it('does not let an ordinary xmlns attribute change an HTML control namespace', () => {
    const html = '<section data-controller><button xmlns="http://www.w3.org/2000/svg" data-save type="button"></button></section>'
    expect(check(html, [buttonRule])).toEqual([])
  })

  it('preserves genuine SVG data hooks without treating them as typed HTML controls', () => {
    const nodes = parseMarkup('<svg data-icon><path data-icon-part></path></svg>')
    expect(matchesHook(nodes[1]!, '[data-icon-part]')).toBe(true)
  })

  it('does not treat an SVG template element as an HTMLTemplateElement', () => {
    const rule = declaration({ requiredSelectors: [], templateScopes: [{ templateSelector: '[data-row-template]', requiredSelectors: ['[data-name]'] }] })
    const html = '<section data-controller><svg><template data-row-template><foreignObject><span data-name></span></foreignObject></template></svg></section>'
    expect(check(html, [rule]).some(issue => issue.kind === 'element')).toBe(true)
  })

  it('requires an HTML namespace for a typed input lookup by ID', () => {
    const rule = declaration({
      requiredSelectors: [],
      relations: [{ ownerSelector: '[data-reveal]', idAttribute: 'data-target', targetTag: 'input', targetName: 'password', targetTypes: ['password'] }],
    })
    const html = '<section data-controller><button data-reveal data-target="secret"></button><svg><input id="secret" name="password" type="password" /></svg></section>'
    expect(check(html, [rule]).some(issue => issue.kind === 'relation')).toBe(true)
  })
})

describe('nested template fragment membership', () => {
  it('retains descendants through intermediate template-content ancestors', () => {
    const rule = declaration({ requiredSelectors: [], templateScopes: [{ templateSelector: '[data-row-template]', requiredSelectors: ['[data-name]'] }] })
    const html = '<section data-controller><template data-row-template><li><button><span data-name></span></button></li></template></section>'
    expect(check(html, [rule])).toEqual([])
  })
})


describe('source-provided controller facts', () => {
  const rule = declaration({
    requiredSelectors: [],
    conditionalRequirements: [{
      rootAttributes: { 'data-manage': 'true' },
      contextFacts: { 'account-domains': 'present' },
      requiredSelectors: ['form[data-domain-form]'],
    }],
  })
  const managed = '<section data-controller data-manage="true"></section>'
  const withFacts = (html: string, facts?: Record<string, 'present' | 'absent'>) =>
    checkControllerDeclarations(parseMarkup(html), [rule], { ...context, ...(facts ? { facts } : {}) })

  it('does not request a context fact when the management condition is inactive', () => {
    expect(withFacts('<section data-controller data-manage="false"></section>')).toEqual([])
  })

  it('reports a missing source fact for an applicable management condition', () => {
    expect(() => withFacts(managed)).toThrow(/MISSING_CONTROLLER_CONTEXT_FACT.*account-domains/)
  })

  it('permits an absent form when the source domain list is absent', () => {
    expect(withFacts(managed, { 'account-domains': 'absent' })).toEqual([])
  })

  it('requires the form when the source domain list is present', () => {
    expect(withFacts(managed, { 'account-domains': 'present' }).some(issue => issue.name === 'form[data-domain-form]')).toBe(true)
    expect(withFacts('<section data-controller data-manage="true"><form data-domain-form></form></section>', { 'account-domains': 'present' })).toEqual([])
  })

  it('rejects an unknown provided fact instead of treating it as an absent domain list', () => {
    expect(() => withFacts(managed, { 'account-domains': 'unknown' } as unknown as Record<string, 'present' | 'absent'>)).toThrow(/INVALID_CONTROLLER_CONTEXT_FACT.*account-domains/)
  })

  it('rejects a provided undefined fact value instead of silently skipping the condition', () => {
    expect(() => withFacts(managed, { 'account-domains': undefined } as unknown as Record<string, 'present' | 'absent'>)).toThrow(/INVALID_CONTROLLER_CONTEXT_FACT.*account-domains/)
  })

  it('validates expected fact values even in an inactive branch', () => {
    const invalid = declaration({
      rootRequired: false,
      conditionalRequirements: [{ rootAttributes: { 'data-manage': 'true' }, contextFacts: { 'account-domains': 'maybe' }, requiredSelectors: ['form[data-domain-form]'] }],
    } as unknown as Partial<ControllerDeclaration>)
    expect(() => check('<main></main>', [invalid])).toThrow(/unsupported.*contextFacts/i)
  })

  it('rejects an empty fact key before an optional root can be skipped', () => {
    const invalid = declaration({ rootRequired: false, conditionalRequirements: [{ contextFacts: { '': 'present' } }] })
    expect(() => check('<main></main>', [invalid])).toThrow(/unsupported.*contextFacts/i)
  })

  it.each([{ contextFacts: null }, { contextFacts: ['present'] }, { contextFacts: 'present' }])('rejects a non-record fact declaration $contextFacts in an inactive branch', ({ contextFacts }) => {
    const invalid = declaration({ rootRequired: false, conditionalRequirements: [{ contextFacts }] } as unknown as Partial<ControllerDeclaration>)
    expect(() => check('<main></main>', [invalid])).toThrow(/unsupported.*contextFacts/i)
  })

  it('checks every requested fact before deciding that a supplied mismatch deactivates the condition', () => {
    const both = declaration({ requiredSelectors: [], conditionalRequirements: [{ rootAttributes: { 'data-manage': 'true' }, contextFacts: { 'account-domains': 'present', 'source-config': 'present' }, requiredSelectors: ['form[data-domain-form]'] }] })
    expect(() => checkControllerDeclarations(parseMarkup(managed), [both], { ...context, facts: { 'account-domains': 'absent' } })).toThrow(/MISSING_CONTROLLER_CONTEXT_FACT.*source-config/)
  })
})
