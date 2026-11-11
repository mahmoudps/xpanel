import s1 from './s1.mjs'
import s2 from './s2.mjs'
import s3 from './s3.mjs'
import s4 from './s4.mjs'
import s5 from './s5.mjs'
import s6 from './s6.mjs'
import s7 from './s7.mjs'
import s8 from './s8.mjs'
import s9 from './s9.mjs'
import s10 from './s10.mjs'
import s11 from './s11.mjs'
import s12 from './s12.mjs'
import s13 from './s13.mjs'
import s14 from './s14.mjs'
import s15 from './s15.mjs'
import s16 from './s16.mjs'
import s17 from './s17.mjs'
import s18 from './s18.mjs'
import s19 from './s19.mjs'
import s20 from './s20.mjs'
import aapanel from './aapanel.mjs'

/** The reviewed acceptance drivers per audit slice; a tool absent here is planned as not run. */
export const SLICES = Object.freeze({ s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15, s16, s17, s18, s19, s20, aapanel })

export const DRIVER_MODULES = Object.freeze(['kit', 'index', ...Object.keys(SLICES)].map(name => `scripts/qualification-drivers/${name}.mjs`))

const entries = Object.values(SLICES).flat()
export const QUALIFICATION_INVENTORY = Object.freeze(Object.fromEntries(entries.map(item => [item.toolId, item.inventory])))
export const DRIVERS = Object.freeze(Object.fromEntries(entries.map(item => [item.toolId, item.driver])))
