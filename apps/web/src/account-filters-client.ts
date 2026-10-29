import type { MessageValues } from './i18n.ts'
import './i18n.ts'
/// <reference lib="dom" />

export interface FilterSelection { scope: 'global' | 'mailbox'; mailbox: string | null }
export interface FilterCondition { field: string; comparator: string; value: string; headerName?: string }
export interface FilterDraft { name: string; enabled: boolean; matchAll: boolean; conditions: FilterCondition[]; action: { type: string; target?: string } }
export interface FilterRecord extends FilterDraft { id: string; priority: number; createdAt: string; accountId: string; scope: string; mailbox: string | null }
export interface FilterState { filters: FilterRecord[]; context: FilterSelection & { accountId: string }; revision: string; compilation: { status: string; reason?: string }; compiledSieve: string | null }
export function filterSelectionKey(selection: FilterSelection): string { return selection.scope === 'global' ? 'global' : 'mailbox:' + selection.mailbox }
function filterObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function readFilterState(value: unknown, expected: FilterSelection & { accountId: string }): FilterState {
  if (!filterObject(value) || !filterObject(value.context) || !filterObject(value.application) || !filterObject(value.compilation)) throw new Error('invalid_filter_response')
  const context = value.context, application = value.application, compilation = value.compilation
  if (typeof context.accountId !== 'string' || !context.accountId || context.accountId !== expected.accountId || context.scope !== expected.scope || context.mailbox !== expected.mailbox || application.status !== 'configuration_only' || application.nativeApplied !== false || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision) || !['ready','blocked','selection_required'].includes(String(compilation.status)) || !Array.isArray(value.filters) || !(value.compiledSieve === null || typeof value.compiledSieve === 'string')) throw new Error('unverified_filter_scope')
  const ids = new Set<string>()
  for (const row of value.filters) {
    if (!filterObject(row) || row.accountId !== context.accountId || row.scope !== context.scope || row.mailbox !== context.mailbox || (compilation.status === 'ready' ? typeof row.id !== 'string' || !row.id : row.id !== null && typeof row.id !== 'string') || (typeof row.id === 'string' && ids.has(row.id))) throw new Error('foreign_or_invalid_filter')
    if(typeof row.id==='string')ids.add(row.id)
    if (compilation.status === 'ready' && (typeof row.name !== 'string' || !Number.isSafeInteger(row.priority) || typeof row.enabled !== 'boolean' || typeof row.matchAll !== 'boolean' || !Array.isArray(row.conditions) || row.conditions.some(item => !filterObject(item) || typeof item.field !== 'string' || !['from','to','subject','header','body','size'].includes(item.field) || typeof item.comparator !== 'string' || !(item.field==='size'?['over','under']:['contains','is','matches']).includes(item.comparator) || typeof item.value !== 'string' || (item.headerName!==undefined&&typeof item.headerName!=='string')) || !filterObject(row.action) || typeof row.action.type !== 'string' || !['fileinto','redirect','discard','reject','keep'].includes(row.action.type) || (row.action.target!==undefined&&typeof row.action.target!=='string') || typeof row.createdAt !== 'string')) throw new Error('invalid_filter_record')
  }
  if (compilation.status === 'ready' && typeof value.compiledSieve !== 'string') throw new Error('missing_filter_preview')
  if (compilation.status !== 'ready' && value.compiledSieve !== null) throw new Error('unverified_filter_preview')
  return value as unknown as FilterState
}
export function filterHasForbiddenControl(value: string): boolean { return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) }
export function filterWriteUncertain(error: unknown): boolean {
  const failure = filterObject(error) ? error : {}, details = filterObject(failure.details) ? failure.details : {}
  if (['verificationRequired','stateChanged','unknownOutcome','needsAttention'].some(key => failure[key] === true || details[key] === true)) return true
  return !(details.stateChanged === false || (typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500 && failure.status !== 408))
}
export function filterDraftMatches(record: FilterRecord, draft: FilterDraft): boolean {
  return record.name === draft.name && record.enabled === draft.enabled && record.matchAll === draft.matchAll && record.conditions.length === draft.conditions.length && record.conditions.every((condition,index) => { const wanted=draft.conditions[index]!; return condition.field===wanted.field && condition.comparator===wanted.comparator && condition.value===wanted.value && (condition.headerName??'')===(wanted.headerName??'') }) && record.action.type === draft.action.type && (record.action.target ?? '') === (draft.action.target ?? '')
}

function bindAccountFilters(askDialog?: (options: Record<string, unknown>) => Promise<string | boolean | null>): void {
  document.querySelectorAll<HTMLElement>('[data-filter-workspace]').forEach(root => {
    if (root.dataset.filterBound === 'true') return
    root.dataset.filterBound = 'true'
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const copy = (message: string, values?: MessageValues) => xpT(message, values)
    const blockedAncestor = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const canManage = root.dataset.filterManage === 'true', expectedAccountId = root.dataset.filterAccount ?? ''
    const fieldLabels:Record<string,string>={from:copy(msgctxt('account-filters-client', 'From')),to:copy(msgctxt('account-filters-client', 'To')),subject:copy('Subject'),header:copy('Header'),body:copy('Body'),size:copy('Size'),contains:copy('contains'),is:copy('equals'),matches:copy('matches wildcards'),over:copy('over'),under:copy('under'),fileinto:copy('Move to folder'),redirect:copy('Redirect to address'),reject:copy('Reject with message'),keep:copy('Keep message'),discard:copy('Discard message')}
    const select = root.querySelector<HTMLSelectElement>('[data-filter-scope]')!, form = root.querySelector<HTMLFormElement>('[data-filter-editor]')
    const status = root.querySelector<HTMLElement>('[data-filter-status]')!, list = root.querySelector<HTMLOListElement>('[data-filter-list]')!
    let selection: FilterSelection = { scope:'global', mailbox:null }, state: FilterState | null = null, busy = false, uncertain = false, generation = 0, editing: string | null = null, draftRevision: string | null = null, dirty = false
    const note = (message: string, mode: string) => { status.textContent = message; status.dataset.state = mode; status.setAttribute('role', mode === 'failed' || mode === 'uncertain' ? 'alert' : 'status') }
    const ready = () => state !== null && state.compilation.status === 'ready'
    const control = () => {
      const blocked = !!root.closest(blockedAncestor)
      root.setAttribute('aria-busy', String(busy)); select.disabled = busy || blocked
      root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy || blocked || (button.hasAttribute('data-filter-write') && (!canManage || !(button.dataset.filterAction === 'delete' ? state !== null : ready()) || uncertain)) })
      form?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach(field => { field.disabled = busy || blocked })
      root.querySelectorAll<HTMLButtonElement>('[data-filter-action="up"],[data-filter-action="down"]').forEach(button => { const index = Number(button.dataset.filterIndex); button.disabled ||= button.dataset.filterAction === 'up' ? index <= 0 : index >= (state?.filters.length ?? 0) - 1 })
    }
    const endpoint = (chosen = selection) => '/api/mail/filters?scope=' + chosen.scope + (chosen.scope === 'mailbox' ? '&mailbox=' + encodeURIComponent(chosen.mailbox!) : '')
    const read = async (chosen: FilterSelection, token: number) => {
      if (!request) throw new Error('session_transport_unavailable')
      const snapshot = readFilterState(await request('GET', endpoint(chosen)), {...chosen,accountId:expectedAccountId})
      if (token !== generation || filterSelectionKey(chosen) !== filterSelectionKey(selection)) throw Object.assign(new Error('stale_selection_response'), { status:409 })
      return snapshot
    }
    const technical = (value: string) => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.className = 'xp-mono'; bdi.textContent = value; return bdi }
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
          const conditions = document.createElement('p')
          if (!row.conditions.length) conditions.textContent = copy('Unconditional: matches every message in this scope.')
          row.conditions.forEach((condition, n) => { if(n) conditions.appendChild(document.createElement('br')); conditions.appendChild(document.createTextNode((fieldLabels[condition.field]??condition.field)+' '+(fieldLabels[condition.comparator]??condition.comparator)+' '));if(condition.headerName){conditions.appendChild(technical(condition.headerName));conditions.appendChild(document.createTextNode(': '))}conditions.appendChild(technical(condition.value)) }); item.appendChild(conditions)
          const action = document.createElement('p'); action.appendChild(document.createTextNode(fieldLabels[row.action.type]??row.action.type));if(row.action.target){action.appendChild(document.createTextNode(': '));action.appendChild(technical(row.action.target))}; item.appendChild(action)
          if (canManage) { const actions = document.createElement('div'); actions.className = 'xp-extension__actions'; for (const [kind, label] of [['edit',copy(msgctxt('account-filters-client', 'Edit'))],['toggle',row.enabled?copy('Disable configuration'):copy('Enable configuration')],['up',copy('Move up')],['down',copy('Move down')],['delete',copy('Delete configuration')]]) { const button = document.createElement('button'); button.type='button'; button.className='xp-btn'; button.dataset.filterAction=kind; button.dataset.filterId=row.id; button.dataset.filterIndex=String(index); button.dataset.filterWrite=''; button.textContent=label!; actions.appendChild(button) } item.appendChild(actions) }
        } else { const warning = document.createElement('p'); warning.textContent = copy('Saved metadata is blocked and has not been rewritten.'); item.appendChild(warning);if(canManage&&typeof row.id==='string'&&row.id){const remove=document.createElement('button');remove.type='button';remove.className='xp-btn';remove.dataset.filterAction='delete';remove.dataset.filterId=row.id;remove.dataset.filterWrite='';remove.textContent=copy('Delete configuration');item.appendChild(remove)} }
        list.appendChild(item)
      })
      const empty = root.querySelector<HTMLElement>('[data-filter-empty]')!; empty.hidden = state.filters.length > 0; empty.textContent = copy('No saved filters in this scope.')
      root.querySelector<HTMLElement>('[data-filter-count]')!.textContent = copy('{count} saved rules · evaluated in order', { count: state.filters.length })
      root.querySelector<HTMLElement>('[data-filter-compilation]')!.textContent = valid ? copy('Preview only. Native Sieve has not been installed.') : copy('Preview blocked: {reason}', { reason: state.compilation.reason ?? state.compilation.status })
      root.querySelector<HTMLElement>('[data-filter-preview]')!.textContent = state.compiledSieve ?? ''
      control()
    }
    const refresh = async () => {
      if (busy || root.closest(blockedAncestor)) return
      const token = ++generation, chosen = {...selection}; busy=true; control(); note(copy('Reading configuration…'),'pending')
      try { state=await read(chosen,token); uncertain=false; paint(); note(copy('Configuration read. Native activation remains unavailable.'), state.compilation.status==='ready'?'read':'blocked') }
      catch { state=null; note(copy('Configuration could not be verified. Editing is unavailable.'),'failed') }
      finally { busy=false;control() }
    }
    const conditionsRoot = form?.querySelector<HTMLElement>('[data-filter-conditions]')
    const updateEmpty = () => { const empty=form?.querySelector<HTMLElement>('[data-filter-unconditional]'); if(empty) empty.hidden=!!conditionsRoot?.children.length }
    const addCondition = (condition: FilterCondition = {field:'subject',comparator:'contains',value:''}) => {
      if(!conditionsRoot) return
      const row=document.createElement('div');row.className='xp-filter-condition';row.dataset.filterCondition=''
      const id='filter-condition-'+String(++conditionNumber)
      const field = (label:string,name:string,element:HTMLInputElement|HTMLSelectElement) => { const wrap=document.createElement('div');wrap.className='xp-field';wrap.dataset.conditionPart=name;const caption=document.createElement('label');caption.htmlFor=id+'-'+name;caption.textContent=label;element.id=caption.htmlFor;element.dataset.conditionField=name;element.className=element instanceof HTMLSelectElement?'xp-select':'xp-input';wrap.append(caption,element);row.appendChild(wrap) }
      const selectFor=(values:string[],selected:string) => {const element=document.createElement('select');values.forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=fieldLabels[value]??value;element.appendChild(option)});element.value=selected;return element}
      const which=selectFor(['from','to','subject','header','body','size'],condition.field), compare=selectFor(condition.field==='size'?['over','under']:['contains','is','matches'],condition.comparator)
      field(copy('Field'),'field',which);field(copy('Operator'),'comparator',compare)
      const header=document.createElement('input');header.value=condition.headerName??'';header.maxLength=78;header.dir='ltr';field(copy('Header name'),'headerName',header)
      const value=document.createElement('input');value.value=condition.value;value.maxLength=1024;value.required=false;field(copy('Match value / size in bytes or K/M/G'),'value',value)
      const sync=()=>{const part=row.querySelector<HTMLElement>('[data-condition-part="headerName"]')!;part.hidden=which.value!=='header';header.required=which.value==='header';value.required=which.value==='size'}
      which.addEventListener('change',()=>{compare.textContent='';(which.value==='size'?['over','under']:['contains','is','matches']).forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=fieldLabels[value]??value;compare.appendChild(option)});sync()});sync()
      const remove=document.createElement('button');remove.type='button';remove.className='xp-btn';remove.dataset.filterRemoveCondition='';remove.textContent=copy('Remove condition');remove.addEventListener('click',()=>{row.remove();dirty=true;updateEmpty()});row.appendChild(remove);conditionsRoot.appendChild(row);updateEmpty()
    }
    let conditionNumber=0
    const value = (name:string) => form!.elements.namedItem(name) as HTMLInputElement|HTMLSelectElement
    const updateTarget=()=>{if(!form)return;const type=value('action').value,needed=!['keep','discard'].includes(type),target=value('target') as HTMLInputElement;form.querySelector<HTMLElement>('[data-filter-target-field]')!.hidden=!needed;target.required=needed;target.type=type==='redirect'?'email':'text';target.dir=type==='redirect'?'ltr':'auto';target.maxLength=type==='fileinto'?255:1024}
    const edit = (record?:FilterRecord) => {
      if(!form||!state||!ready()||uncertain)return
      editing=record?.id??null;draftRevision=state.revision;form.reset();conditionsRoot!.textContent='';conditionNumber=0
      value('name').value=record?.name??'';(value('enabled') as HTMLInputElement).checked=record?.enabled??true;value('matchAll').value=record?.matchAll===false?'any':'all';value('action').value=record?.action.type??'fileinto';value('target').value=record?.action.target??''
      record?.conditions.forEach(addCondition);updateEmpty();updateTarget();dirty=false;form.hidden=false;form.querySelector<HTMLElement>('[data-filter-editor-title]')!.textContent=record?copy('Edit filter configuration'):copy('Create filter configuration');value('name').focus()
    }
    const draft=():FilterDraft=>({name:value('name').value.trim(),enabled:(value('enabled') as HTMLInputElement).checked,matchAll:value('matchAll').value==='all',conditions:[...conditionsRoot!.querySelectorAll<HTMLElement>('[data-filter-condition]')].map(row=>{const read=(part:string)=>(row.querySelector('[data-condition-field="'+part+'"]') as HTMLInputElement|HTMLSelectElement).value;let content=read('value');if(read('field')==='size')content=content.trim();if(read('field')==='size'&&/^\d+[KMG]?$/i.test(content)){const match=/^(\d+)([KMG])?$/i.exec(content)!;content=String(Number(match[1])*(({K:1024,M:1048576,G:1073741824} as Record<string,number>)[match[2]?.toUpperCase()??'']??1))}return{field:read('field'),comparator:read('comparator'),value:content,...(read('field')==='header'?{headerName:read('headerName')}: {})}}),action:{type:value('action').value,...(!['keep','discard'].includes(value('action').value)?{target:value('action').value==='redirect'?value('target').value.trim().toLowerCase():value('target').value}:{})}})
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
        note(copy('Configuration saved and read back. Native activation has not occurred.'),'saved')
      }catch(error){uncertain=sent&&(acknowledged||filterWriteUncertain(error));note(uncertain?copy('The saved state is uncertain. Refresh and review before another change. Your draft is kept.'):copy('The change was refused or the revision changed. Your draft is kept. Refresh, then reopen the editor from the current rule before saving.'),uncertain?'uncertain':'failed')}
      finally{busy=false;control()}
    }
    root.querySelector('[data-filter-refresh]')?.addEventListener('click',()=>{void refresh()})
    root.querySelector('[data-filter-new]')?.addEventListener('click',()=>{if(!dirty)edit();else note(copy('Finish or cancel the current draft first.'),'failed')})
    root.querySelector('[data-filter-add-condition]')?.addEventListener('click',()=>{addCondition();dirty=true})
    root.querySelector('[data-filter-cancel]')?.addEventListener('click',()=>{if(form){form.hidden=true;dirty=false;editing=null;draftRevision=null}})
    form?.addEventListener('input',()=>{dirty=true});form?.addEventListener('change',()=>{dirty=true;updateTarget()})
    form?.addEventListener('submit',event=>{event.preventDefault();if([...form.querySelectorAll<HTMLInputElement>('input')].some(input=>filterHasForbiddenControl(input.value))){note(copy('Remove control characters or line separators before saving. Your draft is kept.'),'failed');return}if(!form.reportValidity())return;const payload=draft(),id=editing;void mutate(id?'PATCH':'POST','/api/mail/filters'+(id?'/'+encodeURIComponent(id):''),{...payload,...(!id?{scope:selection.scope,...(selection.mailbox?{mailbox:selection.mailbox}:{})}:{})},next=>id?next.filters.some(row=>row.id===id&&filterDraftMatches(row,payload)):next.filters.some(row=>filterDraftMatches(row,payload)),draftRevision??undefined)})
    select.addEventListener('change',async()=>{
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
      selection=wanted==='global'?{scope:'global',mailbox:null}:{scope:'mailbox',mailbox:wanted.slice(8)};state=null;generation++;uncertain=false;dirty=false;editing=null;draftRevision=null;if(form)form.hidden=true;list.textContent='';root.querySelector<HTMLElement>('[data-filter-preview]')!.textContent='';root.querySelector<HTMLElement>('[data-filter-count]')!.textContent='';root.querySelector<HTMLElement>('[data-filter-compilation]')!.textContent=copy(msgctxt('account-filters-client', 'Not read'));await refresh()
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

export const ACCOUNT_FILTERS_CLIENT_BINDING = `(function(askDialog) { ${filterSelectionKey.toString()}; ${filterObject.toString()}; ${readFilterState.toString()}; ${filterWriteUncertain.toString()}; ${filterHasForbiddenControl.toString()}; ${filterDraftMatches.toString()}; (${bindAccountFilters.toString()})(askDialog); })`
