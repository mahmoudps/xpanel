/** Markup owned by this theme for authenticated database, DNS and TLS refreshes. */
// data-list-row admits the row to the generic list filter of a page that marks one.
const row = (name: string, cells: string, listed = false): string => `<template data-xp-template="${name}"><tr${listed ? ' data-list-row' : ''}>${cells}</tr></template>`
// A label names the value on a phone, where the column header is not shown.
const value = (slot: string, technical = false, label = ''): string => `<td${label ? ` data-label="${label}"` : ''}>${technical ? `<bdi dir="ltr" class="v2-mono" data-xp-slot="${slot}"></bdi>` : `<span data-xp-slot="${slot}"></span>`}</td>`
const empty = (name: string, columns: number): string => row(name, `<td colspan="${columns}" data-xp-slot="message"></td>`)
const action = (slot: string, label: string): string => `<button type="button" class="v2-btn" data-xp-slot="${slot}" disabled>${label}</button>`
const fact = (name: string): string => `<template data-xp-template="${name}"><div class="v2-db-fact"><dt data-xp-slot="label"></dt><dd><bdi dir="ltr" data-xp-slot="value"></bdi></dd></div></template>`

export function databaseWorkspaceTemplates(t: (message: string) => string): string {
 return row('database-row', value('name',true)+value('size',false,t('Size'))+value('tables',false,t('Tables'))+value('users',true,t('Users with access'))+value('collation',false,t('Collation'))+value('last-write',false,t('Last write'))+`<td><div class="v2-db-actions">${action('rename',t(msgctxt('database-workspace-client','Rename')))}${action('export',t('Export'))}${action('import',t('Import'))}${action('trash',t('Move to trash'))}</div></td>`)
  + row('database-user-row',value('name',true)+value('grants',true,t('Databases and privileges'))+value('last-connection',false,t('Last connection'))+`<td><div class="v2-db-actions">${action('privileges',t('Privileges'))}${action('password',t('Change password'))}${action('delete',t('Delete'))}</div></td>`)
  + row('database-trash-row',value('name',true)+`<td data-label="${t('Trashed at')}"><bdi dir="ltr" class="v2-mono"><time data-xp-slot="trashed"></time></bdi></td>`+value('retention',false,t('Retention'))+`<td><div class="v2-db-actions">${action('restore',t('Restore'))}${action('drop',t(msgctxt('database-workspace-client','Drop permanently')))}</div></td>`)
  + empty('database-empty',7)+empty('database-user-empty',4)+empty('database-trash-empty',4)+fact('database-fact')+'<template data-xp-template="database-token"><bdi dir="ltr" class="v2-mono" data-xp-slot="value"></bdi></template>'
}
export function databaseInsightsTemplates(t: (message: string) => string = () => ''): string {
 return row('insights-database-row',value('name',true)+value('server',false,t('On server'))+value('tables',true,t('Tables'))+value('data',true,t('Data'))+value('indexes',true,t('Indexes'))+value('free',true,t('Free space'))+value('collation',true,t('Collation')))
  +row('insights-table-row',value('name',true)+value('engine',true,t('Engine'))+value('rows',true,t('Rows (estimate)'))+value('data',true,t('Data'))+value('indexes',true,t('Indexes'))+value('free',true,t('Free space')))
  +row('insights-user-row',value('name',true)+value('server',false,t('On server'))+value('hosts',true,t('Host entries')))
  +empty('insights-database-empty',7)+empty('insights-table-empty',6)+empty('insights-user-empty',3)+'<template data-xp-template="insights-state"><span class="v2-pill v2-pill--neutral" data-state-chip><span class="v2-pill__dot" aria-hidden="true"></span><span data-xp-slot="label"></span></span></template>'
}
export function databaseRemoteTemplates(t: (message: string) => string): string {
 return row('database-remote-row',value('host',true)+value('comment',false,t('Comment'))+value('created',true,t('Added (UTC)'))+value('firewall',false,t('Firewall'))+value('grants',false,t('Grants'))+`<td>${action('manage',t('Manage'))}</td>`)+empty('database-remote-empty',6)
}
export function dnsEditorTemplates(t: (message: string) => string, whm = false): string {
 const labels: Record<string,string>={name:t('Record name'),type:t('Record type'),ttl:'TTL',content:t('Record content'),priority:t('Priority')}
 const cells=['name','type','ttl','content','priority'].map(name=>{
  const common=`class="${name==='type'?'':''}" dir="ltr" data-xp-slot="${name}" ${whm?'data-field':'data-zone-field'}="${name}" aria-label="${labels[name]}" disabled`
  const input=name==='type'?`<select ${common} data-list-field="type"></select>`:`<input ${common} type="${name==='ttl'||name==='priority'?'number':'text'}"${name==='ttl'||name==='priority'?' min="0" step="1"':''}>`
  return `<td>${whm?`<label data-xp-slot="${name}-label">${labels[name]}</label>`:''}${input}</td>`
 }).join('')
 return row('dns-record-row',cells+`<td>${action('remove',t('Remove record'))}</td>`,true)+empty('dns-record-empty',6)
  +(whm?row('dns-zone-row',value('name',true)+value('account')+value('records',true)+value('serial',true)+value('provider'))+empty('dns-zone-empty',5):'')
}
export function accountSslTemplates(): string {
 return row('account-ssl-row','<td data-xp-slot="names"></td>'+`<td><bdi dir="auto" data-xp-slot="issuer"></bdi><p data-xp-slot="issuer-note" hidden></p></td><td><time dir="ltr" data-xp-slot="expires"></time><p data-xp-slot="expiry-note" hidden></p></td><td><span data-xp-slot="renewal"></span><p data-xp-slot="renewal-note" hidden></p></td>`+value('installed',true)+`<td><div class="v2-panel-service__actions" data-xp-slot="actions"></div></td>`)
  +empty('account-ssl-empty',6)+fact('account-ssl-fact')+'<template data-xp-template="account-ssl-name"><div><bdi dir="ltr" data-xp-slot="value"></bdi></div></template><template data-xp-template="account-ssl-action">'+action('label','')+'</template>'
}
export function accountCronTemplates(): string {
 // Run facts hold a time or a localized "Not observed": direction follows the content, in the body font.
 const observed=(slot:string):string=>`<td><bdi dir="auto" class="v2-num" data-xp-slot="${slot}"></bdi></td>`
 return row('account-cron-row',value('name')+value('schedule',true)+value('command',true)+observed('last-run')+observed('duration')+observed('next-run')+`<td><div class="v2-panel-service__actions" data-xp-slot="actions"></div></td>`,true)+empty('account-cron-empty',7)+'<template data-xp-template="account-cron-action">'+action('label','')+'</template>'
}
export function whmSslTemplates(): string {
 return row('whm-ssl-row',value('names',true)+value('account')+value('source')+value('challenge')+value('expires',true)+value('renewal')+value('status')+`<td><div class="v2-whm-network__actions" data-xp-slot="actions"></div></td>`)+empty('whm-ssl-empty',8)+fact('whm-ssl-fact')+'<template data-xp-template="whm-ssl-action">'+action('label','')+'</template>'
}

export function dbEngineTemplates(t: (message: string) => string = () => ''): string {
 return row('engine-packages-row',value('name',true)+value('installed',true)+value('candidate',true)+value('origin')+value('security'))+empty('engine-packages-empty',5)
  +row('engine-databases-row',value('name',true)+value('owner',true,t('Owner role'))+value('size',true,t('Size'))+value('state',false,t('Status'))+'<td data-xp-slot="actions"></td>')+empty('engine-databases-empty',5)
  +row('engine-roles-row',value('name',true)+value('login',false,t('Can sign in'))+'<td data-xp-slot="actions"></td>')+empty('engine-roles-empty',3)
  +'<template data-xp-template="engine-action">'+action('label','')+'</template><template data-xp-template="engine-actions"><div class="v2-whm-data__actions" data-xp-slot="actions"></div></template>'
}
export function whmDatabaseTemplates(): string {
 return row('whm-db-accounts-row',value('account',true)+value('owner',true)+value('status')+value('databases',true)+value('trash',true)+value('users',true)+value('grants',true)+value('size',true))+empty('whm-db-accounts-empty',8)
  +row('whm-db-databases-row',value('name',true)+value('account',true)+value('state')+value('size',true)+value('tables',true)+`<td data-xp-slot="drift"></td>`)+empty('whm-db-databases-empty',6)
  +row('whm-db-users-row',value('user',true)+value('host',true)+value('account',true)+value('grants',true)+value('role')+`<td data-xp-slot="drift"></td>`)+empty('whm-db-users-empty',6)
  +row('whm-db-processes-row',value('connection',true)+value('user',true)+value('account',true)+value('host',true)+value('database',true)+value('command',true)+value('seconds',true)+value('state',true)+'<td data-xp-slot="actions"></td>')+empty('whm-db-processes-empty',9)
  +row('whm-db-engines-row',value('engine',true)+value('state')+value('unit',true)+value('version',true)+value('databases',true))+empty('whm-db-engines-empty',5)
  +row('whm-db-maintenance-row',value('table',true)+value('engine',true)+value('result')+value('message'))+empty('whm-db-maintenance-empty',4)
  +'<template data-xp-template="whm-db-kill">'+action('label','')+'</template>'
  + [['in-sync','v2-pill v2-pill--ok'],['saved-only','v2-pill v2-pill--warn'],['server-only','v2-pill v2-pill--warn'],['system','v2-pill v2-pill--neutral'],['unverified','v2-pill v2-pill--neutral']].map(([state,classes])=>`<template data-xp-template="whm-db-drift-${state}"><span class="${classes}"><span class="v2-pill__dot" aria-hidden="true"></span><span data-xp-slot="label"></span></span></template>`).join('')
}
export function databaseTuningTemplates(): string {
 return '<template data-xp-template="db-tuning-row"><tr><th scope="row"><bdi dir="ltr" class="v2-mono" data-xp-slot="name"></bdi></th><td><bdi dir="ltr" class="v2-mono" data-xp-slot="value"></bdi></td></tr></template>'
  +'<template data-xp-template="db-tuning-check"><article class="v2-whm-data__stack"><div class="v2-whm-data__actions"><h3 data-xp-slot="title"></h3><span class="v2-pill v2-pill--neutral" data-xp-slot="state"></span></div><p class="v2-muted" data-xp-slot="description"></p><dl class="v2-whm-data__facts" data-xp-slot="evidence" hidden></dl></article></template>'
  +'<template data-xp-template="db-tuning-evidence"><div class="v2-whm-data__fact"><dt><bdi dir="ltr" data-xp-slot="name"></bdi></dt><dd><bdi dir="ltr" data-xp-slot="value"></bdi></dd></div></template>'
}
export function sslObservationTemplates(): string {
 return row('ssl-observation-queue-row',value('names',true)+value('next',true)+value('reason')+value('attempts',true)+value('state')+'<td data-xp-slot="actions"></td>')+empty('ssl-observation-queue-empty',6)
  +row('ssl-observation-log-row',value('when',true)+value('names',true)+value('challenge')+value('result')+value('message'))+empty('ssl-observation-log-empty',5)
  +'<template data-xp-template="ssl-observation-action">'+action('label','')+'</template>'
}
export function sslInstallTemplates(): string {
 return '<template data-xp-template="ssl-install-name"><label><input type="checkbox" data-xp-slot="checkbox"><bdi dir="ltr" class="v2-mono" data-xp-slot="name"></bdi></label></template>'
}
export function dnsToolsTemplates(): string {
 const schemas:Readonly<Record<string,readonly string[]>>={zones:['select','zone','records','ttl'],jobs:['summary','zones','status','created','finished','actions'],results:['zone','state','records','errors','warnings','messages'],compare:['zone','saved','file','published','saved-ns','published-ns','drift'],nameservers:['zone','soa','host','addresses','result'],preview:['zone','records','changes','ttl','state'],applied:['zone','changes','state']}
 return Object.entries(schemas).map(([name,slots])=>row('dns-tools-'+name+'-row',slots.map(slot=>value(slot)).join(''))+empty('dns-tools-'+name+'-empty',slots.length)).join('')
  +'<template data-xp-template="dns-tools-job-action">'+action('label','')+'</template><template data-xp-template="dns-tools-zone-select"><input type="checkbox" data-xp-slot="checkbox"></template>'
}
