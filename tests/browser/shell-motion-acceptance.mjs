import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createVisualFixture } from './visual-fixture.mjs'

const argument = key => process.argv.find(value => value.startsWith(key + '='))?.slice(key.length + 1)
const output = resolve(argument('--output') ?? 'test-results/shell-motion')
if (existsSync(output)) throw Error('Choose a new output directory; preserve previous evidence.')
mkdirSync(join(output, 'screenshots'), { recursive: true })
const protectedPaths = ['apps/web/src/surfaces/login.ts','apps/web/src/login-client.ts','apps/web/src/tokens.ts','apps/web/src/app.ts','apps/web/src/login-surfaces.test.ts','tests/browser/login-surface-acceptance.mjs','tests/browser/applied-font-contract.mjs','tests/browser/accounts-acceptance.mjs','tests/browser/mail-layout-acceptance.mjs','tests/browser/navigation-acceptance.mjs','tests/browser/resource-usage-acceptance.mjs','tests/browser/technical-values-acceptance.mjs']
const paths = [...protectedPaths, 'apps/web/src/ws-client.ts','apps/web/src/shell-motion.ts','tests/browser/visual-fixture.mjs','tests/browser/shell-motion-acceptance.mjs']
const fingerprint = () => paths.map(path => ({ path, sha256: existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null }))
const before = fingerprint()
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), '.tools/playwright-browsers')
const { chromium } = await import('@playwright/test')
const states = ['en','ar'].flatMap(locale => ['light','dark'].flatMap(theme => [360,1440].flatMap(width => ['no-preference','reduce'].map(motion => ({ locale, theme, width, motion, id: [locale,theme,width,motion].join('-') })))))
const selected = argument('--samples') === 'before' ? states.filter(s => (s.locale === 'en' && s.theme === 'light' && s.width === 360 || s.locale === 'ar' && s.theme === 'dark' && s.width === 1440) && s.motion === 'no-preference') : states
const fixture = await createVisualFixture(), browser = await chromium.launch({ headless: true }), outcomes = []

async function observe(page, kind, action) {
  return page.evaluate(({ kind, action }) => {
    const key = (value, ctrl = false) => document.dispatchEvent(new KeyboardEvent('keydown', { key: value, ctrlKey: ctrl, bubbles: true, cancelable: true }))
    if (action === 'drawer') document.querySelector('[data-action="toggle-mobile-nav"]').click()
    if (action === 'palette') key('k', true)
    if (action === 'escape') key('Escape')
    const element = kind === 'drawer' ? document.querySelector('[data-xp-sidebar]') : document.querySelector('[data-xp-cmdk]')
    const surface = kind === 'drawer' ? element : element.querySelector('.xp-cmdk-dialog')
    const backdrop = kind === 'drawer' ? document.querySelector('[data-xp-nav-backdrop]') : element
    const style = getComputedStyle(surface), r = surface.getBoundingClientRect(), animations = [...surface.getAnimations(),...backdrop.getAnimations()].filter((a,i,all) => all.indexOf(a) === i)
    const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform)
    return { visible: !element.hidden && getComputedStyle(element).visibility === 'visible', x: r.x, y: r.y, width: r.width, height: r.height, transform_x: matrix.m41, transform_y: matrix.m42, opacity: getComputedStyle(backdrop).opacity, focus_inside: element.contains(document.activeElement), active_tag: document.activeElement.tagName, body_overflow: document.body.style.overflow, root_overflow: document.documentElement.style.overflow, inert_count: document.querySelectorAll('[inert]').length, scroll_x: scrollX, scroll_y: scrollY, document_width: document.documentElement.scrollWidth, viewport: innerWidth, viewport_height:innerHeight, animations: animations.map(a => ({ play_state: a.playState, current_time: a.currentTime, duration: a.effect.getTiming().duration })) }
  }, { kind, action })
}
async function settled(page, kind, visible) {
  await page.waitForFunction(({ kind, visible }) => {
    const e = document.querySelector(kind === 'drawer' ? '[data-xp-sidebar]' : '[data-xp-cmdk]'), s = kind === 'drawer' ? e : e.querySelector('.xp-cmdk-dialog'), b = kind === 'drawer' ? document.querySelector('[data-xp-nav-backdrop]') : e
    const shown = !e.hidden && getComputedStyle(e).visibility === 'visible'
    return shown === visible && ![...s.getAnimations(),...b.getAnimations()].some(a => a.playState === 'running')
  }, { kind, visible })
}
async function reverseDuringClose(page, kind, waitForProgress = true) {
  return page.evaluate(async ({kind, waitForProgress}) => {
    const e = document.querySelector(kind === 'drawer' ? '[data-xp-sidebar]' : '[data-xp-cmdk]'), surface = kind === 'drawer' ? e : e.querySelector('.xp-cmdk-dialog')
    const backdrop = kind === 'drawer' ? document.querySelector('[data-xp-nav-backdrop]') : e
    const command = () => kind === 'drawer' ? document.querySelector('[data-action="toggle-mobile-nav"]').click() : document.dispatchEvent(new KeyboardEvent('keydown', {key:'k',ctrlKey:true,bubbles:true,cancelable:true}))
    // Reentrant controller request, fired after real animation frames advance.
    // This is distinct from the real keyboard/pointer checks below.
    let progressed = !waitForProgress
    for (let frame = 0; waitForProgress && frame < 20; frame++) { await new Promise(resolve => requestAnimationFrame(resolve)); const a = surface.getAnimations()[0]; if (a && Number(a.currentTime) > 0 && Number(a.currentTime) <= Number(a.effect.getTiming().duration) - 30) { progressed = true; break } }
    const before = surface.getBoundingClientRect(), beforeStyle = getComputedStyle(surface).transform, opacity = Number(getComputedStyle(backdrop).opacity)
    command()
    const after = surface.getBoundingClientRect()
    return { before: {x:before.x,y:before.y,transform:beforeStyle,opacity}, after:{x:after.x,y:after.y,transform:getComputedStyle(surface).transform,opacity:Number(getComputedStyle(backdrop).opacity)}, jump:Math.hypot(after.x-before.x,after.y-before.y), opacity_jump:Math.abs(opacity-Number(getComputedStyle(backdrop).opacity)), focused:e.contains(document.activeElement), progressed }
  }, {kind, waitForProgress})
}
try {
  for (const state of selected) {
    const result = { ...state, status:'running', checks:[], observations:{}, page_errors:[], console_errors:[], mutations:[] }, check = (name, value, observation) => result.checks.push({name,passed:Boolean(value),observation})
    const context = await browser.newContext({viewport:{width:state.width,height:state.width<960?600:900},reducedMotion:state.motion,colorScheme:state.theme}), page = await context.newPage()
    page.on('pageerror',e=>result.page_errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')result.console_errors.push(m.text())})
    await context.route('**/*',route=>{if(!['GET','HEAD'].includes(route.request().method())){result.mutations.push(route.request().method());return route.abort()}return route.continue()})
    try {
      assert.equal((await page.goto(fixture.baseUrl+'/whm/accounts/new?lang='+state.locale+'&theme='+state.theme+'&density=compact&accountId=visual-account',{waitUntil:'networkidle'})).status(),200)
      await page.evaluate(()=>document.fonts.ready)
      const original = await page.evaluate(()=>{document.querySelector('#new-acc-username').focus({preventScroll:true});scrollTo(0,Math.min(120,document.documentElement.scrollHeight-innerHeight));return {scroll:scrollY,body:document.body.style.overflow,root:document.documentElement.style.overflow,inert:document.querySelectorAll('[inert]').length}})
      await page.screenshot({path:join(output,'screenshots',state.id+'-initial.png'),fullPage:true})
      for (const kind of state.width < 960 ? ['drawer','palette'] : ['palette']) {
        const first = await observe(page,kind,kind), normal = state.motion === 'no-preference'
        result.observations[kind] = {first}
        check(kind+'-focus-lock-immediate',first.visible&&first.focus_inside&&first.body_overflow==='hidden'&&first.root_overflow==='hidden',first)
        check(kind+'-real-entry-motion',normal ? first.animations.some(a=>a.play_state==='running')&&(Math.abs(first.transform_x)+Math.abs(first.transform_y)>0.1) : first.animations.length===0&&Math.abs(first.transform_x)+Math.abs(first.transform_y)<0.1,first)
        await settled(page,kind,true)
        const open = await observe(page,kind);result.observations[kind].open=open
        check(kind+'-open-geometry',open.document_width<=state.width+1&&open.x>=-1&&open.x+open.width<=state.width+1&&open.y>=-1&&open.y+open.height<=open.viewport_height+1&&Math.abs(open.scroll_y-original.scroll)<1,open)
        await page.screenshot({path:join(output,'screenshots',state.id+'-'+kind+'-open.png'),fullPage:true})
        await page.mouse.move(open.x+open.width/2,Math.min(open.y+open.height/2,open.viewport_height-20));await page.mouse.wheel(0,160)
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
        check(kind+'-real-wheel-keeps-document-locked',Math.abs((await observe(page,kind)).scroll_y-original.scroll)<1)
        const area = page.locator(kind==='drawer'?'[data-xp-sidebar]':'[data-xp-cmdk]')
        const focusable = area.locator('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]').filter({visible:true})
        await focusable.last().focus();await page.keyboard.press('Tab');check(kind+'-keyboard-trap',await area.evaluate(e=>e.contains(document.activeElement)))
        const closing = await observe(page,kind,'escape');result.observations[kind].closing=closing
        check(kind+'-closing-lifetime',normal ? closing.visible&&closing.focus_inside&&closing.body_overflow==='hidden'&&closing.inert_count>original.inert : !closing.visible&&closing.body_overflow===original.body,closing)
        if (normal && closing.visible && closing.animations.length) {
          const reverse = await reverseDuringClose(page,kind);result.observations[kind].reversal=reverse
          check(kind+'-reverse-without-position-jump',reverse.progressed&&reverse.jump<0.5&&reverse.opacity_jump<0.01&&reverse.focused,reverse)
          await settled(page,kind,true)
          const endpoint = await page.evaluate(kind=>{
            const element=document.querySelector(kind==='drawer'?'[data-xp-sidebar]':'[data-xp-cmdk]'),surface=kind==='drawer'?element:element.querySelector('.xp-cmdk-dialog'),backdrop=kind==='drawer'?document.querySelector('[data-xp-nav-backdrop]'):element
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
            const before=surface.getBoundingClientRect(),opacity=Number(getComputedStyle(backdrop).opacity)
            kind==='drawer'?document.querySelector('[data-action="toggle-mobile-nav"]').click():document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))
            const after=surface.getBoundingClientRect()
            return {jump:Math.hypot(after.x-before.x,after.y-before.y),opacity_jump:Math.abs(opacity-Number(getComputedStyle(backdrop).opacity)),focus:element.contains(document.activeElement),locked:document.body.style.overflow==='hidden'}
          },kind)
          check(kind+'-pending-endpoint-reversal',endpoint.jump<0.5&&endpoint.opacity_jump<0.01&&endpoint.focus&&endpoint.locked,endpoint)
          await settled(page,kind,true)
          await page.evaluate(kind=>{for(let i=0;i<6;i++)kind==='drawer'?document.querySelector('[data-action="toggle-mobile-nav"]').click():document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))},kind)
          await settled(page,kind,true)
          await page.keyboard.press('Escape')
        }
        await settled(page,kind,false)
        const closed=await observe(page,kind);result.observations[kind].closed=closed
        check(kind+'-closed-restores-context',!closed.visible&&closed.body_overflow===original.body&&closed.root_overflow===original.root&&closed.inert_count===original.inert&&Math.abs(closed.scroll_y-original.scroll)<1,closed)
        if(normal){
          await observe(page,kind,kind)
          const interrupted=await page.evaluate(async kind=>{
            const e=document.querySelector(kind==='drawer'?'[data-xp-sidebar]':'[data-xp-cmdk]'),s=kind==='drawer'?e:e.querySelector('.xp-cmdk-dialog'),b=kind==='drawer'?document.querySelector('[data-xp-nav-backdrop]'):e
            let progressed=false
            for(let i=0;i<20;i++){await new Promise(resolve=>requestAnimationFrame(resolve));const a=s.getAnimations()[0];if(a&&Number(a.currentTime)>=30&&Number(a.currentTime)<Number(a.effect.getTiming().duration)){progressed=true;break}}
            const before=s.getBoundingClientRect(),opacity=Number(getComputedStyle(b).opacity)
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
            const after=s.getBoundingClientRect()
            return {progressed,jump:Math.hypot(after.x-before.x,after.y-before.y),opacity_jump:Math.abs(opacity-Number(getComputedStyle(b).opacity)),focus:e.contains(document.activeElement),locked:document.body.style.overflow==='hidden'}
          },kind)
          check(kind+'-opening-interrupted-without-jump',interrupted.progressed&&interrupted.jump<0.5&&interrupted.opacity_jump<0.01&&interrupted.focus&&interrupted.locked,interrupted)
          await settled(page,kind,false)
        }
        if (kind==='drawer') {
          await observe(page,kind,kind);await settled(page,kind,true)
          await page.locator('[data-xp-nav-backdrop]').click({position:{x:state.locale==='ar'?8:state.width-8,y:100}});await settled(page,kind,false)
          check('drawer-real-backdrop-dismissal',!(await observe(page,kind)).visible)
        } else {
          await page.keyboard.press('Control+k');await settled(page,kind,true)
          const input=page.locator('[data-cmdk-search]');await input.fill(state.locale==='ar'?'حساب':'account');const query=await input.inputValue()
          await page.keyboard.press('Control+k')
          if(normal){const rev=await reverseDuringClose(page,kind);check('palette-real-shortcut-close-reentry-continuity',rev.progressed&&rev.jump<0.5&&rev.opacity_jump<0.01,rev);await settled(page,kind,true);check('palette-preserves-query-on-reversal',await input.inputValue()===query);await page.keyboard.press('Escape')}
          await settled(page,kind,false)
          await page.keyboard.press('Control+k');await settled(page,kind,true);await page.locator('[data-xp-cmdk]').click({position:{x:8,y:8}});await settled(page,kind,false)
          check('palette-real-backdrop-dismissal',!(await observe(page,kind)).visible)
        }
      }
      if(state.motion==='no-preference'){
        await observe(page,'palette','palette');await observe(page,'palette','escape');await page.emulateMedia({reducedMotion:'reduce'});await settled(page,'palette',false)
        check('preference-change-settles-closing-with-cleanup',(await observe(page,'palette')).body_overflow===original.body)
      }
      if(state.width<960){await page.emulateMedia({reducedMotion:state.motion});await observe(page,'drawer','drawer');await page.setViewportSize({width:960,height:900});await page.waitForFunction(()=>document.querySelector('.xp-shell').dataset.mobileNav!=='open'&&document.body.style.overflow!=='hidden');check('resize-cleans-drawer-and-inert',await page.evaluate(()=>document.querySelectorAll('[inert]').length===0));await page.setViewportSize({width:state.width,height:600})}
      await page.emulateMedia({reducedMotion:state.motion})
      await page.keyboard.press('Control+k');await settled(page,'palette',true)
      const destination=page.locator('a[data-cmdk-item]').filter({visible:true}).first(), href=await destination.getAttribute('href')
      await page.evaluate(()=>document.addEventListener('click',event=>{
        const link=event.target.closest?.('a[data-cmdk-item]')
        if(link)sessionStorage.setItem('shell-motion-navigation',JSON.stringify({default_prevented:event.defaultPrevented,body:document.body.style.overflow,root:document.documentElement.style.overflow,inert:document.querySelectorAll('[inert]').length,animations:document.querySelector('.xp-cmdk-dialog').getAnimations().length}))
      }))
      await Promise.all([page.waitForURL(new URL(href,fixture.baseUrl).href),destination.click()])
      const navigation=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('shell-motion-navigation')))
      check('real-link-navigation-cleans-in-same-event',navigation&&!navigation.default_prevented&&navigation.body===original.body&&navigation.root===original.root&&navigation.inert===original.inert&&navigation.animations===0,navigation)
      check('no-errors-or-writes',result.page_errors.length===0&&result.console_errors.length===0&&result.mutations.length===0,{errors:result.page_errors,console:result.console_errors,mutations:result.mutations})
      result.status=result.checks.every(c=>c.passed)?'passed':'failed'
    }catch(error){result.status='failed';result.error={name:error.name,message:error.message}}
    await page.screenshot({path:join(output,'screenshots',state.id+'-final.png'),fullPage:true});outcomes.push(result);writeFileSync(join(output,'results.partial.json'),JSON.stringify({outcomes},null,2)+'\n');await context.close()
  }
}finally{await browser.close();await fixture.close()}
const after=fingerprint(),drift=before.filter((f,i)=>f.sha256!==after[i].sha256).map(f=>f.path),report={status:outcomes.every(o=>o.status==='passed')&&drift.length===0?'passed':'failed',scope:'Read-only synthetic Chromium diagnostics for two shell overlays; no authentication, host operation, production performance or whole-interface parity qualification.',source:{before,after,drift},outcomes}
writeFileSync(join(output,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,states:outcomes.length,passed:outcomes.filter(o=>o.status==='passed').length,drift,failures:outcomes.filter(o=>o.status!=='passed').map(o=>({id:o.id,error:o.error?.message,checks:o.checks.filter(c=>!c.passed).map(c=>c.name)}))}));process.exitCode=report.status==='passed'?0:1
