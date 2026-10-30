import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { exists, sha256 } from '../core/files'
import { describeChange, equal, field, parseObject, setField, type JsonChange } from '../core/json'
import type { Installation } from '../core/discovery'
import type { Patch, Progress } from '../core/transaction'

const ID = 'ms-ceintl.vscode-language-pack-zh-hans'
const BASE = 'https://marketplace.visualstudio.com/_apis/public/gallery'
export interface PackPlan {
  patches: Patch[]
  registry: string
  changes: JsonChange[]
  warnings: string[]
  baseRegistry?: string
  registryKey?: string
  managedPaths?: string[][]
}

async function responseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`语言包服务返回 HTTP ${response.status}`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('语言包响应为空')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > maximum) throw new Error('语言包响应超出安全大小限制')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks)
}

export function compatibleVersion(pack: string, vscode: string): boolean {
  const parts = vscode.match(/^(\d+)\.(\d+)\./)
  return !!parts && pack.startsWith(`${parts[1]}.${parts[2]}.`)
}

export async function downloadPack(vscodeVersion: string): Promise<Uint8Array> {
  const response = await fetch(`${BASE}/extensionquery`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json;api-version=7.2-preview.1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: ID }] }], flags: 1 })
  })
  const data = JSON.parse(Buffer.from(await responseBytes(response, 12 * 1024 * 1024)).toString('utf8'))
  const versions: unknown = data?.results?.[0]?.extensions?.[0]?.versions
  if (!Array.isArray(versions)) throw new Error('无法读取官方语言包版本列表')
  const version = versions.map(item => item?.version).find(item => typeof item === 'string' && compatibleVersion(item, vscodeVersion))
  if (!version || !/^[\d.]+$/.test(version)) throw new Error(`未找到适配 VS Code ${vscodeVersion} 的简体中文语言包，未修改 Cursor`)
  const download = await fetch(`${BASE}/publishers/MS-CEINTL/vsextensions/vscode-language-pack-zh-hans/${version}/vspackage`, { signal: AbortSignal.timeout(90000) })
  return responseBytes(download, 48 * 1024 * 1024)
}

export function unpackLanguagePack(bytes: Uint8Array, vscodeVersion: string, ownedRoot: string): PackPlan {
  let total = 0
  const files = unzipSync(bytes, {
    filter: entry => {
      total += entry.originalSize
      if (entry.originalSize > 64 * 1024 * 1024 || total > 160 * 1024 * 1024) throw new Error('语言包解压大小超出限制')
      return entry.name.startsWith('extension/') && !entry.name.endsWith('/')
    }
  })
  const packageBytes = files['extension/package.json']
  if (!packageBytes) throw new Error('VSIX 缺少 package.json')
  const pkg = parseObject(Buffer.from(packageBytes).toString('utf8'), '语言包 package.json')
  if (String(pkg.publisher).toLowerCase() !== 'ms-ceintl' || pkg.name !== 'vscode-language-pack-zh-hans' || !compatibleVersion(String(pkg.version), vscodeVersion)) {
    throw new Error('语言包来源标识或版本不匹配')
  }
  const contributions = pkg.contributes as { localizations?: { languageId: string; translations: { id: string; path: string }[] }[] } | undefined
  const localization = contributions?.localizations?.find(item => item.languageId.toLowerCase() === 'zh-cn')
  if (!localization || !Array.isArray(localization.translations)) throw new Error('语言包缺少简体中文翻译注册')
  const packId = `${String(pkg.version).replace(/[^a-zA-Z0-9._-]/g, '_')}-${sha256(bytes).slice(0, 12)}`
  const patches: Patch[] = []
  for (const [name, content] of Object.entries(files)) {
    if (name.includes('\\') || name.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('VSIX 包含不安全路径')
    patches.push({ scope: 'owned', path: `packs/${packId}/${name}`, data: Buffer.from(content), expected: null })
  }
  const translations: Record<string, string> = {}
  for (const translation of localization.translations) {
    if (typeof translation.id !== 'string' || typeof translation.path !== 'string') throw new Error('语言包翻译条目无效')
    const normalized = translation.path.replace(/^\.\//, '')
    if (normalized.split('/').some(part => !part || part === '..' || part === '.') || normalized.includes('\\')) throw new Error('语言包翻译路径无效')
    const key = `extension/${normalized}`
    if (!files[key]) throw new Error(`语言包翻译文件缺失：${key}`)
    parseObject(Buffer.from(files[key]).toString('utf8'), key)
    translations[translation.id] = join(ownedRoot, 'packs', packId, key)
  }
  if (!translations.vscode) throw new Error('语言包缺少 VS Code 主翻译')
  const config = {
    hash: sha256(bytes).slice(0, 32),
    extensions: [{ extensionIdentifier: { id: ID }, version: String(pkg.version) }],
    translations, label: '中文(简体)'
  }
  return { patches, registry: JSON.stringify(config), changes: [], warnings: [] }
}

function rebuildRegistryChanges(plan: PackPlan): void {
  if (!plan.baseRegistry || !plan.registryKey || !plan.managedPaths) return
  const unique = new Map(plan.managedPaths.map(path => [JSON.stringify(path), path]))
  plan.changes = []
  for (const path of unique.values()) {
    const before = field(plan.baseRegistry, path)
    const applied = field(plan.registry, path)
    if (applied === undefined || equal(before, applied)) continue
    plan.changes.push(describeChange(plan.baseRegistry, path, applied))
  }
}

export async function prepareLanguagePack(installation: Installation, ownedRoot: string, registryText: string, progress: Progress, source = downloadPack): Promise<PackPlan> {
  const registry = parseObject(registryText, 'languagepacks.json')
  for (const key of ['zh-cn', 'zh-CN']) {
    const config = registry[key] as { extensions?: { version?: string }[]; translations?: Record<string, string> } | undefined
    const main = config?.translations?.vscode
    if (main && config?.extensions?.some(ext => compatibleVersion(ext.version || '', installation.vscodeVersion)) && await exists(main)) {
      progress('复用已有中文语言包，不改动用户扩展', 18)
      return { patches: [], registry: registryText, changes: [], warnings: [], baseRegistry: registryText, registryKey: key, managedPaths: [] }
    }
  }
  progress('正在获取兼容的官方中文语言包', 12)
  const plan = unpackLanguagePack(await source(installation.vscodeVersion), installation.vscodeVersion, ownedRoot)
  const config = JSON.parse(plan.registry) as { hash: string; extensions: unknown[]; translations: Record<string, string>; label: string }
  const key = registry['zh-CN'] && !registry['zh-cn'] ? 'zh-CN' : 'zh-cn'
  const existing = registry[key] && typeof registry[key] === 'object' && !Array.isArray(registry[key]) ? registry[key] as Record<string, unknown> : {}
  const existingTranslations = existing.translations && typeof existing.translations === 'object' && !Array.isArray(existing.translations) ? existing.translations as Record<string, unknown> : {}
  const existingExtensions = Array.isArray(existing.extensions) ? existing.extensions : []
  const mergedExtensions = existingExtensions.filter(item => {
    const extension = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const identifier = extension.extensionIdentifier && typeof extension.extensionIdentifier === 'object' ? extension.extensionIdentifier as Record<string, unknown> : {}
    return identifier.id !== ID
  })
  mergedExtensions.push(...config.extensions)
  const merged = {
    ...existing,
    hash: config.hash,
    extensions: mergedExtensions,
    translations: { ...existingTranslations, ...config.translations },
    label: config.label
  }
  plan.baseRegistry = registryText
  plan.registryKey = key
  plan.managedPaths = [
    [key, 'hash'], [key, 'extensions'], [key, 'label'],
    ...Object.keys(config.translations).map(id => [key, 'translations', id])
  ]
  plan.registry = setField(registryText, [key], merged)
  rebuildRegistryChanges(plan)
  // Register private translations without installing/uninstalling global extensions or touching extension databases.
  plan.warnings.push('语言包使用工具自有目录注册，不修改扩展安装数据库；Cursor 更新或重建语言注册后需重新检查状态。')
  return plan
}

export function addPrivateBridge(plan: PackPlan, ownedRoot: string, dictionary: Record<string, Record<string, string>>): void {
  const data = parseObject(plan.registry)
  const key = data['zh-cn'] ? 'zh-cn' : data['zh-CN'] ? 'zh-CN' : undefined
  if (!key) throw new Error('缺少中文语言注册，无法桥接')
  let text = plan.registry
  for (const [id, content] of Object.entries(dictionary)) {
    if (!/^[a-z0-9.-]+$/i.test(id)) throw new Error('私有扩展 ID 无效')
    const path = `packs/bridge-v1/${id}.i18n.json`
    const applied = join(ownedRoot, path)
    const fieldPath = [key, 'translations', id]
    if (!plan.managedPaths) plan.managedPaths = []
    plan.managedPaths.push(fieldPath)
    text = setField(text, fieldPath, applied)
    plan.patches.push({ scope: 'owned', path, data: Buffer.from(JSON.stringify({ version: '1.0.0', contents: { package: content } }, null, 2)), expected: null })
  }
  if (text !== plan.registry) {
    // VS Code caches tcf.json by language-pack hash. Reusing the old hash can hide
    // newly registered anysphere/Inspecta translations until the cache is deleted.
    const config = data[key] as { hash?: string }
    text = setField(text, [key, 'hash'], sha256(`${config.hash || ''}\0${JSON.stringify(dictionary)}`).slice(0, 32))
    plan.managedPaths!.push([key, 'hash'])
  }
  plan.registry = text
  rebuildRegistryChanges(plan)
}
