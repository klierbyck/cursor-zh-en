import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Script } from 'node:vm'
import type { Installation } from '../core/discovery'
import { LEGACY, MARKER, SCRIPT, WORKBENCH } from '../core/discovery'
import { checksum, readOptional, sha256 } from '../core/files'
import { describeChange, parseObject, setField } from '../core/json'
import type { Patch, Progress } from '../core/transaction'
import type { Compatibility, PlanResources } from '../core/resources'
import { addPrivateBridge, prepareLanguagePack, type downloadPack } from './language-pack'
import { patchTray } from './tray'

export interface ActivationPlan { patches: Patch[]; warnings: string[] }

// Preserve the existing import path for consumers of the patch-planning API.
export { loadResources } from '../core/resources'
export type { Compatibility, Dictionary, PlanResources } from '../core/resources'

export function checkCompatibility(installation: Installation, rules: Compatibility): void {
  if (installation.platform === 'darwin' && !rules.macActivationVerified) throw new Error(rules.macActivationReason)
  if (installation.platform === 'win32' && !rules.allowStructurallyCompatibleWindowsBuilds && !rules.windows.some(item => item.commit === installation.commit && item.version === installation.version && item.vscodeVersion === installation.vscodeVersion)) {
    throw new Error(`Cursor ${installation.version} 尚未纳入适配清单，为防止损坏已停止。请等待适配更新。`)
  }
}

export function injectWorkbench(html: string): string {
  if (LEGACY.test(html)) throw new Error('检测到其他汉化工具的注入，请先使用原工具恢复')
  if (html.includes(MARKER) || html.includes('cursor-zh-toggle.js')) throw new Error('发现本工具注入但没有可用事务，不能重复覆盖')
  const matches = html.match(/<\/html\s*>/gi)
  if (matches?.length !== 1 || !/<script\b[^>]*\bsrc=["']\.\/workbench\.js["']/i.test(html)) throw new Error('工作台结构不符合预期，未注入')
  const csp = html.match(/script-src([\s\S]*?);/i)?.[1]
  if (!csp?.includes("'self'")) throw new Error('工作台 CSP 不允许同源脚本，不会降低安全策略')
  const eol = html.includes('\r\n') ? '\r\n' : '\n'
  return html.replace(/<\/html\s*>/i, `<!-- ${MARKER} -->${eol}<script src="./cursor-zh-toggle.js" defer></script>${eol}</html>`)
}

export { patchTray } from './tray'

export async function buildPlan(installation: Installation, ownedRoot: string, resources: PlanResources, progress: Progress = () => {}, packSource?: typeof downloadPack): Promise<ActivationPlan> {
  checkCompatibility(installation, resources.compatibility)
  const productBytes = await readFile(join(installation.appRoot, 'product.json'))
  let productText = productBytes.toString('utf8')
  const product = parseObject(productText, 'product.json')
  if (product.commit !== installation.commit || product.version !== installation.version) throw new Error('Cursor 构建已变化，请重新检测')
  const html = await readFile(join(installation.appRoot, WORKBENCH))
  const checksums = product.checksums as Record<string, string> | undefined
  const htmlKeys = Object.keys(checksums || {}).filter(key => key.replace(/^out\//, '') === WORKBENCH.replace(/^out\//, ''))
  if (!htmlKeys.length || htmlKeys.some(key => checksums![key] !== checksum(html))) throw new Error('工作台校验与原始产品配置不符，可能已被其他工具修改')
  const scriptPath = join(installation.appRoot, SCRIPT)
  if (await readOptional(scriptPath)) throw new Error('发现未登记的汉化脚本，拒绝覆盖')
  const patchedHtml = Buffer.from(injectWorkbench(html.toString('utf8')))
  const runtime = resources.runtime
  if (/__CURSOR_ZH_/.test(runtime)) throw new Error('翻译运行时未正确组装')
  new Script(runtime, { filename: 'cursor-zh-toggle.js' })

  const registryBytes = await readOptional(join(installation.userData, 'languagepacks.json'))
  const registry = registryBytes?.toString('utf8') || '{}'
  const pack = await prepareLanguagePack(installation, ownedRoot, registry, progress, packSource)
  addPrivateBridge(pack, ownedRoot, resources.dictionary.privateExtensions)
  const patches: Patch[] = [...pack.patches]
  if (pack.registry !== registry) {
    patches.push({ scope: 'user', path: 'languagepacks.json', data: Buffer.from(pack.registry), changes: pack.changes, expected: registryBytes === null ? null : sha256(registryBytes) })
  }
  const argvBytes = await readOptional(installation.argv)
  const argv = argvBytes?.toString('utf8') || '{}\n'
  const localeChange = describeChange(argv, ['locale'], 'zh-cn')
  const translatedArgv = setField(argv, ['locale'], 'zh-cn')
  if (translatedArgv !== argv) patches.push({ scope: 'argv', path: 'argv.json', data: Buffer.from(translatedArgv), changes: [localeChange], expected: argvBytes === null ? null : sha256(argvBytes) })
  // Keep both display-language configuration channels in the same reversible transaction.
  const localeBytes = await readOptional(join(installation.userData, 'User', 'locale.json'))
  const locale = localeBytes?.toString('utf8') || '{}\n'
  const translatedLocale = setField(locale, ['locale'], 'zh-cn')
  if (translatedLocale !== locale) patches.push({ scope: 'user', path: 'User/locale.json', data: Buffer.from(translatedLocale), changes: [describeChange(locale, ['locale'], 'zh-cn')], expected: localeBytes === null ? null : sha256(localeBytes) })
  patches.push(
    { scope: 'app', path: SCRIPT, data: Buffer.from(runtime), expected: null },
    { scope: 'app', path: WORKBENCH, data: patchedHtml, expected: sha256(html) }
  )
  const warnings = [...pack.warnings]
  const mainBytes = await readFile(join(installation.appRoot, 'out/main.js'))
  const tray = patchTray(mainBytes.toString('utf8'), [])
  if (tray.count) {
    const patchedMain = Buffer.from(tray.text)
    patches.push({ scope: 'app', path: 'out/main.js', data: patchedMain, expected: sha256(mainBytes) })
    for (const key of Object.keys(checksums || {}).filter(key => key === 'main.js' || key === 'out/main.js')) {
      if (checksums![key] !== checksum(mainBytes)) throw new Error('主进程文件已被外部修改')
      productText = setField(productText, ['checksums', key], checksum(patchedMain))
    }
  }
  if (tray.missing.length) warnings.push('部分托盘菜单与当前版本结构不同，已保留原文；其他界面汉化不受影响。')
  for (const key of htmlKeys) productText = setField(productText, ['checksums', key], checksum(patchedHtml))
  patches.push({ scope: 'app', path: 'product.json', data: Buffer.from(productText), expected: sha256(productBytes) })
  return { patches, warnings }
}
