import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createVisualFixture} from './visual-fixture.mjs'

const argument=key=>process.argv.find(value=>value.startsWith(key+'='))?.slice(key.length+1)
const output=resolve(argument('--output')??'test-results/shell-motion-exception')
if(existsSync(output))throw Error('Use a new evidence directory.')
mkdirSync(output,{recursive:true})
const paths=['apps/web/src/shell-motion.ts','apps/web/src/ws-client.ts','apps/web/src/surfaces/login.ts','apps/web/src/login-client.ts','apps/web/src/tokens.ts','apps/web/src/app.ts','apps/web/src/login-surfaces.test.ts','tests/browser/login-surface-acceptance.mjs','tests/browser/applied-font-contract.mjs','tests/browser/accounts-acceptance.mjs','tests/browser/mail-layout-acceptance.mjs','tests/browser/navigation-acceptance.mjs','tests/browser/resource-usage-acceptance.mjs','tests/browser/technical-values-acceptance.mjs','tests/browser/visual-fixture.mjs','tests/browser/shell-motion-exception-acceptance.mjs']
const fingerprint=()=>paths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})),before=fingerprint()
const states=['en','ar'].flatMap(locale=>['light','dark'].flatMap(theme=>[['drawer',360],['palette',360],['palette',1440]].flatMap(([kind,width])=>['opening','closing'].map(phase=>({locale,theme,kind,width,phase,id:[locale,theme,kind,width,phase].join('-')})))))
const selected=argument('--samples')==='red'?states.filter(s=>s.locale==='en'&&s.theme==='light'&&s.kind==='drawer'&&s.phase==='opening'||s.locale==='ar'&&s.theme==='dark'&&s.kind==='palette'&&s.width===1440&&s.phase==='closing'):states
process.env.PLAYWRIGHT_BROWSERS_PATH??=join(process.cwd(),'.tools/playwright-browsers')
const {chromium}=await import('@playwright/test'),fixture=await createVisualFixture(),browser=await chromium.launch({headless:true}),outcomes=[]
async function command(page,kind,open){if(open){if(kind==='drawer')await page.locator('[data-action="toggle-mobile-nav"]').click();else await page.keyboard.press('Control+k')}else await page.keyboard.press('Escape')}
async function settled(page,kind,visible){await page.waitForFunction(({kind,visible})=>{const e=document.querySelector(kind==='drawer'?'[data-xp-sidebar]':'[data-xp-cmdk]'),s=kind==='drawer'?e:e.querySelector('.xp-cmdk-dialog'),b=kind==='drawer'?document.querySelector('[data-xp-nav-backdrop]'):e;return(!e.hidden&&getComputedStyle(e).visibility==='visible')===visible&&s.getAnimations().length===0&&b.getAnimations().length===0},{kind,visible},{timeout:3000})}
async function snapshot(page,kind){return page.evaluate(kind=>{
 const element=document.querySelector(kind==='drawer'?'[data-xp-sidebar]':'[data-xp-cmdk]'),surface=kind==='drawer'?element:element.querySelector('.xp-cmdk-dialog'),backdrop=kind==='drawer'?document.querySelector('[data-xp-nav-backdrop]'):element,r=surface.getBoundingClientRect(),fault=window.__shellMotionFault
 return {visible:!element.hidden&&getComputedStyle(element).visibility==='visible',x:r.x,y:r.y,transform:getComputedStyle(surface).transform,opacity:getComputedStyle(backdrop).opacity,effects:surface.getAnimations().length+backdrop.getAnimations().length,native_states:[...surface.getAnimations(),...backdrop.getAnimations()].map(a=>({state:a.playState,current_time:a.currentTime,pending:a.pending})),surface_hint:surface.style.willChange,backdrop_hint:backdrop.style.willChange,body:document.body.style.overflow,root:document.documentElement.style.overflow,inert:document.querySelectorAll('[inert]').length,scroll:scrollY,focus_inside:element.contains(document.activeElement),focus_visible:document.activeElement!==document.body&&document.activeElement.checkVisibility()&&!document.activeElement.closest('[inert]'),fault:fault?{calls:fault.calls,thrown:fault.thrown,first_state:fault.first?.playState,first_time:fault.first?.currentTime}:null}
},kind)}
try{
 for(const state of selected){
  const context=await browser.newContext({viewport:{width:state.width,height:state.width<960?600:900},reducedMotion:'no-preference'}),page=await context.newPage(),result={...state,checks:[],errors:[],writes:[]},check=(name,passed,observation)=>result.checks.push({name,passed:Boolean(passed),observation})
  page.on('pageerror',error=>result.errors.push(error.message));await context.route('**/*',route=>{if(!['GET','HEAD'].includes(route.request().method())){result.writes.push(route.request().method());return route.abort()}return route.continue()})
  try{
   assert.equal((await page.goto(fixture.baseUrl+'/whm/accounts/new?lang='+state.locale+'&theme='+state.theme+'&accountId=visual-account',{waitUntil:'networkidle'})).status(),200);await page.evaluate(()=>document.fonts.ready)
   await page.locator('#new-acc-username').focus();await page.evaluate(()=>scrollTo(0,Math.min(100,document.documentElement.scrollHeight-innerHeight)))
   const initial=await snapshot(page,state.kind)
   if(state.phase==='closing'){await command(page,state.kind,true);await settled(page,state.kind,true)}
   await page.evaluate(kind=>{
    const element=document.querySelector(kind==='drawer'?'[data-xp-sidebar]':'[data-xp-cmdk]'),surface=kind==='drawer'?element:element.querySelector('.xp-cmdk-dialog'),backdrop=kind==='drawer'?document.querySelector('[data-xp-nav-backdrop]'):element,native=Element.prototype.animate
    window.__shellMotionFault={native,calls:0,first:null,thrown:false}
    Element.prototype.animate=function(...args){const fault=window.__shellMotionFault;if(this===surface||this===backdrop){fault.calls++;if(fault.calls===2){fault.thrown=true;throw Error('Synthetic second native animation setup failure')}const effect=native.apply(this,args);fault.first=effect;return effect}return native.apply(this,args)}
   },state.kind)
   await command(page,state.kind,state.phase==='opening')
   const immediate=await snapshot(page,state.kind)
   check('actual-second-call-fault-and-first-effect-cancelled',immediate.fault?.thrown&&immediate.fault.calls===2&&immediate.fault.first_state==='idle'&&immediate.fault.first_time===null&&immediate.effects===0,immediate)
   check('temporary-hints-restored',immediate.surface_hint===initial.surface_hint&&immediate.backdrop_hint===initial.backdrop_hint,immediate)
   check('fallback-final-state-and-context',state.phase==='opening'?immediate.visible&&immediate.focus_inside&&immediate.body==='hidden'&&immediate.root==='hidden':!immediate.visible&&immediate.body===initial.body&&immediate.root===initial.root&&immediate.inert===initial.inert&&immediate.focus_visible,immediate)
   await page.waitForTimeout(280)
   const late=await snapshot(page,state.kind)
   check('late-native-frames-cannot-move-or-reappear',late.visible===immediate.visible&&Math.hypot(late.x-immediate.x,late.y-immediate.y)<0.1&&late.transform===immediate.transform&&late.opacity===immediate.opacity&&late.effects===0&&Math.abs(late.scroll-initial.scroll)<1,late)
   await page.evaluate(()=>{Element.prototype.animate=window.__shellMotionFault.native})
   if(state.phase==='opening'){await command(page,state.kind,false);await settled(page,state.kind,false)}
   await command(page,state.kind,true);await settled(page,state.kind,true)
   const reopened=await snapshot(page,state.kind)
   check('native-reopen-after-fault-is-clean',reopened.visible&&reopened.focus_inside&&reopened.effects===0&&reopened.body==='hidden'&&reopened.root==='hidden',reopened)
   await command(page,state.kind,false);await settled(page,state.kind,false)
   const closed=await snapshot(page,state.kind)
   check('repeated-close-restores-focus-inert-and-locks',!closed.visible&&closed.effects===0&&closed.body===initial.body&&closed.root===initial.root&&closed.inert===initial.inert&&closed.focus_visible&&Math.abs(closed.scroll-initial.scroll)<1,closed)
   check('no-page-errors-or-writes',result.errors.length===0&&result.writes.length===0,{errors:result.errors,writes:result.writes})
   result.status=result.checks.every(c=>c.passed)?'passed':'failed'
  }catch(error){result.status='failed';result.error={name:error.name,message:error.message}}
  outcomes.push(result);writeFileSync(join(output,'results.partial.json'),JSON.stringify({outcomes},null,2)+'\n');await context.close()
 }
}finally{await browser.close();await fixture.close()}
const after=fingerprint(),drift=before.filter((f,i)=>f.sha256!==after[i].sha256).map(f=>f.path),report={status:outcomes.every(o=>o.status==='passed')&&drift.length===0?'passed':'failed',scope:'Synthetic Chromium failure injection changes only native Element.animate in the browser fixture. It does not demonstrate that a current browser normally throws here or qualify any production hosting service.',source:{before,after,drift},outcomes}
writeFileSync(join(output,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,states:outcomes.length,passed:outcomes.filter(o=>o.status==='passed').length,drift,failures:outcomes.filter(o=>o.status!=='passed').map(o=>({id:o.id,error:o.error,checks:o.checks.filter(c=>!c.passed).map(c=>c.name)}))}));process.exitCode=report.status==='passed'?0:1
