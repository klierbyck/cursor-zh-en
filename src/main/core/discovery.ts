import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { exists, sha256 } from './files'
import { parseObject } from './json'

const exec = promisify(execFile)
export const WORKBENCH = 'out/vs/code/electron-sandbox/workbench/workbench.html'
export const SCRIPT = 'out/vs/code/electron-sandbox/workbench/cursor-zh-toggle.js'
export const MARKER = 'CURSOR_ZH_TOGGLE_V1'
export const LEGACY = /CURSOR_LOCALIZATION_INJECTION|CURSOR_HANHUA_INJECTION|Cursor_Localization\.js|cursor_hanhua\.js/

export interface Installation {
  root: string
  appRoot: string
  executable: string
  platform: 'win32' | 'darwin'
  version: string
  vscodeVersion: string
  commit: string
  identity: string
  build: string
  userData: string
  argv: string
}

export async function inspectInstallation(root: string, platform: 'win32' | 'darwin' = process.platform as 'win32' | 'darwin', home = homedir()): Promise<Installation> {
  if (!['win32', 'darwin'].includes(platform)) throw new Error('仅支持 Windows 和 macOS')
  if (root.toLowerCase().endsWith('cursor.exe')) root = dirname(root)
  root = await realpath(resolve(root))
  const appRoot = platform === 'darwin' ? join(root, 'Contents', 'Resources', 'app') : join(root, 'resources', 'app')
  const executable = platform === 'darwin' ? join(root, 'Contents', 'MacOS', 'Cursor') : join(root, 'Cursor.exe')
  const product = parseObject(await readFile(join(appRoot, 'product.json'), 'utf8'), 'Cursor product.json')
  if (product.applicationName !== 'cursor' || product.nameShort !== 'Cursor' || !(await exists(executable))) {
    throw new Error('所选目录不是有效的 Cursor 安装')
  }
  if (!(await exists(join(appRoot, WORKBENCH)))) throw new Error('当前 Cursor 资源结构不受支持')
  const version = String(product.version ?? '')
  const vscodeVersion = String(product.vscodeVersion ?? '')
  const commit = String(product.commit ?? '')
  if (!version || !vscodeVersion || !commit) throw new Error('无法确定 Cursor 构建身份，拒绝修改')
  const portable = join(root, 'data')
  if (await exists(portable)) throw new Error('当前版本暂不支持便携模式，避免误写用户配置')
  const userData = process.env.CURSOR_USER_DATA_DIR || (platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Cursor')
    : join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor'))
  return {
    root, appRoot, executable, platform, version, vscodeVersion, commit,
    identity: sha256(platform === 'win32' ? root.toLowerCase() : root).slice(0, 24),
    build: sha256(`${version}\0${commit}\0${vscodeVersion}`).slice(0, 24),
    userData: resolve(userData), argv: join(home, '.cursor', 'argv.json')
  }
}

export async function discover(): Promise<Installation[]> {
  const home = homedir()
  const candidates = [process.env.CURSOR_INSTALL_DIR || '']
  if (process.platform === 'darwin') candidates.push('/Applications/Cursor.app', join(home, 'Applications', 'Cursor.app'))
  else if (process.platform === 'win32') {
    candidates.push(
      join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'cursor'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Cursor'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Cursor')
    )
    try {
      const result = await exec('reg.exe', ['query', 'HKCU\\Software\\Classes\\Applications\\Cursor.exe\\shell\\open\\command', '/ve'], { windowsHide: true, timeout: 5000 })
      const match = result.stdout.match(/"([^"\r\n]*Cursor\.exe)"/i)
      if (match?.[1]) candidates.push(dirname(match[1]))
    } catch { /* Optional discovery source, never used to authorize writes. */ }
  }
  const installations = new Map<string, Installation>()
  for (const candidate of candidates) {
    if (!candidate || !(await exists(candidate))) continue
    try {
      const installation = await inspectInstallation(candidate)
      installations.set(installation.identity, installation)
    } catch { /* A candidate must pass full validation before being selectable. */ }
  }
  return [...installations.values()]
}
