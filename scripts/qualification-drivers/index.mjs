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
import aapanel from './aapanel.mjs'

/** The reviewed acceptance drivers per audit slice; a tool absent here is planned as not run. */
export const SLICES = Object.freeze({ s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, aapanel })

export const DRIVER_MODULES = Object.freeze(['kit', 'index', ...Object.keys(SLICES)].map(name => `scripts/qualification-drivers/${name}.mjs`))

const entries = Object.values(SLICES).flat()
export const QUALIFICATION_INVENTORY = Object.freeze(Object.fromEntries(entries.map(item => [item.toolId, item.inventory])))
export const DRIVERS = Object.freeze(Object.fromEntries(entries.map(item => [item.toolId, item.driver])))
