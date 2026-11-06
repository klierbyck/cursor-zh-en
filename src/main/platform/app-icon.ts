/** A Windows ICO container with a 256×256 PNG payload (Vista and later). */
export function pngIconContainer(png: Uint8Array): Buffer {
  if (png.length < 24 || Buffer.from(png.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a') throw new Error('应用图标不是有效的 PNG')
  const dimensions = Buffer.from(png)
  if (dimensions.readUInt32BE(16) !== 256 || dimensions.readUInt32BE(20) !== 256) throw new Error('任务栏图标必须为 256×256')
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, png])
}
