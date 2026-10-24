declare module 'pngjs' {
  export class PNG {
    constructor(options: { width: number; height: number })
    data: Buffer
    width: number
    height: number
    static sync: {
      read: (buffer: Buffer) => PNG
      write: (png: PNG) => Buffer
    }
  }
}
