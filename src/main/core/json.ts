import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'

export function parseObject(text: string, label = 'JSON'): Record<string, unknown> {
  const errors: ParseError[] = []
  const data: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} 格式无效，未修改原文件`)
  }
  return data as Record<string, unknown>
}

export function setField(text: string, path: (string | number)[], value: unknown): string {
  parseObject(text)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return applyEdits(text, modify(text, path, value, {
    formattingOptions: { insertSpaces: !text.includes('\t'), tabSize: 2, eol }
  }))
}

export function field(text: string, path: string[]): unknown {
  let value: unknown = parseObject(text)
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  const aa = a as Record<string, unknown>
  const bb = b as Record<string, unknown>
  const keys = Object.keys(aa)
  return keys.length === Object.keys(bb).length && keys.every(key => Object.hasOwn(bb, key) && equal(aa[key], bb[key]))
}

export interface JsonChange {
  path: string[]
  beforeExists: boolean
  before?: unknown
  applied: unknown
  beforeAncestors?: boolean[]
}

export function describeChange(text: string, path: string[], applied: unknown): JsonChange {
  const before = field(text, path)
  const beforeAncestors = path.slice(0, -1).map((_key, index) => field(text, path.slice(0, index + 1)) !== undefined)
  return { path, beforeExists: before !== undefined, ...(before !== undefined ? { before } : {}), applied, beforeAncestors }
}

export function reverseChanges(current: string, changes: JsonChange[]): string {
  let result = current
  // Validate all owned fields before making any edit.
  for (const change of changes) {
    const actual = field(current, change.path)
    const before = change.beforeExists ? change.before : undefined
    if (!equal(actual, change.applied) && !equal(actual, before)) {
      throw new Error(`配置字段发生冲突，已保留用户内容：${change.path.join('.')}`)
    }
  }
  for (const change of [...changes].reverse()) {
    if (equal(field(result, change.path), change.applied)) {
      result = setField(result, change.path, change.beforeExists ? change.before : undefined)
      for (let depth = change.path.length - 1; depth >= 1; depth--) {
        const ancestor = change.path.slice(0, depth)
        const current = field(result, ancestor)
        const existedBefore = change.beforeAncestors?.[depth - 1] ?? true
        if (!existedBefore && current && typeof current === 'object' && !Array.isArray(current) && Object.keys(current).length === 0) {
          result = setField(result, ancestor, undefined)
        }
      }
    }
  }
  return result
}
