import assert from 'node:assert/strict'

const proportionalFamilies = new Set(['IBM Plex Sans', 'sans-serif'])
const wordmarkSelectors = {
  'login-wordmark': '.xp-brand__name',
  'mail-wordmark': '[data-mail-layout="reference"] > header > a:first-of-type > span:last-child',
}
const reportedFamily = name => {
  const normalized = name.trim().replace(/\s+/g, ' ')
  // Chromium reports some font weights as part of familyName. Match the whole
  // family and a known style suffix, so Sans Arabic never passes as Sans.
  const match = /^(IBM Plex Sans Arabic|IBM Plex Sans|IBM Plex Mono|Noto Sans Arabic)(?: (?:Thin|Extra ?Light|Light|Regular|Text|Medium|Semi ?Bold|Bold|Extra ?Bold)(?: Italic)?| Italic)?$/i.exec(normalized)
  if (!match) return normalized
  return ['IBM Plex Sans Arabic', 'IBM Plex Sans', 'IBM Plex Mono', 'Noto Sans Arabic'].find(family => family.toLowerCase() === match[1].toLowerCase())
}

/**
 * Assert the font that Chromium actually used to draw a nonempty visible node.
 * Font downloads and computed font stacks alone cannot satisfy this contract.
 * Failed assertions retain appliedFontObservation for the caller's evidence.
 */
export async function assertAppliedFont(page, selector, family, { role = 'ordinary' } = {}) {
  assert.ok(typeof selector === 'string' && selector.trim(), 'An explicit CSS selector is required')
  assert.ok(role === 'ordinary' || Object.hasOwn(wordmarkSelectors, role), 'An explicit supported typography role is required')
  const wordmark = role !== 'ordinary'
  if (wordmark) {
    assert.equal(selector, wordmarkSelectors[role], 'The wordmark role is limited to its exact product wordmark selector')
    assert.equal(family, 'IBM Plex Mono', 'The product wordmark requires the exact IBM Plex Mono family')
  } else {
    assert.ok(proportionalFamilies.has(family), 'Expected a supported proportional font family')
  }
  const observation = await page.evaluate(selector => {
    const nodes = document.querySelectorAll(selector), element = nodes[0]
    if (!element) return { selector, count: 0, text: '', visible: false }
    const style = getComputedStyle(element), rect = element.getBoundingClientRect(), range = document.createRange()
    range.selectNodeContents(element)
    const glyphs = range.getBoundingClientRect()
    return {
      selector, count: nodes.length, tag: element.tagName, text: element.textContent.trim(),
      visible: element.checkVisibility() && !element.closest('[hidden],[inert]') && rect.width > 0 && rect.height > 0,
      computed: { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, line_height: style.lineHeight, letter_spacing: style.letterSpacing, font_synthesis: style.fontSynthesis, font_kerning: style.fontKerning },
      glyph_bounds: { width: glyphs.width, height: glyphs.height },
      wordmark_context: {
        login_surface: element.closest('.xp-login-shell')?.getAttribute('data-surface') ?? null,
        login_audience: element.closest('.xp-login-shell')?.getAttribute('data-login-audience') ?? null,
        mail_layout: element.closest('[data-mail-layout]')?.getAttribute('data-mail-layout') ?? null,
        mail_board: element.closest('[data-board-port]')?.getAttribute('data-board-port') ?? null,
        mail_surface: element.closest('[data-mail-layout]')?.getAttribute('data-surface') ?? null,
      },
    }
  }, selector)
  observation.expected_family = family
  observation.typography_role = role
  observation.applied_faces = []
  let session
  try {
    assert.equal(observation.count, 1, 'The applied font contract requires exactly one target node')
    assert.ok(observation.text && observation.visible && observation.glyph_bounds.width > 0 && observation.glyph_bounds.height > 0, 'The applied font target must contain visible nonempty text')
    if (role === 'login-wordmark') {
      const brands = { xpanel: 'xPanel', xwhm: 'xWHM', xmail: 'xMail' }
      const audience = observation.wordmark_context.login_audience
      assert.equal(observation.tag, 'SPAN', 'The sign-in wordmark must be its dedicated text span')
      assert.equal(observation.wordmark_context.login_surface, 'login', 'The sign-in wordmark must belong to the sign-in surface')
      assert.ok(Object.hasOwn(brands, audience), 'The sign-in wordmark must have a supported server-selected audience')
      assert.equal(observation.text, brands[audience], 'The sign-in wordmark must match its surface identity')
    } else if (role === 'mail-wordmark') {
      assert.equal(observation.tag, 'SPAN', 'The mail wordmark must be its dedicated text span')
      assert.equal(observation.wordmark_context.mail_layout, 'reference', 'The mail wordmark must belong to the reference mail layout')
      assert.ok(['xmail-inbox', 'xmail-compose'].includes(observation.wordmark_context.mail_board), 'The mail wordmark must belong to a supported mail board')
      assert.equal(observation.wordmark_context.mail_surface, 'xmail', 'The mail wordmark must belong to the mail surface')
      assert.equal(observation.text, 'xMail', 'The mail wordmark must retain its product identity')
    }
    session = await page.context().newCDPSession(page)
    await session.send('DOM.enable')
    await session.send('CSS.enable')
    const { root } = await session.send('DOM.getDocument')
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    assert.ok(nodeId > 0, 'Chromium must resolve the actual font target')
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId })
    observation.applied_faces = fonts.map(font => ({ ...font, normalized_family: reportedFamily(font.familyName) }))
    const active = observation.applied_faces.filter(font => Number.isFinite(font.glyphCount) && font.glyphCount > 0)
    assert.ok(active.length > 0, 'Chromium must report actual rendered glyphs for the font target')
    if (!wordmark) assert.ok(active.every(font => font.normalized_family !== 'IBM Plex Mono'), 'Ordinary interface text and headings must use a proportional font, not Plex Mono')
    if (family === 'sans-serif') {
      assert.equal(observation.computed.family, 'sans-serif', 'Arabic UI text must select the literal generic sans-serif family')
      assert.ok(active.every(font => font.isCustomFont === false), 'Generic Arabic UI glyphs must use platform fonts, not downloaded custom faces')
      observation.platform_proportions = await page.evaluate(({ faces, weight }) => {
        // Compare the actual CDP-reported families with two distinct fallback
        // stacks. Equal resolved advances exclude an unresolved family name;
        // unequal narrow/wide advances exclude a fixed-pitch platform face.
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
        if (!context) return []
        context.fontKerning = 'none'
        return faces.map(face => {
          const measure = fallback => {
            context.font = `${weight} 48px ${JSON.stringify(face)}, ${fallback}`
            return ['iiiiiiii', 'WWWWWWWW'].map(text => context.measureText(text).width)
          }
          return { family: face, serif: measure('serif'), monospace: measure('monospace') }
        })
      }, { faces: [...new Set(active.map(font => font.familyName))], weight: observation.computed.weight })
      assert.equal(observation.platform_proportions.length, new Set(active.map(font => font.familyName)).size, 'Each observed platform face must have a measurable proportional contract')
      assert.ok(observation.platform_proportions.every(face =>
        !/mono|courier|consolas|fixed|typewriter/i.test(face.family) &&
        face.serif.every((width, index) => Number.isFinite(width) && width > 0 && Math.abs(width - face.monospace[index]) < 0.01) &&
        Math.abs(face.serif[0] - face.serif[1]) > 1
      ), 'Every actual platform face must resolve independently of fallback and have proportional glyph advances')
    } else {
      assert.ok(active.every(font => font.isCustomFont === true && font.normalized_family === family), 'All rendered glyphs must use the expected downloadable font family; a fallback font does not pass')
    }
    observation.rendered_glyphs = active.reduce((total, font) => total + font.glyphCount, 0)
    return observation
  } catch (error) {
    error.appliedFontObservation = observation
    throw error
  } finally {
    if (session) await session.detach()
  }
}
