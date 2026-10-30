import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { inspectInstallation, WORKBENCH } from '../src/main/core/discovery'
import { checksum } from '../src/main/core/files'
import { loadResources } from '../src/main/patches/plan'

export const html = '<!DOCTYPE html>\r\n<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\';"></head><body><button>New Agent</button></body><script src="./workbench.js" type="module"></script></html>\r\n'
export const main = 'const tray=[{label:"Open Cursor",click:()=>open()},{label:"New Agent",click:()=>agent()}];'

export function packBytes(version = '1.128.0'): Uint8Array {
  return zipSync({
    'extension/package.json': strToU8(JSON.stringify({ name: 'vscode-language-pack-zh-hans', publisher: 'MS-CEINTL', version, contributes: { localizations: [{ languageId: 'zh-cn', translations: [{ id: 'vscode', path: './translations/main.i18n.json' }] }] } })),
    'extension/translations/main.i18n.json': strToU8(JSON.stringify({ version: '1.0.0', contents: { test: { hello: '你好' } } })),
    'extension/LICENSE.md': strToU8('Test fixture; not an upstream language pack.')
  })
}

export async function fixture(platform: 'win32' | 'darwin' = 'win32') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cursorzh-test-')))
  const root = join(base, platform === 'darwin' ? 'Cursor.app' : 'cursor')
  const appRoot = platform === 'darwin' ? join(root, 'Contents', 'Resources', 'app') : join(root, 'resources', 'app')
  const home = join(base, 'home')
  const data = join(base, 'utility-data')
  const userData = join(base, 'cursor-data')
  await mkdir(join(appRoot, 'out/vs/code/electron-sandbox/workbench'), { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(data, { recursive: true })
  await mkdir(userData, { recursive: true })
  if (platform === 'darwin') await mkdir(join(root, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(platform === 'darwin' ? join(root, 'Contents', 'MacOS', 'Cursor') : join(root, 'Cursor.exe'), 'fixture only')
  await writeFile(join(appRoot, WORKBENCH), html)
  await writeFile(join(appRoot, 'out/main.js'), main)
  const product = { applicationName: 'cursor', nameShort: 'Cursor', version: '3.27.14', vscodeVersion: '1.128.0', commit: 'fixture-commit', checksums: { 'vs/code/electron-sandbox/workbench/workbench.html': checksum(Buffer.from(html)), 'main.js': checksum(Buffer.from(main)) } }
  await writeFile(join(appRoot, 'product.json'), JSON.stringify(product, null, '\t') + '\r\n')
  const installation = await inspectInstallation(root, platform, home)
  installation.userData = userData
  const resources = await loadResources(join(process.cwd(), 'resources'))
  resources.compatibility.windows = [{ commit: 'fixture-commit', version: product.version, vscodeVersion: product.vscodeVersion, validation: 'fixture' }]
  return { base, root, appRoot, home, data, userData, store: join(data, 'transactions'), installation, resources, source: async () => packBytes(), originalProduct: await readFile(join(appRoot, 'product.json')) }
}
