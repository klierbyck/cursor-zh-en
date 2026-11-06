import { parse } from 'acorn'
import { LEGACY, MARKER, WORKBENCH } from '../core/discovery'
import { checksum } from '../core/files'
import { equal, field, parseObject, reverseChanges, setField, type JsonChange } from '../core/json'
import { injectWorkbench } from './plan'

export interface RecoveryFile { current: Buffer | null; restored: Buffer | null }

export function recoverWorkbench(current: string, applied: string): string {
  const block = /<!-- CURSOR_ZH_TOGGLE_V1 -->\r?\n<script src="\.\/cursor-zh-toggle\.js" defer><\/script>\r?\n/g
  const known = applied.match(block)
  const matches = current.match(block)
  if (known?.length !== 1 || LEGACY.test(current)) throw new Error('工作台注入无法确认归属，未覆盖')
  let restored = current
  if (matches?.length) {
    if (matches.length !== 1) throw new Error('工作台注入不唯一，未覆盖')
    restored = current.replace(block, '')
  }
  if (restored.includes(MARKER) || restored.includes('cursor-zh-toggle.js')) throw new Error('工作台注入已被外部修改，未覆盖')
  try { injectWorkbench(restored) } catch { throw new Error('工作台文件发生外部修改或结构不兼容，未覆盖') }
  return restored
}

function trayProperties(source: string): { start: number; end: number; text: string }[] {
  const result: { start: number; end: number; text: string }[] = []
  function visit(node: any): void {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Property' && !node.computed && ['label', 'toolTip'].includes(node.key?.name ?? node.key?.value)) {
      result.push({ start: node.start, end: node.end, text: source.slice(node.start, node.end) })
      return
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object' && 'type' in value) visit(value)
    }
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true }))
  return result
}

export function recoverTray(current: string, original: string, applied: string): string {
  const before = trayProperties(original)
  const after = trayProperties(applied)
  if (before.length !== after.length) throw new Error('托盘补丁快照结构不匹配，未覆盖')
  const changes = new Map<string, string>()
  let reconstructed = applied
  for (let index = after.length - 1; index >= 0; index--) {
    const from = after[index]!
    const to = before[index]!
    if (from.text === to.text) continue
    if (changes.has(from.text) && changes.get(from.text) !== to.text) throw new Error('托盘补丁快照存在歧义，未覆盖')
    changes.set(from.text, to.text)
    reconstructed = reconstructed.slice(0, from.start) + to.text + reconstructed.slice(from.end)
  }
  if (reconstructed !== original) throw new Error('托盘补丁包含未知修改，未覆盖')
  const properties = trayProperties(current)
  for (const text of changes.keys()) {
    if (properties.filter(property => property.text === text).length > 1) throw new Error('托盘恢复锚点不唯一，未覆盖')
  }
  let restored = current
  for (const property of [...properties].reverse()) {
    const replacement = changes.get(property.text)
    if (replacement !== undefined) restored = restored.slice(0, property.start) + replacement + restored.slice(property.end)
    else if (/\bv\s*=>\s*typeof\s+v\s*===\s*["']string["']\s*\?/.test(property.text) || property.text.includes('暂无最近智能体')) {
      throw new Error('托盘注入已被外部修改，未覆盖')
    }
  }
  parse(restored, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })
  return restored
}

export function recoverProduct(current: string, original: string, applied: string, files: Map<string, RecoveryFile>): string {
  const product = parseObject(current, '当前 product.json')
  const before = parseObject(original, '原始 product.json')
  const after = parseObject(applied, '汉化 product.json')
  if (!equal({ ...before, checksums: undefined }, { ...after, checksums: undefined })) throw new Error('产品配置补丁包含未知修改，未覆盖')
  const checksums = product.checksums
  if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums)) throw new Error('当前 product.json 缺少有效校验表')
  let restored = current
  for (const [key, value] of Object.entries(checksums)) {
    const path = key.startsWith('out/') ? key : `out/${key}`
    if (![WORKBENCH, 'out/main.js'].includes(path)) continue
    const file = files.get(path)
    if (!file || file.current === null || file.restored === null) throw new Error(`缺少恢复校验文件：${path}`)
    const next = checksum(file.restored)
    const allowed = [checksum(file.current), next]
    if (!file.current.equals(file.restored)) {
      allowed.push((before.checksums as Record<string, string> | undefined)?.[key] || '', (after.checksums as Record<string, string> | undefined)?.[key] || '')
    }
    if (!allowed.includes(String(value))) throw new Error(`程序文件校验发生冲突，未覆盖：${path}`)
    if (value !== next) restored = setField(restored, ['checksums', key], next)
  }
  return restored
}

export function recoverRegistration(current: string, applied: string, changes: JsonChange[]): string {
  const applicable = changes.filter(change => {
    const actual = field(current, change.path)
    if (!equal(actual, change.applied) && !equal(actual, change.beforeExists ? change.before : undefined)) return false
    if (change.path.length === 2 && ['hash', 'extensions', 'label'].includes(change.path[1]!)) {
      const main = [change.path[0]!, 'translations', 'vscode']
      if (!equal(field(current, main), field(applied, main))) return false
    }
    return true
  })
  return reverseChanges(current, applicable)
}

export function referencedPackFiles(registry: Buffer | null): Set<string> {
  const paths = new Set<string>()
  function visit(value: unknown): void {
    if (typeof value === 'string') paths.add(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  if (registry !== null) visit(parseObject(registry.toString('utf8'), 'languagepacks.json'))
  return paths
}
