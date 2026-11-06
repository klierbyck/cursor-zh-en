import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [version, directory] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !directory) throw new Error('用法：node scripts/create-release-manifest.mjs <版本> <产物目录>')

const files = [
  { platform: 'win32', arch: 'x64', url: `CursorZh-${version}-win-x64.exe` },
  { platform: 'darwin', arch: 'x64', url: `CursorZh-${version}-mac-x64.dmg` },
  { platform: 'darwin', arch: 'arm64', url: `CursorZh-${version}-mac-arm64.dmg` }
]
const installers = (await readdir(directory)).filter(name => /\.(?:exe|dmg)$/i.test(name))
if (installers.length !== files.length || files.some(file => !installers.includes(file.url))) throw new Error('发布目录必须恰好包含对应版本的 Windows EXE 和两种 macOS DMG')

const entries = []
for (const file of files) {
  const path = join(directory, file.url)
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  entries.push({ ...file, sha512: hash.digest('base64'), size: (await stat(path)).size })
}
const manifest = `version: ${version}\nfiles:\n${entries.map(file => `  - platform: ${file.platform}\n    arch: ${file.arch}\n    url: ${file.url}\n    sha512: ${file.sha512}\n    size: ${file.size}`).join('\n')}\n`
await writeFile(join(directory, 'latest.yml'), manifest)
console.log(`已生成统一更新清单：${entries.map(file => file.url).join('、')}`)
