import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import playwright from '../../node_modules/@playwright/test/index.js'
import { renderCompose, xmailComposeFromProps } from '../../apps/web/src/board-port/xmail-compose.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourcePath = 'apps/web/src/board-port/xmail-compose.ts'
const sourceHash = () => createHash('sha256').update(readFileSync(resolve(root, sourcePath))).digest('hex')
const before = sourceHash()
const outputIndex = process.argv.indexOf('--out')
const output = outputIndex === -1 ? resolve(root, 'test-results/mail-compose-functional/results.json') : resolve(process.argv[outputIndex + 1] ?? '')
const executablePath = process.env.CHROME_PATH || playwright.chromium.executablePath()
assert.ok(existsSync(executablePath), 'Pinned Chromium is required; use PLAYWRIGHT_BROWSERS_PATH or CHROME_PATH.')
const records = []
const pageErrors = []
const requests = []
const browser = await playwright.chromium.launch({ executablePath, headless: true })
let context

try {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort() })

  const reset = async (body = 'Alpha beta gamma') => {
    const html = renderCompose(xmailComposeFromProps({ mailbox: 'owner@example.test', draft: { body } }))
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p id="outside-editor">Outside text</p>${html}</body></html>`, { waitUntil: 'domcontentloaded' })
    assert.equal(await page.locator('#compose-body[contenteditable="true"]').count(), 1)
  }
  const select = async (text, scope = 'editor') => page.evaluate(({ text, scope }) => {
    const container = document.querySelector(scope === 'editor' ? '#compose-body' : '#outside-editor')
    if (!container) throw new Error('Selection container missing')
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const offset = node.textContent.indexOf(text)
      if (offset === -1) continue
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + text.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      if (scope === 'editor') container.focus()
      container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return
    }
    throw new Error('Selection text missing')
  }, { text, scope })
  const click = key => page.locator(`[data-mail-format="${key}"]`).click()
  const check = async (name, body) => {
    try { records.push({ name, status: 'passed', observation: await body() }) }
    catch (error) { records.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) }) }
  }

  await check('bold changes editor DOM and keeps editor focus', async () => {
    await reset()
    await select('Alpha')
    await click('bold')
    const observation = await page.evaluate(() => ({
      marked: [...document.querySelectorAll('#compose-body strong,#compose-body b')].some(node => node.textContent === 'Alpha'),
      focused: document.activeElement?.id,
      text: document.querySelector('#compose-body').textContent,
    }))
    assert.equal(observation.marked, true)
    assert.equal(observation.focused, 'compose-body')
    assert.equal(observation.text, 'Alpha beta gamma')
    return observation
  })

  await check('bullets create actual list nodes', async () => {
    await reset('First item and second item')
    await select('First item and second item')
    await click('bullets')
    const observation = await page.evaluate(() => ({ count: document.querySelectorAll('#compose-body ul > li').length, text: document.querySelector('#compose-body').textContent }))
    assert.ok(observation.count >= 1)
    assert.equal(observation.text, 'First item and second item')
    return observation
  })

  await check('safe link is created around the selected text', async () => {
    await reset()
    await select('beta')
    page.once('dialog', dialog => dialog.accept('https://example.test/reference'))
    await click('link')
    const observation = await page.evaluate(() => [...document.querySelectorAll('#compose-body a')].map(node => ({ text: node.textContent, href: node.getAttribute('href') })))
    assert.deepEqual(observation, [{ text: 'beta', href: 'https://example.test/reference' }])
    return observation
  })

  await check('unsafe link cannot change editor HTML', async () => {
    await reset()
    await select('beta')
    const html = await page.locator('#compose-body').innerHTML()
    page.once('dialog', dialog => dialog.accept('javascript:window.untrustedLinkExecuted=true'))
    await click('link')
    const observation = await page.evaluate(() => ({ links: document.querySelectorAll('#compose-body a').length, feedback: document.querySelector('[data-mail-feedback]').textContent, hidden: document.querySelector('[data-mail-feedback]').hidden, executed: window.untrustedLinkExecuted === true }))
    assert.equal(await page.locator('#compose-body').innerHTML(), html)
    assert.equal(observation.links, 0)
    assert.equal(observation.hidden, false)
    assert.equal(observation.executed, false)
    assert.match(observation.feedback, /http, https or mailto/)
    return observation
  })

  await check('a selection outside the editor is never formatted', async () => {
    await reset()
    await select('Outside text', 'outside')
    await click('bold')
    const observation = await page.evaluate(() => {
      const editor = document.querySelector('#compose-body')
      const selection = window.getSelection()
      return { outside: document.querySelector('#outside-editor').innerHTML, text: editor.textContent, focused: document.activeElement?.id, scoped: !!selection?.rangeCount && editor.contains(selection.getRangeAt(0).startContainer) && editor.contains(selection.getRangeAt(0).endContainer) }
    })
    assert.equal(observation.outside, 'Outside text')
    assert.equal(observation.text, 'Alpha beta gamma')
    assert.equal(observation.focused, 'compose-body')
    assert.equal(observation.scoped, true)
    await page.keyboard.type('Z')
    assert.equal(await page.locator('#outside-editor').innerHTML(), 'Outside text')
    assert.ok((await page.locator('#compose-body').textContent()).includes('Z'))
    return observation
  })

  await check('clear formatting removes selected bold markup', async () => {
    await reset()
    await select('Alpha')
    await click('bold')
    await select('Alpha')
    await click('clear')
    const observation = await page.evaluate(() => ({ marked: [...document.querySelectorAll('#compose-body strong,#compose-body b')].some(node => node.textContent === 'Alpha'), text: document.querySelector('#compose-body').textContent }))
    assert.equal(observation.marked, false)
    assert.equal(observation.text, 'Alpha beta gamma')
    return observation
  })

  await check('clipboard HTML is pasted as literal text without remote nodes', async () => {
    await reset()
    await select('beta')
    const observation = await page.evaluate(() => {
      const editor = document.querySelector('#compose-body')
      const clipboard = new DataTransfer()
      const literal = '<img src="https://example.test/tracker" onerror="unsafe()">'
      clipboard.setData('text/plain', `${literal}\nNext line`)
      clipboard.setData('text/html', literal)
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
      return { images: editor.querySelectorAll('img').length, text: editor.textContent, lineBreaks: editor.querySelectorAll('br').length }
    })
    assert.equal(observation.images, 0)
    assert.ok(observation.text.includes('<img src="https://example.test/tracker" onerror="unsafe()">'))
    assert.ok(observation.text.includes('Next line'))
    assert.ok(observation.lineBreaks >= 1)
    return observation
  })

  assert.equal(sourceHash(), before, 'The tested compose source changed while this functional run was active.')
  const result = { status: records.every(record => record.status === 'passed') && !pageErrors.length && !requests.length ? 'passed' : 'failed', node: process.version, browser: browser.version(), source: { path: sourcePath, before, after: sourceHash() }, cases: records, pageErrors, networkRequests: requests.length, screenshots: false, geometryChecks: false, visualAssertions: false, smtpOrImapDeliveryTested: false }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ status: result.status, passed: records.filter(record => record.status === 'passed').length, failed: records.filter(record => record.status === 'failed').length, pageErrors: pageErrors.length, networkRequests: requests.length, output }))
  if (result.status !== 'passed') {
    for (const record of records.filter(record => record.status === 'failed')) console.error(record.name, record.error)
    process.exitCode = 1
  }
} finally {
  await context?.close()
  await browser.close()
}
