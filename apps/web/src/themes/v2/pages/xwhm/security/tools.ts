import { actions, button, context, esc, facts, field, fields, help, inputControl, link, page, section, select, status, table, type WhmObservationInput } from '../monitoring/common.ts'

type SecurityTool = 'intrusion' | 'isolation' | 'antivirus'
export function renderV2WhmSecurityTool(input: WhmObservationInput, kind: SecurityTool): string {
  const { t, canRead, canManage } = context(input)
  const refresh = actions(button(t, msgid('Refresh'), { 'data-whm-security-tools-refresh': true }, canRead))
  const unread = status(t, canRead ? msgid('Nothing has been read yet.') : msgid('Security tools require an authorized root administrator. Nothing was read or changed.'), { 'data-whm-security-tools-status': true }, canRead ? 'unread' : 'unavailable')
  const result = status(t, '', { 'data-whm-security-tools-result': true }, 'unread', true)
  const account = (id: string) => field(t, id, msgid('Account'), select(t, id, { 'data-whm-security-tools-account': true }, [['', msgid('Select an account')]], canRead))
  const install = (name: string) => `<p class="v2-muted" data-whm-security-tools-install hidden>${esc(t(msgid('{name} is not installed on this server. It can be installed from the Software center.'), { name }))} <a href="/whm/software/catalog">${esc(t(msgid('Open the Software center')))}</a></p>`
  const body = kind === 'intrusion'
    ? section(t, 'intrusion-service', 'Fail2ban', unread + refresh + facts(t, [['service', msgid('Service')], ['jails', msgid('Jails')], ['banned', msgid('Currently banned')], ['observed-at', msgid('Observed at (UTC)')]], 'data-whm-security-tools-fact') + install('Fail2ban')
      + `<p class="v2-muted" data-whm-security-tools-unsupported hidden>${esc(t(msgid('Some jails have names outside the reviewed format and were not read.')))}</p>`)
      + section(t, 'intrusion-jails', msgid('Jails'), table(t, msgid('Fail2ban jails'), [msgid('Jail'), msgid('Currently failed'), msgid('Total failed'), msgid('Currently banned'), msgid('Total banned'), msgid('State')], { 'data-whm-security-tools-rows': 'jails' }, msgid('No jails have been read.')))
      + section(t, 'intrusion-banned', msgid('Banned addresses'), fields(field(t, 'v2-security-jail', msgid('Jail'), select(t, 'v2-security-jail', { 'data-whm-security-tools-filter': 'jail' }, [['', msgid('All jails')]], canRead))
        + field(t, 'v2-security-address', msgid('Address'), inputControl('v2-security-address', { 'data-whm-security-tools-filter': 'text' }, canRead, ' dir="ltr" maxlength="45" autocomplete="off"', 'search')))
        + help(t, msgid('Unban removes one address from one jail after a fresh read shows it is banned there. Fail2ban bans it again if the failures continue. Subnet entries are shown but cannot be unbanned here.')) + result
        + `<p class="v2-muted" data-whm-security-tools-truncated hidden>${esc(t(msgid('Only the first 5000 banned addresses were read.')))}</p>`
        + table(t, msgid('Banned addresses'), [msgid('Address'), msgid('Jail'), msgid('Actions')], { 'data-whm-security-tools-rows': 'banned' }, msgid('No banned addresses have been read.')))
    : kind === 'isolation'
      ? section(t, 'isolation-account', msgid('Account'), unread + refresh + fields(account('v2-isolation-account'))
        + actions(button(t, msgid('Inspect isolation'), { 'data-whm-security-tools-inspect': true }, false, true))
        + facts(t, [['account', msgid('Account')], ['uid', 'UID'], ['account-status', msgid('Account status')], ['state', msgid('Result')], ['observed-at', msgid('Observed at (UTC)')]], 'data-whm-security-tools-fact')
        + help(t, msgid('This view is read-only. It compares the user, home directory, resource slice, cgroup limits and PHP-FPM identity on the host with what xPanel renders for the account and its plan.')))
        + section(t, 'isolation-checks', msgid('Isolation checks'), `<p class="v2-muted" data-whm-security-tools-drift hidden>${esc(t(msgid('Drift means the host differs from the rendered configuration.')))} <a href="/whm/monitoring/repair">${esc(t(msgid('Review drift in the Repair center')))}</a></p>`
          + table(t, msgid('Isolation checks'), [msgid('Control'), msgid('Expected'), msgid('Observed'), msgid('State')], { 'data-whm-security-tools-rows': 'checks' }, msgid('No account has been inspected.')))
      : section(t, 'antivirus-engine', msgid('ClamAV engine'), unread + refresh + facts(t, [['engine', msgid('Engine version')], ['signatures', msgid('Signature version')], ['signature-date', msgid('Signature date')], ['updater', msgid('Signature updater')], ['observed-at', msgid('Observed at (UTC)')]], 'data-whm-security-tools-fact') + install('ClamAV')
        + actions(button(t, msgid('Update signatures'), { 'data-whm-security-tools-update': true }))
        + help(t, msgid('The update runs freshclam as a host job. When the clamav-freshclam service is running it already keeps signatures current, and a manual update may fail while it holds the update lock.')))
        + section(t, 'antivirus-scan', msgid('Scan an account'), fields(account('v2-antivirus-account')) + actions(button(t, msgid('Start scan'), { 'data-whm-security-tools-scan': true }, false, true)
          + `<a class="v2-btn" href="/whm/jobs" data-whm-security-tools-job-link hidden>${esc(t(msgid('Open job')))}</a>`)
          + help(t, msgid('The scan runs as a host job on the account home only. Symbolic links are not followed, files over 100 MB and archives over 400 MB of content are skipped, and a scan can use about 1 GB of memory.'))
          + help(t, msgid('Infected files are reported only. Quarantine and deletion are not available here.')) + result)
        + section(t, 'antivirus-scans', msgid('Recent scans'), table(t, msgid('Recent scans'), [msgid('Started (UTC)'), msgid('Account'), msgid('Result'), msgid('Scanned files'), msgid('Infected files'), msgid('Job')], { 'data-whm-security-tools-rows': 'scans' }, msgid('No scans have been read.')))
        + section(t, 'antivirus-findings', msgid('Infected files'), `<p class="v2-muted" data-whm-security-tools-incomplete hidden>${esc(t(msgid('Some scans list only part of their findings. The infected file count comes from the scan summary.')))}</p>`
          + table(t, msgid('Infected files'), [msgid('Account'), msgid('Path'), msgid('Signature')], { 'data-whm-security-tools-rows': 'findings' }, msgid('No infected files have been read.')))
        + section(t, 'antivirus-updates', msgid('Signature updates'), table(t, msgid('Signature updates'), [msgid('Started (UTC)'), msgid('Result'), msgid('Signature version'), msgid('Job')], { 'data-whm-security-tools-rows': 'updates' }, msgid('No signature updates have been read.')))
  const titles = { intrusion: msgid('Intrusion detection'), isolation: msgid('Account isolation'), antivirus: msgid('Antivirus') }
  return page(input, `/whm/security/${kind}`, titles[kind], msgctxt('theme:v2', 'Host security observations retain their scope and verification state.'), body, { 'data-whm-security-tools-workspace': true, 'data-security-tools-page': kind, 'data-security-tools-can-read': String(canRead), 'data-security-tools-can-manage': String(canManage) })
}
