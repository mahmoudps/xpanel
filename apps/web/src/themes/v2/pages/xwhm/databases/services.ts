import { DB_QUOTA_SECTION, PMA_ACCESS_SECTION, dbServiceSections } from '../../../../../models/db-services.ts'
import type { DbSection, DbSectionField, DbSectionPart, DbServiceEngine } from '../../../../../models/db-services.ts'
import type { HookAttributes } from '../../../html.ts'
import { actions, button, check, context, esc, facts, field, fields, note, section, status, table, type WhmDataPageInput } from '../software/common.ts'

export type WhmDbServiceEngine = DbServiceEngine | 'mysql'

const MYSQL_SERVICE_SECTIONS: readonly DbSection[] = [
  {
    key: 'service',
    title: msgid('MariaDB / MySQL service'),
    parts: [
      { kind: 'status', hook: 'data-dbs-status', text: msgid('The service has not been read.') },
      { kind: 'facts', attribute: 'data-dbs-fact', rows: [['state', msgid('Service')], ['boot', msgid('Starts at boot')], ['version', msgid('Running version')], ['dataDirectory', msgid('Data directory')], ['listen', msgid('Listen address and port')]] },
      { kind: 'actions', buttons: [{ label: msgid('Start'), hook: 'data-dbs-control', value: 'start' }, { label: msgid('Stop'), hook: 'data-dbs-control', value: 'stop' }, { label: msgid('Restart'), hook: 'data-dbs-control', value: 'restart' }, { label: msgid('Start at boot'), hook: 'data-dbs-control', value: 'enable' }, { label: msgid('Do not start at boot'), hook: 'data-dbs-control', value: 'disable' }] },
    ],
  },
  {
    key: 'settings',
    title: msgid('MariaDB / MySQL settings'),
    parts: [
      {
        kind: 'fields',
        fields: [
          { id: 'db-mysql-port', label: msgid('Port'), hook: 'data-dbs-field', value: 'port', type: 'number', dir: 'ltr' },
          { id: 'db-mysql-bindAddress', label: msgid('Listen address'), hook: 'data-dbs-field', value: 'bindAddress', dir: 'ltr' },
          { id: 'db-mysql-maxConnections', label: msgid('Maximum connections'), hook: 'data-dbs-field', value: 'maxConnections', type: 'number', dir: 'ltr' },
        ],
      },
      { kind: 'check', label: msgid('Disable TCP/IP networking (skip_networking)'), hook: 'data-dbs-field', value: 'skipNetworking' },
      { kind: 'actions', buttons: [{ label: msgid('Preview configuration'), hook: 'data-dbs-preview' }, { label: msgid('Save settings'), hook: 'data-dbs-settings-save', primary: true }] },
      { kind: 'note', text: msgid('Writes 90-xpanel-mysql.cnf, validates with mariadbd, restarts the service, and rolls back automatically if MariaDB does not answer.') },
    ],
  },
  {
    key: 'config',
    title: msgid('Configuration drop-in'),
    parts: [{ kind: 'editor', file: 'config', label: msgid('Configuration drop-in (90-xpanel-mysql.cnf)') }],
  },
  {
    key: 'log',
    title: msgid('Log'),
    parts: [{ kind: 'log' }],
  },
]

/** V2 drawing of the database service tools, with the hooks the classic theme uses. */
type Translate = ReturnType<typeof context>['t']
const hook = (name: string, value?: string): HookAttributes => ({ [name]: value ?? true })
function control(t: Translate, row: DbSectionField): string {
  const hooks = hook(row.hook, row.value)
  if (row.options) return field(row.id, t(row.label), { kind: 'select', disabled: true, hooks, options: row.options.map(([value, label]) => ({ value, label: t(label) })) })
  if (row.textarea) return field(row.id, t(row.label), { kind: 'textarea', rows: 4, disabled: true, dir: 'ltr', hooks })
  return field(row.id, t(row.label), { kind: 'input', type: row.type === 'number' ? 'number' : row.type === 'password' ? 'password' : 'text', disabled: true, autocomplete: row.type === 'password' ? 'new-password' : 'off', ...(row.dir ? { dir: row.dir } : {}), hooks })
}
function part(t: Translate, row: DbSectionPart, key: string): string {
  switch (row.kind) {
    case 'facts': return facts(t, row.rows, row.attribute)
    case 'fields': return fields(row.fields.map(item => control(t, item)).join(''))
    case 'check': return check(t(row.label), hook(row.hook, row.value))
    case 'actions': return actions(row.buttons.map(item => button(t(item.label), hook(item.hook, item.value), true, item.primary === true)).join(''))
    case 'table': return table(t, t(row.title), row.headers, hook(row.hook, row.hook === 'data-dbs-rows' ? row.value : undefined))
    case 'note': return note(t(row.text))
    case 'status': return status(t(row.text), hook(row.hook))
    case 'editor': return `<div class="v2-whm-data__stack" data-dbs-file="${esc(row.file)}">${field(`v2-db-file-${key}`, t(row.label), { kind: 'textarea', rows: 14, disabled: true, dir: 'ltr', spellcheck: false, hooks: { 'data-dbs-file-text': true } })}${actions(button(t(msgid('Load file')), { 'data-dbs-file-load': true }) + button(t(msgid('Save file')), { 'data-dbs-file-save': true }, true, true))}</div>`
    case 'upload': return `<div class="v2-field"><label for="${esc(row.id)}">${esc(t(row.label))}</label><input id="${esc(row.id)}" type="file" accept=".gz" ${row.hook} disabled></div>`
    case 'log': return actions(button(t(msgid('Read log')), { 'data-dbs-log-read': true })) + `<pre class="v2-mono" dir="ltr" tabindex="0" data-dbs-log></pre>`
  }
}
const draw = (t: Translate, item: DbSection, hooks?: HookAttributes): string => section(`db-${item.key}`, t(item.title), item.parts.map(row => part(t, row, item.key)).join('') + (item.key === 'settings' ? `<pre class="v2-mono" dir="ltr" tabindex="0" data-dbs-preview-diff></pre>` : ''), hooks)
const can = (input: WhmDataPageInput, allowed: boolean | undefined): string => String(context(input).canRead && allowed === true)

export function dbServiceWorkspace(input: WhmDataPageInput, engine: WhmDbServiceEngine, allowed: boolean | undefined): string {
  const { t } = context(input)
  const sections = engine === 'mysql' ? MYSQL_SERVICE_SECTIONS : dbServiceSections(engine)
  return `<div class="v2-whm-data__stack" data-db-service="${engine}" data-can-manage="${can(input, allowed)}">${sections.map(item => draw(t, item)).join('')}</div>`
}
export const dbQuotaTool = (input: WhmDataPageInput, allowed: boolean | undefined): string => draw(context(input).t, DB_QUOTA_SECTION, { 'data-db-quota-tool': true, 'data-can-manage': can(input, allowed) })
export const pmaAccessTool = (input: WhmDataPageInput, allowed: boolean | undefined): string => draw(context(input).t, PMA_ACCESS_SECTION, { 'data-db-pma-access': true, 'data-can-manage': can(input, allowed) })
