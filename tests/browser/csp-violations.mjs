/**
 * Records every Content-Security-Policy violation the page reports into `sink`, and every HTML document that arrives
 * without a policy, so a lane cannot pass by not enforcing one. A lane fails when `sink` is not empty.
 * Call it after newPage() and before the first navigation.
 */
export async function recordCspViolations(page, sink) {
  await page.exposeFunction('__xpanelCspViolation', violation => { sink.push(violation) })
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
    globalThis.__xpanelCspViolation({ directive: event.effectiveDirective, blocked: String(event.blockedURI).slice(0, 160),
      source: String(event.sourceFile).slice(0, 160), line: event.lineNumber, sample: String(event.sample).slice(0, 80) })
  }))
  page.on('response', response => {
    const headers = response.headers()
    if (response.request().resourceType() === 'document' && response.request().frame() === page.mainFrame()
      && (headers['content-type'] ?? '').startsWith('text/html') && !headers['content-security-policy']) sink.push({ directive: 'missing-policy', blocked: response.url().slice(0, 160) })
  })
}

/** Test tooling such as axe enters through DevTools, which the page policy does not govern; a <script> tag would be blocked. */
export const injectTestScript = (page, source) => page.evaluate(`${source}\n;void 0`)
