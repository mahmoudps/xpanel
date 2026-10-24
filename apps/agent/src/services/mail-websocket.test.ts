import { describe, expect, it } from 'vitest'
import type { HostAction } from '@xpanel/core'
import { FakeHostExecutor } from '../executor.ts'
import { enableMailWebsocketProxy, rewriteMailWebsocketConfig } from './mail-websocket.ts'

const mail = `server {
    listen 192.0.2.10:2096 ssl;
    server_name mail.panel.example.test;
    location / {
        proxy_set_header Upgrade "";
        proxy_set_header Connection "";
    }
}
`

describe('mail websocket proxy', () => {
  it('forwards upgrade headers on the 2096 server and leaves other listeners', () => {
    const config = `server {\n    listen 192.0.2.10:2087 ssl;\n    proxy_set_header Upgrade $http_upgrade;\n}\n${mail}`
    const rewritten = rewriteMailWebsocketConfig(config, true)
    expect(rewritten).toContain('listen 192.0.2.10:2096 ssl;')
    expect(rewritten).toContain('proxy_set_header Upgrade $http_upgrade;')
    expect(rewritten).toContain('proxy_set_header Connection $xpanel_connection_upgrade;')
    expect(rewritten).not.toContain('Upgrade ""')
    expect(rewritten?.match(/proxy_set_header Upgrade \$http_upgrade;/g)).toHaveLength(2)
    expect(rewriteMailWebsocketConfig(rewritten ?? '', true)).toBeNull()
  })

  it('writes the installed file, reloads nginx, and restores it when nginx -t fails', async () => {
    const executor = new FakeHostExecutor()
    const path = '/etc/nginx/xpanel.conf'
    executor.files.set(path, { path, content: mail, mode: 0o644, owner: 'root', group: 'root' })
    const dump = `# configuration file ${path}:\n${mail}`
    executor.failCommand('-T', 0, '', dump)
    const verbs: string[] = []
    const run = executor.runAction.bind(executor)
    executor.runAction = async (action: HostAction) => {
      if (action.kind === 'systemd') verbs.push(`${action.verb} ${action.unit}`)
      await run(action)
    }
    expect(await enableMailWebsocketProxy(executor)).toBe(true)
    expect(executor.files.get(path)?.content).toContain('Upgrade $http_upgrade')
    expect(verbs).toContain('reload nginx.service')
    expect([...executor.files.keys()].some(key => key.startsWith(`${path}.bak.`))).toBe(true)

    executor.files.set(path, { path, content: mail, mode: 0o644, owner: 'root', group: 'root' })
    executor.failCommand('-t', 1, 'emerg', '')
    expect(await enableMailWebsocketProxy(executor)).toBe(false)
    expect(executor.files.get(path)?.content).toBe(mail)
  })
})
