// Dependency-free: the root management TLS lifecycle and the edge renderer share this one rule.

/**
 * How a 443 server enables HTTP/2. nginx requires identical protocol options on every server of one
 * address:port, and 1.25.1 moved HTTP/2 from the `listen ... http2` option to the `http2 on;` directive,
 * warning on the old option. 'listen' = `listen 443 ssl http2;`, 'directive' = `listen 443 ssl;` + `http2 on;`.
 */
export const NGINX_HTTP2_STYLES = Object.freeze(['listen', 'directive'])

/** The style of the binary whose `nginx -v` output is given; null when the output names no version. */
export const nginxHttp2Style = versionOutput => {
  const found = /^nginx version: [A-Za-z]+\/(\d{1,4})\.(\d{1,4})\.(\d{1,4})\b/m.exec(versionOutput)
  if (!found) return null
  const [major, minor, patch] = found.slice(1).map(Number)
  return major > 1 || (major === 1 && (minor > 25 || (minor === 25 && patch >= 1))) ? 'directive' : 'listen'
}
