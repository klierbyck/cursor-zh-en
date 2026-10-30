import { pngIconContainer } from '../src/main/platform/app-icon'

describe('Windows taskbar icon', () => {
  it('uses a 256px PNG in a valid ICO entry instead of the Electron host icon', () => {
    const png = Buffer.alloc(32)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
    png.writeUInt32BE(256, 16)
    png.writeUInt32BE(256, 20)
    const ico = pngIconContainer(png)
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(1)
    expect(ico[6]).toBe(0)
    expect(ico[7]).toBe(0)
    expect(ico.readUInt16LE(10)).toBe(1)
    expect(ico.readUInt16LE(12)).toBe(32)
    expect(ico.readUInt32LE(14)).toBe(png.length)
    expect(ico.readUInt32LE(18)).toBe(22)
    expect(ico.subarray(22)).toEqual(png)
  })
  it('rejects invalid payloads and non-256px taskbar assets', () => {
    expect(() => pngIconContainer(Buffer.alloc(32))).toThrow('PNG')
    const png = Buffer.alloc(32)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
    png.writeUInt32BE(80, 16)
    png.writeUInt32BE(80, 20)
    expect(() => pngIconContainer(png)).toThrow('256')
  })
})
