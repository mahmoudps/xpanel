// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOME_SCRIPT } from './board-port/xpanel-home.ts'
import { HOME_TOOL_MATCHING_FUNCTIONS, HOME_TOOLS_CLIENT_BINDING, homeToolMatches, normalizeHomeToolQuery } from './home-tools-client.ts'

const markup = `<main data-panel-home><label for="tool-filter">Tools</label><input id="tool-filter" type="search" data-home-filter><span id="tool-filter-count" role="status" data-rest="5 tools in 3 groups">5 tools in 3 groups</span><div data-tool-section>
<details open data-tool-group data-home-accordion data-home-collapse-below="600" data-group-label="Files" data-size="2"><summary>Files <span data-group-count data-rest="2 tools">2 tools</span></summary><div data-tool-panel><a data-tool data-tool-keys="File manager browse editor" href="/files/manager">File manager</a><a data-tool data-tool-keys="Trash restore" href="/files/trash">Trash</a></div></details>
<details open data-tool-group data-home-accordion data-home-collapse-below="600" data-group-label="Email البريد" data-size="2"><summary>Email <span data-group-count data-rest="2 tools">2 tools</span></summary><div data-tool-panel><button type="button" disabled data-tool data-tool-keys="Email accounts SMTP IMAP">Email accounts</button><a data-tool data-tool-keys="Forwarders redirect" href="/email/forwarders">Forwarders</a></div></details>
<details open data-tool-group data-home-accordion data-home-collapse-below="600" data-group-label="Domains" data-size="1"><summary>Domains <span data-group-count data-rest="1 tool">1 tool</span></summary><div data-tool-panel><a data-tool data-tool-keys="DNS zone editor" href="/domains/zone-editor">Zone editor</a></div></details></div>
<section data-tool-empty hidden><h3 data-home-empty-title></h3><p>Clear the field or try a shorter word.</p><button type="button" data-home-filter-clear>Clear filter</button></section></main>`
const settleNativeToggles = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function mount(width = 1440) {
  let currentWidth = width
  const matchMedia = vi.fn((query: string) => ({ matches: currentWidth <= Number(/max-width: ([0-9]+)px/.exec(query)?.[1] ?? -1) }))
  vi.stubGlobal('matchMedia', matchMedia)
  document.documentElement.lang = 'en'
  document.body.innerHTML = markup
  const run = () => new Function('return ' + HOME_TOOLS_CLIENT_BINDING)()()
  run()
  const root = document.querySelector<HTMLElement>('[data-panel-home]')!
  const input = root.querySelector<HTMLInputElement>('[data-home-filter]')!
  const groups = [...root.querySelectorAll<HTMLDetailsElement>('[data-tool-group]')]
  const setQuery = (query: string) => { input.value = query; input.dispatchEvent(new Event('input', { bubbles: true })) }
  const shown = () => [...root.querySelectorAll<HTMLElement>('[data-tool]')].filter(tool => !tool.hidden).map(tool => tool.textContent)
  return { root, input, groups, setQuery, shown, run, matchMedia, resize: (nextWidth: number) => { currentWidth = nextWidth; window.dispatchEvent(new Event('resize')) } }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
})

describe('shared home tool matching', () => {
  it.each([
    ['', 'Files', 'Trash restore', true],
    ['  FILES  ', 'Files', 'Trash restore', true],
    ['  ZoNe ', 'Domains', 'DNS zone editor', true],
    ['بريد', 'Email البريد', 'Forwarders redirect', true],
    ['é', 'Software', 'café', true],
    ['e', 'Software', 'café', true],
    ['cafe', 'Software', 'café', false],
    ['absent', 'Files', 'Trash restore', false],
  ])('preserves exact group-or-keyword substring matching for %j', (query, group, keywords, expected) => {
    expect(homeToolMatches(String(query), String(group), String(keywords))).toBe(expected)
  })

  it('preserves the prior classic algorithm across whitespace, Unicode and query boundaries', () => {
    const queries = ['', ' ', '\nMAIL\t', 'smtp', 'بريد', 'البريد', 'س', 'é', 'cafe', 'İ', '<img>', 'File manager']
    const labels = ['Files', 'Email البريد', 'Domains', 'İstanbul']
    const keywords = ['File manager browse editor', 'SMTP IMAP', 'مجلد بريد', 'café', 'dns zone']
    for (const raw of queries) for (const label of labels) for (const keys of keywords) {
      const query = raw.trim().toLowerCase()
      const previous = query === '' || label.toLowerCase().indexOf(query) !== -1 || keys.toLowerCase().indexOf(query) !== -1
      expect(homeToolMatches(raw, label, keys), JSON.stringify({ raw, label, keys })).toBe(previous)
    }
    expect(normalizeHomeToolQuery('  DNS\n')).toBe('dns')
    const evaluate = new Function(HOME_TOOL_MATCHING_FUNCTIONS + 'return homeToolMatches;')() as typeof homeToolMatches
    expect(evaluate(' SMTP ', 'Email', 'smtp mailbox')).toBe(true)
  })
})

describe('single responsive home tool filter', () => {
  it('filters by group or keywords, counts disabled visible tools and preserves theme layout', () => {
    const { root, input, groups, setQuery, shown, run } = mount()
    setQuery('  FILES  ')
    expect(shown()).toEqual(['File manager', 'Trash'])
    expect(groups.map(group => group.hidden)).toEqual([false, true, true])
    expect(root.querySelector('#tool-filter-count')!.textContent).toBe('2 of 5 tools match')
    expect(groups[0]!.querySelector('[data-group-count]')!.textContent).toBe('2 of 2')
    setQuery('بريد')
    expect(shown()).toEqual(['Email accounts', 'Forwarders'])
    expect(root.querySelector<HTMLButtonElement>('button[data-tool]')!.disabled).toBe(true)
    setQuery('ZONE')
    expect(shown()).toEqual(['Zone editor'])
    expect(root.querySelector('#tool-filter-count')!.textContent).toBe('1 of 5 tools matches')
    expect(root.querySelector('[style]')).toBeNull()
    run()
    expect(root.querySelectorAll('[data-home-filter]')).toHaveLength(1)
    expect(root.querySelectorAll('[data-tool]')).toHaveLength(5)
    expect(input.value).toBe('ZONE')
    expect(root.querySelector('#tool-filter-count')!.textContent).toBe('1 of 5 tools matches')
  })

  it('shows the authored no-result state safely and clears through button and Escape keyboard actions', () => {
    const { root, input, setQuery } = mount()
    const raw = '<img src=x onerror=alert(1)>'
    setQuery(raw)
    expect(root.querySelector<HTMLElement>('[data-tool-section]')!.hidden).toBe(true)
    expect(root.querySelector<HTMLElement>('[data-tool-empty]')!.hidden).toBe(false)
    expect(root.querySelector('[data-home-empty-title]')!.textContent).toBe(`No tool matches “${raw}”`)
    expect(root.querySelector('img')).toBeNull()
    root.querySelector<HTMLButtonElement>('[data-home-filter-clear]')!.click()
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(root.querySelector<HTMLElement>('[data-tool-section]')!.hidden).toBe(false)
    expect(root.querySelector<HTMLElement>('[data-tool-empty]')!.hidden).toBe(true)
    expect(root.querySelector('#tool-filter-count')!.textContent).toBe('5 tools in 3 groups')
    setQuery('smtp')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    const idleEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input.dispatchEvent(idleEscape)
    expect(idleEscape.defaultPrevented).toBe(false)
  })

  it('initializes phone accordions once and restores user choices after filtering and viewport changes', async () => {
    const { groups, setQuery, run, matchMedia, resize } = mount(390)
    expect(groups.map(group => group.open)).toEqual([false, false, false])
    expect(matchMedia).toHaveBeenCalledTimes(1)
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 599px)')
    await settleNativeToggles()
    groups[0]!.querySelector('summary')!.click()
    await Promise.resolve()
    expect(groups[0]!.open).toBe(true)
    setQuery('smtp')
    expect(groups[1]!.open).toBe(true)
    setQuery('')
    await settleNativeToggles()
    expect(groups.map(group => group.open)).toEqual([true, false, false])
    resize(1440)
    run()
    expect(matchMedia).toHaveBeenCalledTimes(1)
    expect(groups.map(group => group.open)).toEqual([true, false, false])
    const summary = groups[0]!.querySelector('summary')!
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    summary.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    expect(summary.hasAttribute('aria-expanded')).toBe(false)
  })

  it('remembers an explicit native summary choice made during filtering', async () => {
    const { groups, setQuery } = mount(1440)
    setQuery('mail')
    expect(groups[1]!.open).toBe(true)
    groups[1]!.querySelector('summary')!.click()
    await Promise.resolve()
    expect(groups[1]!.open).toBe(false)
    setQuery('ema')
    expect(groups[1]!.open).toBe(true)
    setQuery('')
    await settleNativeToggles()
    expect(groups[1]!.open).toBe(false)
    setQuery('mail'); setQuery('')
    await settleNativeToggles()
    expect(groups[1]!.open).toBe(false)
  })

  it('announces Arabic results with ASCII digits through the existing translator', () => {
    const { root, setQuery } = mount()
    document.documentElement.lang = 'ar'
    setQuery('بريد')
    const announcement = root.querySelector('#tool-filter-count')!.textContent!
    expect(announcement).toContain('2')
    expect(announcement).toContain('5')
    expect(announcement).not.toMatch(/[٠-٩۰-۹]/)
    expect(root.querySelectorAll('[data-tool]:not([hidden])')).toHaveLength(2)
  })

  it('keeps native desktop opening at the exact breakpoint and does not reveal an initially hidden tool', () => {
    const { groups, matchMedia } = mount(600)
    expect(groups.every(group => group.open)).toBe(true)
    expect(matchMedia).toHaveBeenCalledTimes(1)
    document.body.innerHTML = markup.replace('data-tool-keys="Trash restore"', 'hidden data-tool-keys="Trash restore"')
    new Function('return ' + HOME_TOOLS_CLIENT_BINDING)()()
    const input = document.querySelector<HTMLInputElement>('[data-home-filter]')!
    input.value = 'trash'; input.dispatchEvent(new Event('input'))
    expect(document.querySelector<HTMLElement>('[data-tool-keys="Trash restore"]')!.hidden).toBe(true)
    expect(document.querySelector('#tool-filter-count')!.textContent).toBe('0 of 4 tools match')
  })

  it('keeps filtering and counts owned by their home root when another home is nested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const inner = markup.replace('<main data-panel-home>', '<main data-panel-home id="inner-home">')
    document.body.innerHTML = markup.replace('<main data-panel-home>', '<main data-panel-home id="outer-home">').replace('</main>', `${inner}</main>`)
    new Function('return ' + HOME_TOOLS_CLIENT_BINDING)()()
    const outer = document.getElementById('outer-home')!, nested = document.getElementById('inner-home')!
    const input = outer.querySelector<HTMLInputElement>('[data-home-filter]')!
    input.value = 'Files'; input.dispatchEvent(new Event('input'))
    expect(outer.querySelector('#tool-filter-count')!.textContent).toBe('2 of 5 tools match')
    expect(nested.querySelector('#tool-filter-count')!.textContent).toBe('5 tools in 3 groups')
    expect([...nested.querySelectorAll<HTMLElement>('[data-tool]')].every(tool => !tool.hidden)).toBe(true)
  })
})

describe('classic home shared matcher integration', () => {
  it('executes the original desktop filter with the extracted matching functions', () => {
    const captured: { target: EventTarget; name: string; listener: EventListenerOrEventListenerObject; options?: AddEventListenerOptions | boolean }[] = []
    for (const target of [window, document] as EventTarget[]) {
      const original = target.addEventListener.bind(target)
      vi.spyOn(target, 'addEventListener').mockImplementation((name, listener, options) => {
        if (listener && ['keydown', 'focusin', 'click', 'resize', 'pagehide'].includes(name)) captured.push({ target, name, listener, options })
        original(name, listener, options)
      })
    }
    document.body.innerHTML = '<div data-home-desktop dir="ltr"><input id="tool-filter"><input id="home-header-search"><span id="tool-filter-count" data-rest="2 tools in 1 group"></span><section data-tool-section><div data-tool-group data-size="2" data-group-label="Files" data-show="grid"><span data-group-count data-rest="2 tools"></span><a data-tool data-tool-keys="manager">Manager</a><a data-tool data-tool-keys="trash">Trash</a></div></section></div>'
    try {
      new Function(HOME_SCRIPT.replace(/^<script>\s*/, '').replace(/\s*<\/script>$/, ''))()
      const input = document.querySelector<HTMLInputElement>('#tool-filter')!
      input.value = '  FILES '; input.dispatchEvent(new Event('input'))
      expect([...document.querySelectorAll<HTMLElement>('[data-tool]')].every(tool => !tool.hidden)).toBe(true)
      expect(document.querySelector<HTMLElement>('[data-tool-group]')!.style.display).toBe('grid')
      expect(document.querySelector('#tool-filter-count')!.textContent).toBe('2 of 2 tools match')
      expect(document.querySelector<HTMLInputElement>('#home-header-search')!.value).toBe('  FILES ')
      input.value = 'trash'; input.dispatchEvent(new Event('input'))
      expect([...document.querySelectorAll<HTMLElement>('[data-tool]')].filter(tool => !tool.hidden).map(tool => tool.textContent)).toEqual(['Trash'])
    } finally {
      for (const { target, name, listener, options } of captured) target.removeEventListener(name, listener, options)
    }
  })
})
