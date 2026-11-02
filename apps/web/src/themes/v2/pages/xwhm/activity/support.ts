import { v2WhmClientTemplates } from '../../../whm-client-templates.ts'
import { actions, button, check, context, esc, facts, help, link, page, section, status, table, type WhmObservationInput } from '../monitoring/common.ts'

export function renderV2WhmSupport(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const list = (key: string, label: string) => `<div class="v2-observation__groups"><h3>${esc(t(label))}</h3><ul class="v2-observation__list" data-whm-support-${key}><li>${esc(t(msgid('The manifest has not been read.')))}</li></ul></div>`
  const body = section(t, 'support-summary', msgid('Support summary'), help(t, msgid('Facts read from this server for a support request. A value that could not be read is shown as not read or not verified, never assumed.'))
    + actions(button(t, msgctxt('whm-support-workspace', 'Read again'), { 'data-whm-support-refresh': true }, canRead, true))
    + status(t, canRead ? msgid('The support summary has not been read.') : msgid('Support requires an authorized root administrator on a qualified host. Nothing was read.'), { 'data-whm-support-status': true }, canRead ? 'unread' : 'unavailable')
    + facts(t, [['panel-version', msgid('Panel version')], ['release-path', msgid('Release directory')], ['os', msgid('Operating system')], ['os-profile', msgid('OS profile')], ['uptime', msgid('Uptime')], ['node', msgid('Agent Node.js runtime')], ['observed-at', msgid('Observed at (UTC)')]], 'data-whm-support-fact'))
    + section(t, 'support-services', msgid('Services'), help(t, msgid('State of each service the panel manages, from systemctl.')) + table(t, msgid('Services'), [msgid('Service'), msgid('Unit'), msgid('State')], { 'data-whm-support-services': true }, msgid('No services have been read.')))
    + section(t, 'support-config', msgctxt('whm-support-workspace', 'Configuration'), facts(t, [['generation', msgid('Active generation')], ['generation-activated', msgid('Activated at (UTC)')], ['generation-checksum', msgid('File-set checksum')], ['drift', msgid('Configuration drift')]], 'data-whm-support-fact') + actions(link(t, msgid('Open the repair center'), '/whm/monitoring/repair')))
    + section(t, 'support-jobs', msgid('Recent failed jobs'), help(t, msgid('The 10 most recent host jobs that failed.')) + table(t, msgid('Recent failed jobs'), [msgid('Job'), msgid('Kind'), msgid('Failure'), msgid('Finished (UTC)'), msgctxt('whm-support-workspace', 'Error')], { 'data-whm-support-jobs': true }, msgid('No failed jobs have been read.')) + actions(link(t, msgid('Open all jobs'), '/whm/jobs')))
    + section(t, 'support-bundle', msgid('Support bundle'), help(t, msgid('The bundle is one JSON document generated on demand. It contains only the items below, after the redaction rules below. Review the manifest, confirm, then download. Nothing is sent anywhere; you decide whom to share the file with.'))
      + facts(t, [['manifest-id', msgid('Manifest')]], 'data-whm-support-fact') + list('included', msgid('Included')) + list('excluded', msgid('Never included')) + list('redaction', msgid('Redaction rules'))
      + help(t, msgid('Hashing is described after the manifest is read.'), { 'data-whm-support-hashing': true })
      + check(t, msgid('I reviewed this manifest. The download contains only the items it lists.'), { 'data-whm-support-confirm': true })
      + actions(button(t, msgid('Download support bundle'), { 'data-whm-support-download': true }, false, true)) + status(t, canRead ? msgid('Read the manifest before downloading.') : msgid('The support bundle is unavailable here. Nothing was generated.'), { 'data-whm-support-bundle-status': true }))
    + section(t, 'support-contact', msgid('Contact'), `<div class="v2-observation__groups" data-whm-support-contact>${help(t, msgid('The support contact has not been read.'))}</div>`)
  return page(input, '/whm/support', msgid('Support'), msgid('Observed support facts, a redacted diagnostics bundle you review before downloading, and the support contact the server owner configured.'), v2WhmClientTemplates('support') + body, { 'data-whm-support-workspace': true, 'data-support-can-read': String(canRead) })
}
