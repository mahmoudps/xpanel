import type { MessageValues } from './i18n.ts'
import './i18n.ts'
/// <reference lib="dom" />

export interface FilterSelection { scope: 'global' | 'mailbox'; mailbox: string | null }
export interface FilterCondition { field: string; comparator: string; value: string; headerName?: string }
export interface FilterAction { type: string; target?: string }
export interface FilterDraft { name: string; enabled: boolean; matchAll: boolean; conditions: FilterCondition[]; actions: FilterAction[] }
export interface FilterRecord extends FilterDraft { id: string; priority: number; createdAt: string; accountId: string; scope: string; mailbox: string | null; application: { state: 'applied' | 'pending' | 'failed'; reason: string | null } }
export interface FilterState { filters: FilterRecord[]; context: FilterSelection & { accountId: string }; revision: string; compilation: { status: string; reason?: string }; compiledSieve: string | null }
export interface FilterTraceStep { hidden: boolean; name: string | null; matched: boolean; stopped: boolean; tests: (FilterCondition & { actual: string[] | number; matched: boolean })[]; actions: FilterAction[] }
export interface FilterTraceView { rules: FilterTraceStep[]; notRun: number; outcome: { folders: string[]; redirects: (string | null)[]; discarded: boolean; rejected: string | null; markedRead: boolean; stopped: boolean } }
export function filterSelectionKey(selection: FilterSelection): string { return selection.scope === 'global' ? 'global' : 'mailbox:' + selection.mailbox }
function filterObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function filterActionsValid(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 10 && value.every(item => filterObject(item) && typeof item.type === 'string' && ['fileinto','redirect','discard','reject','keep','mark-read','stop'].includes(item.type) && (item.target === undefined || typeof item.target === 'string'))
}
export function readFilterState(value: unknown, expected: FilterSelection & { accountId: string }): FilterState {
  if (!filterObject(value) || !filterObject(value.context) || !filterObject(value.application) || !filterObject(value.compilation)) throw new Error('invalid_filter_response')
  const context = value.context, application = value.application, compilation = value.compilation
  if (typeof context.accountId !== 'string' || !context.accountId || context.accountId !== expected.accountId || context.scope !== expected.scope || context.mailbox !== expected.mailbox || !(application.generationId === null || Number.isSafeInteger(application.generationId)) || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision) || !['ready','blocked','selection_required'].includes(String(compilation.status)) || !Array.isArray(value.filters) || !(value.compiledSieve === null || typeof value.compiledSieve === 'string')) throw new Error('unverified_filter_scope')
  const ids = new Set<string>()
  for (const row of value.filters) {
    if (!filterObject(row) || row.accountId !== context.accountId || row.scope !== context.scope || row.mailbox !== context.mailbox || (compilation.status === 'ready' ? typeof row.id !== 'string' || !row.id : row.id !== null && typeof row.id !== 'string') || (typeof row.id === 'string' && ids.has(row.id))) throw new Error('foreign_or_invalid_filter')
    if(typeof row.id==='string')ids.add(row.id)
    if (typeof row.id === 'string' && (!filterObject(row.application) || !['applied','pending','failed'].includes(String(row.application.state)) || !(row.application.reason === null || typeof row.application.reason === 'string'))) throw new Error('unverified_filter_application')
    if (compilation.status === 'ready' && (typeof row.name !== 'string' || !Number.isSafeInteger(row.priority) || typeof row.enabled !== 'boolean' || typeof row.matchAll !== 'boolean' || !Array.isArray(row.conditions) || row.conditions.some(item => !filterObject(item) || typeof item.field !== 'string' || !['from','to','subject','header','body','size'].includes(item.field) || typeof item.comparator !== 'string' || !(item.field==='size'?['over','under']:['contains','is','matches']).includes(item.comparator) || typeof item.value !== 'string' || (item.headerName!==undefined&&typeof item.headerName!=='string')) || !filterActionsValid(row.actions) || typeof row.createdAt !== 'string')) throw new Error('invalid_filter_record')
  }
  if (compilation.status === 'ready' && typeof value.compiledSieve !== 'string') throw new Error('missing_filter_preview')
  if (compilation.status !== 'ready' && value.compiledSieve !== null) throw new Error('unverified_filter_preview')
  return value as unknown as FilterState
}
/** A dry-run reply for exactly the selected scope; hidden account-wide rules carry no names, values or addresses. */
export function readFilterTrace(value: unknown, expected: FilterSelection): FilterTraceView {
  if (!filterObject(value) || !filterObject(value.context) || value.context.scope !== expected.scope || value.context.mailbox !== expected.mailbox || !Array.isArray(value.rules) || !Number.isSafeInteger(value.notRun) || !filterObject(value.outcome)) throw new Error('unverified_filter_trace')
  const outcome = value.outcome
  if (!Array.isArray(outcome.folders) || outcome.folders.some(item => typeof item !== 'string') || !Array.isArray(outcome.redirects) || outcome.redirects.some(item => item !== null && typeof item !== 'string') || typeof outcome.discarded !== 'boolean' || !(outcome.rejected === null || typeof outcome.rejected === 'string') || typeof outcome.markedRead !== 'boolean' || typeof outcome.stopped !== 'boolean') throw new Error('invalid_filter_outcome')
  for (const step of value.rules) {
    if (!filterObject(step) || typeof step.hidden !== 'boolean' || typeof step.matched !== 'boolean' || typeof step.stopped !== 'boolean' || !Array.isArray(step.tests) || !Array.isArray(step.actions) || (step.hidden ? step.name !== null || step.tests.length > 0 || step.actions.some(item => !filterObject(item) || item.target !== undefined) : typeof step.name !== 'string')) throw new Error('invalid_filter_trace_step')
    if (step.actions.length && !filterActionsValid(step.actions)) throw new Error('invalid_filter_trace_action')
    if (step.tests.some(test => !filterObject(test) || typeof test.field !== 'string' || typeof test.comparator !== 'string' || typeof test.value !== 'string' || typeof test.matched !== 'boolean' || !(typeof test.actual === 'number' || Array.isArray(test.actual) && test.actual.every(item => typeof item === 'string')))) throw new Error('invalid_filter_trace_test')
  }
  return value as unknown as FilterTraceView
}
export function filterHasForbiddenControl(value: string): boolean { return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) }
export function filterWriteUncertain(error: unknown): boolean {
  const failure = filterObject(error) ? error : {}, details = filterObject(failure.details) ? failure.details : {}
  if (['verificationRequired','stateChanged','unknownOutcome','needsAttention'].some(key => failure[key] === true || details[key] === true)) return true
  return !(details.stateChanged === false || (typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500 && failure.status !== 408))
}
export function filterDraftMatches(record: FilterRecord, draft: FilterDraft): boolean {
  return record.name === draft.name && record.enabled === draft.enabled && record.matchAll === draft.matchAll && record.conditions.length === draft.conditions.length && record.conditions.every((condition,index) => { const wanted=draft.conditions[index]!; return condition.field===wanted.field && condition.comparator===wanted.comparator && condition.value===wanted.value && (condition.headerName??'')===(wanted.headerName??'') })
    && record.actions.length === draft.actions.length && record.actions.every((action,index) => action.type === draft.actions[index]!.type && (action.target ?? '') === (draft.actions[index]!.target ?? ''))
}

function bindAccountFilters(askDialog?: (options: Record<string, unknown>) => Promise<string | boolean | null>): void {
  document.querySelectorAll<HTMLElement>('[data-filter-workspace]').forEach(root => {
    if (root.dataset.filterBound === 'true') return
    root.dataset.filterBound = 'true'
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const copy = (message: string, values?: MessageValues) => xpT(message, values)
    const blockedAncestor = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const canManage = root.dataset.filterManage === 'true', fixedMailbox = root.dataset.filterMailbox ?? ''
    // a mailbox session learns its account from the first verified reply, then holds every later reply to it
    let expectedAccountId = root.dataset.filterAccount ?? ''
    const fieldLabels:Record<string,string>={from:copy(msgctxt('account-filters-client', 'From')),to:copy(msgctxt('account-filters-client', 'To')),subject:copy('Subject'),header:copy('Header'),body:copy('Body'),size:copy('Size'),contains:copy('contains'),is:copy('equals'),matches:copy('matches wildcards'),over:copy('over'),under:copy('under'),fileinto:copy('Move to folder'),redirect:copy('Redirect to address'),reject:copy('Reject with message'),keep:copy('Keep in Inbox'),discard:copy('Discard message'),'mark-read':copy('Mark as read'),stop:copy('Stop processing later rules')}
    const select = root.querySelector<HTMLSelectElement>('[data-filter-scope]'), form = root.querySelector<HTMLFormElement>('[data-filter-editor]')
    const status = root.querySelector<HTMLElement>('[data-filter-status]')!, list = root.querySelector<HTMLOListElement>('[data-filter-list]')!
    const testForm = root.querySelector<HTMLElement>('[data-filter-test]'), testStatus = root.querySelector<HTMLElement>('[data-filter-test-status]'), traceList = root.querySelector<HTMLOListElement>('[data-filter-trace]'), outcomeText = root.querySelector<HTMLElement>('[data-filter-outcome]')
    let selection: FilterSelection = fixedMailbox ? { scope:'mailbox', mailbox:fixedMailbox } : { scope:'global', mailbox:null }, state: FilterState | null = null, busy = false, uncertain = false, generation = 0, editing: string | null = null, draftRevision: string | null = null, dirty = false
    const note = (message: string, mode: string) => { status.textContent = message; status.dataset.state = mode; status.setAttribute('role', mode === 'failed' || mode === 'uncertain' ? 'alert' : 'status') }
    const ready = () => state !== null && state.compilation.status === 'ready'
    const control = () => {
      const blocked = !!root.closest(blockedAncestor)
      root.setAttribute('aria-busy', String(busy)); if (select) select.disabled = busy || blocked
      root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy || blocked || (button.hasAttribute('data-filter-write') && (!canManage || !(button.dataset.filterAction === 'delete' ? state !== null : ready()) || uncertain)) || (button.hasAttribute('data-filter-test-run') && !ready()) })
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('form input,form select,form textarea,[data-filter-test] input,[data-filter-test] textarea').forEach(field => { field.disabled = busy || blocked })
      root.querySelectorAll<HTMLButtonElement>('[data-filter-action="up"],[data-filter-action="down"]').forEach(button => { const index = Number(button.dataset.filterIndex); button.disabled ||= button.dataset.filterAction === 'up' ? index <= 0 : index >= (state?.filters.length ?? 0) - 1 })
    }
    const endpoint = (chosen = selection) => '/api/mail/filters?scope=' + chosen.scope + (chosen.scope === 'mailbox' ? '&mailbox=' + encodeURIComponent(chosen.mailbox!) : '')
    const accountOf = (raw: unknown) => expectedAccountId || (filterObject(raw) && filterObject(raw.context) && typeof raw.context.accountId === 'string' ? raw.context.accountId : '')
    const read = async (chosen: FilterSelection, token: number) => {
      if (!request) throw new Error('session_transport_unavailable')
      const raw = await request('GET', endpoint(chosen)), snapshot = readFilterState(raw, {...chosen,accountId:accountOf(raw)})
      if (token !== generation || filterSelectionKey(chosen) !== filterSelectionKey(selection)) throw Object.assign(new Error('stale_selection_response'), { status:409 })
      expectedAccountId = snapshot.context.accountId
      return snapshot
    }
    const technical = (value: string) => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.className = 'xp-mono'; bdi.textContent = value; return bdi }
    const conditionNodes = (target: HTMLElement, condition: FilterCondition) => { target.appendChild(document.createTextNode((fieldLabels[condition.field]??condition.field)+' '+(fieldLabels[condition.comparator]??condition.comparator)+' ')); if(condition.headerName){target.appendChild(technical(condition.headerName));target.appendChild(document.createTextNode(': '))} target.appendChild(technical(condition.value)) }
    const actionNodes = (target: HTMLElement, actions: FilterAction[]) => { actions.forEach((action, index) => { if(index) target.appendChild(document.createTextNode(' · ')); target.appendChild(document.createTextNode(fieldLabels[action.type]??action.type)); if(action.target){target.appendChild(document.createTextNode(': '));target.appendChild(technical(action.target))} }) }
    const paint = () => {
      if (!state) return
      list.textContent = ''
      const valid = state.compilation.status === 'ready'
      state.filters.forEach((row, index) => {
        const item = document.createElement('li'), title = document.createElement('h3')
        title.textContent = String(index + 1) + '. ' + (typeof row.name === 'string' ? row.name : copy('Name not available')); item.appendChild(title)
        if (valid) {
          const summary = document.createElement('p'); summary.dataset.filterSummary = ''
          summary.textContent = (row.enabled ? copy('Enabled configuration') : copy(msgctxt('account-filters-client', 'Disabled configuration'))) + ' · ' + (row.matchAll ? copy('All conditions') : copy('Any condition')); item.appendChild(summary)
          const host = document.createElement('p'); host.dataset.routingState = row.application.state
          host.textContent = row.application.state === 'applied' ? copy('Mail server: applied') : row.application.state === 'pending' ? copy('Mail server: saved, not applied yet') : row.application.reason ? copy('Mail server: not applied: {reason}', { reason: row.application.reason }) : copy('Mail server: not applied'); item.appendChild(host)
          const conditions = document.createElement('p')
          if (!row.conditions.length) conditions.textContent = copy('Unconditional: matches every message in this scope.')
          row.conditions.forEach((condition, n) => { if(n) conditions.appendChild(document.createElement('br')); conditionNodes(conditions, condition) }); item.appendChild(conditions)
          const action = document.createElement('p'); action.dataset.filterActions = ''; actionNodes(action, row.actions); item.appendChild(action)
          if (canManage) { const actions = document.createElement('div'); actions.className = 'xp-extension__actions'; for (const [kind, label] of [['edit',copy(msgctxt('account-filters-client', 'Edit'))],['toggle',row.enabled?copy('Disable configuration'):copy('Enable configuration')],['up',copy('Move up')],['down',copy('Move down')],['delete',copy('Delete configuration')]]) { const button = document.createElement('button'); button.type='button'; button.className='xp-btn'; button.dataset.filterAction=kind; button.dataset.filterId=row.id; button.dataset.filterIndex=String(index); button.dataset.filterWrite=''; button.textContent=label!; actions.appendChild(button) } item.appendChild(actions) }
        } else { const warning = document.createElement('p'); warning.textContent = copy('Saved metadata is blocked and has not been rewritten.'); item.appendChild(warning);if(canManage&&typeof row.id==='string'&&row.id){const remove=document.createElement('button');remove.type='button';remove.className='xp-btn';remove.dataset.filterAction='delete';remove.dataset.filterId=row.id;remove.dataset.filterWrite='';remove.textContent=copy('Delete configuration');item.appendChild(remove)} }
        list.appendChild(item)
      })
      const empty = root.querySelector<HTMLElement>('[data-filter-empty]')!; empty.hidden = state.filters.length > 0; empty.textContent = copy('No saved filters in this scope.')
      root.querySelector<HTMLElement>('[data-filter-count]')!.textContent = copy('{count} saved rules · evaluated in order', { count: state.filters.length })
      root.querySelector<HTMLElement>('[data-filter-compilation]')!.textContent = valid ? copy('Sieve rules for this scope. Each rule above shows whether the mail server runs it.') : copy('Preview blocked: {reason}', { reason: state.compilation.reason ?? state.compilation.status })
      root.querySelector<HTMLElement>('[data-filter-preview]')!.textContent = state.compiledSieve ?? ''
      control()
    }
    const refresh = async () => {
      if (busy || root.closest(blockedAncestor)) return
      const token = ++generation, chosen = {...selection}; busy=true; control(); note(copy('Reading configuration…'),'pending')
      try { state=await read(chosen,token); uncertain=false; paint(); note(copy('Filters read from the server.'), state.compilation.status==='ready'?'read':'blocked') }
      catch { state=null; note(copy('Configuration could not be verified. Editing is unavailable.'),'failed') }
      finally { busy=false;control() }
    }
    let rowNumber=0
    const selectFor=(values:string[],selected:string) => {const element=document.createElement('select');values.forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=fieldLabels[value]??value;element.appendChild(option)});element.value=selected;return element}
    const part = (row: HTMLElement, label:string,name:string,element:HTMLInputElement|HTMLSelectElement,key:string) => { const id='filter-row-'+String(++rowNumber); const wrap=document.createElement('div');wrap.className='xp-field';wrap.dataset[key]=name;const caption=document.createElement('label');caption.htmlFor=id;caption.textContent=label;element.id=id;element.dataset[key+'Field']=name;element.className=element instanceof HTMLSelectElement?'xp-select':'xp-input';wrap.append(caption,element);row.appendChild(wrap) }
    const removeButton = (row: HTMLElement, label: string, after: () => void) => { const remove=document.createElement('button');remove.type='button';remove.className='xp-btn';remove.textContent=label;remove.addEventListener('click',()=>{row.remove();dirty=true;after()});row.appendChild(remove) }
    const conditionsRoot = form?.querySelector<HTMLElement>('[data-filter-conditions]'), actionsRoot = form?.querySelector<HTMLElement>('[data-filter-actions]')
    const updateEmpty = () => { const empty=form?.querySelector<HTMLElement>('[data-filter-unconditional]'); if(empty) empty.hidden=!!conditionsRoot?.children.length }
    const addCondition = (condition: FilterCondition = {field:'subject',comparator:'contains',value:''}) => {
      if(!conditionsRoot) return
      const row=document.createElement('div');row.className='xp-filter-condition';row.dataset.filterCondition=''
      const which=selectFor(['from','to','subject','header','body','size'],condition.field), compare=selectFor(condition.field==='size'?['over','under']:['contains','is','matches'],condition.comparator)
      part(row,copy('Field'),'field',which,'condition');part(row,copy('Operator'),'comparator',compare,'condition')
      const header=document.createElement('input');header.value=condition.headerName??'';header.maxLength=64;header.dir='ltr';part(row,copy('Header name'),'headerName',header,'condition')
      const value=document.createElement('input');value.value=condition.value;value.maxLength=1024;value.required=true;part(row,copy('Match value / size in bytes or K/M/G'),'value',value,'condition')
      const sync=()=>{row.querySelector<HTMLElement>('[data-condition="headerName"]')!.hidden=which.value!=='header';header.required=which.value==='header'}
      which.addEventListener('change',()=>{compare.textContent='';(which.value==='size'?['over','under']:['contains','is','matches']).forEach(item=>{const option=document.createElement('option');option.value=item;option.textContent=fieldLabels[item]??item;compare.appendChild(option)});sync()});sync()
      removeButton(row,copy('Remove condition'),updateEmpty);conditionsRoot.appendChild(row);updateEmpty()
    }
    const addAction = (action: FilterAction = {type:'fileinto',target:''}) => {
      if(!actionsRoot) return
      const row=document.createElement('div');row.className='xp-filter-condition';row.dataset.filterActionRow=''
      const type=selectFor(['fileinto','redirect','keep','mark-read','reject','discard'],action.type)
      part(row,copy('Action'),'type',type,'action')
      const target=document.createElement('input');target.value=action.target??'';part(row,copy('Folder, address or rejection message'),'target',target,'action')
      const sync=()=>{const needed=['fileinto','redirect','reject'].includes(type.value);row.querySelector<HTMLElement>('[data-action="target"]')!.hidden=!needed;target.required=needed;target.type=type.value==='redirect'?'email':'text';target.dir=type.value==='redirect'?'ltr':'auto';target.maxLength=type.value==='fileinto'?255:1024}
      type.addEventListener('change',sync);sync()
      removeButton(row,copy('Remove action'),()=>undefined);actionsRoot.appendChild(row)
    }
    const value = (name:string) => form!.elements.namedItem(name) as HTMLInputElement|HTMLSelectElement
    const edit = (record?:FilterRecord) => {
      if(!form||!state||!ready()||uncertain)return
      editing=record?.id??null;draftRevision=state.revision;form.reset();conditionsRoot!.textContent='';actionsRoot!.textContent='';rowNumber=0
      value('name').value=record?.name??'';(value('enabled') as HTMLInputElement).checked=record?.enabled??true;value('matchAll').value=record?.matchAll===false?'any':'all'
      record?.conditions.forEach(condition=>addCondition(condition))
      const actions=record?record.actions:[{type:'fileinto',target:''},{type:'stop'}]
      actions.filter(action=>action.type!=='stop').forEach(action=>addAction(action));(value('stop') as HTMLInputElement).checked=actions[actions.length-1]?.type==='stop'
      updateEmpty();dirty=false;form.hidden=false;form.querySelector<HTMLElement>('[data-filter-editor-title]')!.textContent=record?copy('Edit filter configuration'):copy('Create filter configuration');value('name').focus()
    }
    const rowValue=(row:Element,key:string,name:string)=>(row.querySelector('[data-'+key+'-field="'+name+'"]') as HTMLInputElement|HTMLSelectElement).value
    const draft=():FilterDraft=>({name:value('name').value.trim(),enabled:(value('enabled') as HTMLInputElement).checked,matchAll:value('matchAll').value==='all',
      conditions:[...conditionsRoot!.querySelectorAll<HTMLElement>('[data-filter-condition]')].map(row=>{const read=(name:string)=>rowValue(row,'condition',name);let content=read('value');if(read('field')==='size')content=content.trim();if(read('field')==='size'&&/^\d+[KMG]?$/i.test(content)){const match=/^(\d+)([KMG])?$/i.exec(content)!;content=String(Number(match[1])*(({K:1024,M:1048576,G:1073741824} as Record<string,number>)[match[2]?.toUpperCase()??'']??1))}return{field:read('field'),comparator:read('comparator'),value:content,...(read('field')==='header'?{headerName:read('headerName')}: {})}}),
      actions:[...[...actionsRoot!.querySelectorAll<HTMLElement>('[data-filter-action-row]')].map(row=>{const type=rowValue(row,'action','type'),target=rowValue(row,'action','target');return {type,...(['fileinto','redirect','reject'].includes(type)?{target:type==='redirect'?target.trim().toLowerCase():target}:{})}}),...((value('stop') as HTMLInputElement).checked?[{type:'stop'}]:[])]})
    const mutate=async(method:string,path:string,payload:Record<string,unknown>,verify:(next:FilterState)=>boolean,expected=state?.revision)=>{
      if(!request||busy||uncertain||!canManage||!(method==='DELETE'?state!==null:ready())||root.closest(blockedAncestor)||!expected)return
      busy=true;control();const token=generation,chosen={...selection};let sent=false,acknowledged=false
      try { const fresh=await read(chosen,token);if(fresh.revision!==expected){state=fresh;paint();throw Object.assign(new Error('stale_filter_revision'),{status:409,details:{stateChanged:false}})}
        sent=true;const raw=await request(method,path,{...payload,expectedRevision:expected});const result=readFilterState(raw,{...chosen,accountId:expectedAccountId});acknowledged=true
        if(!filterObject(raw))throw new Error('invalid_write_acknowledgement')
        if(method==='POST'&&path==='/api/mail/filters'){if(!filterObject(raw.filter)||typeof raw.filter.id!=='string'||fresh.filters.some(item=>item.id===(raw.filter as Record<string,unknown>).id)||result.filters.length!==fresh.filters.length+1)throw new Error('create_not_acknowledged');const created=result.filters.find(item=>item.id===(raw.filter as Record<string,unknown>).id);if(!created||!filterDraftMatches(created,payload as unknown as FilterDraft))throw new Error('created_filter_mismatch')}
        else if(method==='PATCH'){if(!filterObject(raw.filter)||path!=='/api/mail/filters/'+encodeURIComponent(String(raw.filter.id)))throw new Error('edit_not_acknowledged')}
        else if(raw.ok!==true)throw new Error('mutation_not_acknowledged')
        if(!verify(result))throw new Error('filter_write_not_observed')
        const next=await read(chosen,token);if(next.revision!==result.revision||!verify(next))throw new Error('filter_readback_mismatch')
        state=next;paint();if(form&&!form.hidden&&['POST','PATCH','DELETE'].includes(method)&&!path.endsWith('/reorder')){form.hidden=true;dirty=false;editing=null;draftRevision=null}
        note(copy('Saved and read back. Each rule shows whether the mail server runs it.'),'saved')
      }catch(error){uncertain=sent&&(acknowledged||filterWriteUncertain(error));note(uncertain?copy('The saved state is uncertain. Refresh and review before another change. Your draft is kept.'):copy('The change was refused or the revision changed. Your draft is kept. Refresh, then reopen the editor from the current rule before saving.'),uncertain?'uncertain':'failed')}
      finally{busy=false;control()}
    }
    const paintTrace = (trace: FilterTraceView) => {
      if(!traceList||!outcomeText)return
      traceList.textContent=''
      trace.rules.forEach((step,index)=>{
        const item=document.createElement('li'),title=document.createElement('h4');item.dataset.traceMatched=String(step.matched)
        title.textContent=String(index+1)+'. '+(step.hidden?copy('Account-wide rule (details not shown)'):step.name!);item.appendChild(title)
        const verdict=document.createElement('p');verdict.textContent=(step.matched?copy('Matched'):copy('Did not match'))+(step.stopped?' · '+copy('Stopped processing'):'');item.appendChild(verdict)
        step.tests.forEach(test=>{const line=document.createElement('p');conditionNodes(line,test);line.appendChild(document.createTextNode(' — '+(test.matched?copy('Matched'):copy('Did not match'))+' · '));if(typeof test.actual==='number')line.appendChild(document.createTextNode(copy('Message size: {bytes} bytes',{bytes:test.actual})));else if(!test.actual.length)line.appendChild(document.createTextNode(copy('Not present in the message')));else{line.appendChild(document.createTextNode(copy('Read:')+' '));test.actual.forEach((actual,n)=>{if(n)line.appendChild(document.createTextNode(', '));line.appendChild(technical(actual))})}item.appendChild(line)})
        if(step.actions.length){const ran=document.createElement('p');ran.appendChild(document.createTextNode(copy('Ran:')+' '));actionNodes(ran,step.actions);item.appendChild(ran)}
        traceList.appendChild(item)
      })
      const outcome=trace.outcome,parts:string[]=[]
      if(outcome.rejected!==null)parts.push(copy('Rejected with: {message}',{message:outcome.rejected}))
      else if(outcome.discarded)parts.push(copy('Discarded'))
      if(outcome.folders.length)parts.push(copy('Delivered to: {folders}',{folders:outcome.folders.join(', ')}))
      if(outcome.redirects.length)parts.push(copy('Redirected to: {addresses}',{addresses:outcome.redirects.map(address=>address??copy('an address of an account-wide rule')).join(', ')}))
      if(outcome.markedRead)parts.push(copy('Marked as read'))
      if(trace.notRun)parts.push(copy('{count} later rules did not run',{count:trace.notRun}))
      outcomeText.textContent=copy('Result: {summary}',{summary:parts.join(' · ')})
    }
    testForm?.querySelector('[data-filter-test-run]')?.addEventListener('click',async()=>{
      if(!testForm||!request||busy||!ready()||root.closest(blockedAncestor)||!testStatus)return
      const field=(name:string)=>testForm.querySelector<HTMLInputElement|HTMLTextAreaElement>('[name="'+name+'"]')!.value
      if(['from','to','subject'].some(name=>filterHasForbiddenControl(field(name)))||/[\u0000\u2028\u2029]/.test(field('body'))){testStatus.textContent=copy('Remove control characters or line separators before testing.');return}
      const chosen={...selection},token=generation;busy=true;control();testStatus.textContent=copy('Testing…')
      try{const trace=readFilterTrace(await request('POST','/api/mail/filters/test',{scope:chosen.scope,...(chosen.mailbox?{mailbox:chosen.mailbox}:{}),message:{from:field('from'),to:field('to'),subject:field('subject'),body:field('body')}}),chosen);if(token!==generation)return;paintTrace(trace);testStatus.textContent=copy('Test finished. Nothing was delivered or sent.')}
      catch{if(traceList)traceList.textContent='';if(outcomeText)outcomeText.textContent='';testStatus.textContent=copy('The test could not run. Refresh the rules and check the sample message.')}
      finally{busy=false;control()}
    })
    root.querySelector('[data-filter-refresh]')?.addEventListener('click',()=>{void refresh()})
    root.querySelector('[data-filter-new]')?.addEventListener('click',()=>{if(!dirty)edit();else note(copy('Finish or cancel the current draft first.'),'failed')})
    root.querySelector('[data-filter-add-condition]')?.addEventListener('click',()=>{addCondition();dirty=true})
    root.querySelector('[data-filter-add-action]')?.addEventListener('click',()=>{addAction();dirty=true})
    root.querySelector('[data-filter-cancel]')?.addEventListener('click',()=>{if(form){form.hidden=true;dirty=false;editing=null;draftRevision=null}})
    form?.addEventListener('input',()=>{dirty=true});form?.addEventListener('change',()=>{dirty=true})
    form?.addEventListener('submit',event=>{event.preventDefault();if([...form.querySelectorAll<HTMLInputElement>('input')].some(input=>filterHasForbiddenControl(input.value))){note(copy('Remove control characters or line separators before saving. Your draft is kept.'),'failed');return}if(!form.reportValidity())return;const payload=draft();if(!payload.actions.length){note(copy('Add at least one action. Your draft is kept.'),'failed');return}const id=editing;void mutate(id?'PATCH':'POST','/api/mail/filters'+(id?'/'+encodeURIComponent(id):''),{...payload,...(!id?{scope:selection.scope,...(selection.mailbox?{mailbox:selection.mailbox}:{})}:{})},next=>id?next.filters.some(row=>row.id===id&&filterDraftMatches(row,payload)):next.filters.some(row=>filterDraftMatches(row,payload)),draftRevision??undefined)})
    select?.addEventListener('change',async()=>{
      const before=filterSelectionKey(selection),wanted=select.value;if(busy){select.value=before;return}
      if(dirty){
        const confirmationGeneration=generation
        let confirmed:string|boolean|null=false
        busy=true;control()
        try{confirmed=askDialog?await askDialog({title:copy('Discard this draft?'),body:copy('Changing scope discards the unsaved draft.'),confirm:copy('Discard draft'),danger:true}):false}
        catch{note(copy('Confirmation is unavailable. Your draft is kept.'),'failed')}
        finally{busy=false;control()}
        if(confirmed!==true||confirmationGeneration!==generation||filterSelectionKey(selection)!==before){select.value=filterSelectionKey(selection);control();return}
      }
      selection=wanted==='global'?{scope:'global',mailbox:null}:{scope:'mailbox',mailbox:wanted.slice(8)};state=null;generation++;uncertain=false;dirty=false;editing=null;draftRevision=null;if(form)form.hidden=true;list.textContent='';if(traceList)traceList.textContent='';if(outcomeText)outcomeText.textContent='';root.querySelector<HTMLElement>('[data-filter-preview]')!.textContent='';root.querySelector<HTMLElement>('[data-filter-count]')!.textContent='';root.querySelector<HTMLElement>('[data-filter-compilation]')!.textContent=copy(msgctxt('account-filters-client', 'Not read'));await refresh()
    })
    root.addEventListener('click',async event=>{
      const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('[data-filter-action]'):null;if(!button||button.disabled||busy||uncertain||!state||(!ready()&&button.dataset.filterAction!=='delete')||!canManage)return
      const row=state.filters.find(item=>item.id===button.dataset.filterId);if(!row)return
      const action=button.dataset.filterAction
      if(action==='edit'){if(!dirty)edit(row);else note(copy('Finish or cancel the current draft first.'),'failed');return}
      if(dirty){note(copy('Finish or cancel the current draft before changing saved rules.'),'failed');return}
      if(action==='delete'){const token=generation;busy=true;control();const confirmed=askDialog?await askDialog({title:copy('Delete filter configuration'),body:typeof row.name==='string'?row.name:copy('Delete this saved configuration?'),confirm:copy('Delete configuration'),danger:true}):false;busy=false;control();if(confirmed!==true||token!==generation)return;void mutate('DELETE','/api/mail/filters/'+encodeURIComponent(row.id),{},next=>!next.filters.some(item=>item.id===row.id));return}
      if(action==='toggle'){void mutate('PATCH','/api/mail/filters/'+encodeURIComponent(row.id),{enabled:!row.enabled},next=>next.filters.some(item=>item.id===row.id&&item.enabled===!row.enabled));return}
      const index=state.filters.findIndex(item=>item.id===row.id),other=action==='up'?index-1:index+1;if(other<0||other>=state.filters.length)return
      const ids=state.filters.map(item=>item.id);[ids[index],ids[other]]=[ids[other]!,ids[index]!]
      void mutate('POST','/api/mail/filters/reorder',{scope:selection.scope,...(selection.mailbox?{mailbox:selection.mailbox}:{}),orderedIds:ids},next=>JSON.stringify(next.filters.map(item=>item.id))===JSON.stringify(ids))
    })
    control();void refresh()
  })
}

export const ACCOUNT_FILTERS_CLIENT_BINDING = `(function(askDialog) { ${filterSelectionKey.toString()}; ${filterObject.toString()}; ${filterActionsValid.toString()}; ${readFilterState.toString()}; ${readFilterTrace.toString()}; ${filterWriteUncertain.toString()}; ${filterHasForbiddenControl.toString()}; ${filterDraftMatches.toString()}; (${bindAccountFilters.toString()})(askDialog); })`
