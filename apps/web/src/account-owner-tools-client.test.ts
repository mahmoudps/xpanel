import { describe, expect, it } from 'vitest'
import { htmlPreviewDocument, htmlTableMarkup, htmlVideoMarkup, protectHtmlScripts, restoreHtmlScripts } from './account-owner-tools-client.ts'

const PAGE = '<!doctype html><html><head><title>x</title><script src="/a.js"></script></head><body class="m"><h1>Old</h1><script>if (a < b) { run("</div>") }</script><p>t</p></body></html>\n'

describe('HTML editor round trip', () => {
  it('keeps every byte outside the edited markup, scripts included', () => {
    const parts = protectHtmlScripts(PAGE)
    expect(parts.body).not.toContain('<script')
    expect(restoreHtmlScripts(parts.head, parts.body, parts.tail, parts.scripts)).toBe(PAGE)
    expect(restoreHtmlScripts(parts.head, parts.body.replace('Old', 'New'), parts.tail, parts.scripts)).toBe(PAGE.replace('Old', 'New'))
  })

  it('never hands a script to the sandboxed frame', () => {
    const parts = protectHtmlScripts(PAGE)
    expect(htmlPreviewDocument(parts.head, parts.body)).not.toMatch(/<script/i)
  })

  it('treats a fragment without a body as the whole document', () => {
    const parts = protectHtmlScripts('<p>a</p>')
    expect(parts.body).toBe('<p>a</p>')
    expect(restoreHtmlScripts(parts.head, parts.body, parts.tail, parts.scripts)).toBe('<p>a</p>')
  })
})

describe('HTML editor inserts', () => {
  it('builds a table of the requested size and refuses another', () => {
    const table = htmlTableMarkup('2 x 3')!
    expect(table.match(/<tr>/g)).toHaveLength(2)
    expect(table.match(/<td>/g)).toHaveLength(6)
    for (const size of ['', '3', '0x3', '51x2', '2x21', '2x3x4', 'axb']) expect(htmlTableMarkup(size)).toBeNull()
  })

  it('embeds YouTube and Vimeo, plays any other address as a file, and takes no other scheme', () => {
    expect(htmlVideoMarkup('https://www.youtube.com/watch?t=3&v=dQw4w9WgXcQ')).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"')
    expect(htmlVideoMarkup('https://youtu.be/dQw4w9WgXcQ?t=3')).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"')
    expect(htmlVideoMarkup('https://vimeo.com/76979871')).toContain('src="https://player.vimeo.com/video/76979871"')
    expect(htmlVideoMarkup('videos/intro.mp4')).toBe('<video src="videos/intro.mp4" controls preload="metadata" style="max-width:100%"></video>')
    expect(htmlVideoMarkup('https://cdn.example.test/a.mp4?x=1&y=2')).toContain('src="https://cdn.example.test/a.mp4?x=1&amp;y=2"')
    for (const bad of ['', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:video/mp4;base64,AA', '//evil.test/a.mp4', 'a.mp4" onerror="x', 'a b.mp4', 'file:///etc/passwd']) expect(htmlVideoMarkup(bad)).toBeNull()
  })
})
