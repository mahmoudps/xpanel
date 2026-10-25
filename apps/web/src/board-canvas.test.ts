import { describe, expect, it } from 'vitest'
import { renderBoardCanvas } from './board-canvas.ts'

const routes = [
  '/files/backup', '/files/directory-privacy', '/software/php', '/software/htaccess', '/advanced/cron',
  '/whm/server/setup', '/whm/plans/features', '/whm/domains', '/whm/dns', '/whm/ssl',
  '/whm/services/web', '/whm/software/php', '/whm/security', '/whm/security/ssh', '/whm/backups',
]

describe('complete unavailable workspace presentation', () => {
  it.each(['en', 'ar'] as const)('retains the component layout with disabled controls and explicit unread state in %s', locale => {
    for (const route of routes) {
      const html = renderBoardCanvas(route, locale)
      expect(html).toContain(`data-board-layout="${route}"`)
      expect(html).toContain('data-read-state="unread"')
      expect(html).toContain('id="xp-board-unavailable-reason"')
      expect(html).not.toMatch(/<form\b|\bfetch\s*\(|\/api\/|\bXMLHttpRequest\b/)
      for (const tag of html.match(/<(?:button|input|select|textarea)\b[^>]*>/g) ?? []) expect(tag).toMatch(/\bdisabled\b/)
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
      expect(new Set(ids).size, `${route} has duplicate element identifiers`).toBe(ids.length)
      for (const [, target] of html.matchAll(/\bfor="([^"]+)"/g)) expect(ids).toContain(target)
      expect(html).not.toMatch(/alice|srv1\.xpanel|20014|[\u0660-\u0669\u06f0-\u06f9]/)
    }
    expect(renderBoardCanvas('/not-registered', locale)).toBe('')
  })

  it('preserves engine, worker, pool and PHP configuration groups instead of only an empty information card', () => {
    const setup = renderBoardCanvas('/whm/server/setup', 'en')
    for (const component of ['Nameserver 1 address', 'Nameserver 2 address', 'Admin email', 'worker_connections', 'MaxRequestWorkers', 'pm.process_idle_timeout', 'lsphp connections per account', 'Tests on the candidate generation']) expect(setup).toContain(component)
    const php = renderBoardCanvas('/software/php', 'en')
    for (const component of ['PHP-FPM', 'CGI with suexec', 'suPHP', 'lsphp', 'pm.min_spare_servers', 'pm.max_spare_servers', '.user.ini', 'upload_max_filesize', 'display_errors', 'date.timezone']) expect(php).toContain(component)
    const web = renderBoardCanvas('/whm/services/web', 'en')
    for (const component of ['Apache MPM', 'Backend connection', 'Nginx edge', 'worker_rlimit_nofile', 'MaxConnectionsPerChild', 'Candidate', 'Test and apply', 'Generations']) expect(web).toContain(component)
  })

  it('retains backup/restore review, parts and destinations without simulating an archive or execution', () => {
    const account = renderBoardCanvas('/files/backup', 'en')
    for (const component of ['What do you want to back up?', 'Remote storage', 'Choose an archive', 'Review the difference', 'Planned action', 'I reviewed the proposed restore changes', 'Restore selected parts']) expect(account).toContain(component)
    const server = renderBoardCanvas('/whm/backups', 'en')
    for (const component of ['Parts to restore', 'DNS zone', 'Daily copies', 'Weekly copies', 'Remote SFTP', 'Private key file on this server', 'Test connection', 'Control database snapshot']) expect(server).toContain(component)
    expect(server).not.toContain('PostgreSQL')
    expect(server.replace(/<style[\s\S]*?<\/style>/g, '')).not.toMatch(/Backup completed|Restore completed|100%|backed up successfully/)
    expect(server).not.toContain('aria-valuenow="100"')
  })

  it('preserves editor, schedule and SSH policy controls without reading or inventing a private file or service result', () => {
    const editor = renderBoardCanvas('/software/htaccess', 'en')
    expect(editor).toMatch(/<textarea[^>]*id="ht-file-editor"[^>]*readonly[^>]*disabled/)
    for (const component of ['Insert at cursor', 'Discard draft', 'Save and check site', 'Move PHP settings to .user.ini', 'Versions']) expect(editor).toContain(component)
    const cron = renderBoardCanvas('/advanced/cron', 'en')
    for (const component of ['Every 5 minutes', 'Stop the job after', 'Only when it fails', 'After every run', 'Output email', 'Unit preview']) expect(cron).toContain(component)
    const ssh = renderBoardCanvas('/whm/security/ssh', 'en')
    for (const component of ['Authorized keys for root', 'Add a public key', 'Failed sign-ins', 'Auto-ban rule', 'Within, minutes', 'Ban for', 'Unban selected address']) expect(ssh).toContain(component)
    expect(ssh).toContain('The SSH ban list has not been read.')
    expect(ssh).not.toContain('No addresses banned by SSH')
    expect(ssh).not.toMatch(/ssh-ed25519 [A-Za-z0-9+/]+/)
    const security = renderBoardCanvas('/whm/security', 'en')
    expect(security).toContain('Enrollment is optional.')
    expect(security).not.toContain('No second factor is stored for root.')
  })
})
