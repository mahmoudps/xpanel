import assert from 'node:assert/strict'

const proportionalFamilies = new Set(['IBM Plex Sans', 'IBM Plex Sans Arabic', 'Noto Sans Arabic'])
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
export async function assertAppliedFont(page, selector, family) {
  assert.ok(typeof selector === 'string' && selector.trim(), 'An explicit CSS selector is required')
  assert.ok(proportionalFamilies.has(family), 'Expected a supported proportional font family')
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
    }
  }, selector)
  observation.expected_family = family
  observation.applied_faces = []
  let session
  try {
    assert.equal(observation.count, 1, 'The applied font contract requires exactly one target node')
    assert.ok(observation.text && observation.visible && observation.glyph_bounds.width > 0 && observation.glyph_bounds.height > 0, 'The applied font target must contain visible nonempty text')
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
    assert.ok(active.every(font => font.normalized_family !== 'IBM Plex Mono'), 'Brand and ordinary headings must use a proportional font, not Plex Mono')
    assert.ok(active.every(font => font.isCustomFont === true && font.normalized_family === family), 'All rendered glyphs must use the expected downloadable font family; a fallback font does not pass')
    observation.rendered_glyphs = active.reduce((total, font) => total + font.glyphCount, 0)
    return observation
  } catch (error) {
    error.appliedFontObservation = observation
    throw error
  } finally {
    if (session) await session.detach()
  }
}
