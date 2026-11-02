import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import * as classic from './board-port/account-routing-client-templates.ts'
import * as v2 from './themes/v2/pages/xpanel/email-tools/routing-client-templates.ts'
import { clientTemplate, cloneClientTemplate } from './client-templates.ts'
let environment: EnvironmentReturn
beforeEach(async () => { environment = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://panel.example.test' } }) })
afterEach(async () => { await environment.teardown(globalThis) })
const contracts = [
  ['account-mailing-list-row','tr',['address','members','moderation','archive','remove']],
  ['account-quarantine-message','li',['title','sender','inspect']],
  ['account-pgp-row','tr',['identity','algorithm','created','expires','secret','export','remove']],
  ['account-collaboration-row-4','tr',['value-0','value-1','value-2','value-3']],
  ['account-collaboration-row-5','tr',['value-0','value-1','value-2','value-3','value-4']],
] as const
for (const [name, factory] of [['classic',classic],['v2',v2]] as const) describe(name+' account routing templates',()=>{
  const markup=()=>Object.values(factory).map(render=>render()).join('')
  it('provides complete unique row contracts with inert initial mutation controls',()=>{
    const root=document.createElement('div');root.innerHTML=markup()
    for(const [id,tag,slots] of contracts){ const row=cloneClientTemplate(clientTemplate(root,id),tag,slots); expect(row.tagName).toBe(tag.toUpperCase());row.querySelectorAll('button').forEach(button=>expect(button.disabled).toBe(true)) }
    const row=cloneClientTemplate(clientTemplate(root,'account-pgp-row'),'tr',contracts[2][2]);expect(row.querySelector('a')?.hasAttribute('href')).toBe(false)
  })
  it('rejects removed and duplicate semantic fields instead of constructing fallback markup',()=>{
    for(const [id,tag,slots] of contracts){
      const root=document.createElement('div');root.innerHTML=markup();const template=clientTemplate(root,id);const field=template.content.querySelector('[data-xp-slot]')!;field.remove();expect(()=>cloneClientTemplate(template,tag,slots)).toThrow()
      root.innerHTML=markup();const intact=clientTemplate(root,id);const first=intact.content.querySelector('[data-xp-slot]')!;first.after(first.cloneNode(true));expect(()=>cloneClientTemplate(intact,tag,slots)).toThrow()
    }
  })
})
