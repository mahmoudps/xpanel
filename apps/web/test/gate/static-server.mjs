import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const mode = process.argv[2]
const root = process.argv[3] ?? ''
const indexFile = process.argv[4] ?? ''
const pages = mode === 'map' ? new Map(Object.entries(JSON.parse(await readFile(root, 'utf8')))) : null
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    let body
    let type = 'text/html; charset=utf-8'
    if (pages) {
      const html = pages.get(`${url.pathname}${url.search}`)
      if (html === undefined) {
        res.writeHead(404)
        res.end('missing')
        return
      }
      body = Buffer.from(html)
    } else {
      const rel = decodeURIComponent(url.pathname === '/' ? `/${indexFile}` : url.pathname).replace(/^\/+/, '')
      const file = path.join(root, rel)
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
        res.writeHead(404)
        res.end('missing')
        return
      }
      body = await readFile(file)
      if (file.endsWith('.js')) type = 'text/javascript; charset=utf-8'
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('missing')
  }
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`PORT ${typeof address === 'object' && address ? address.port : 0}\n`)
})
