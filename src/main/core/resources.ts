import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { z } from 'zod'
import { sha256 } from './files'

export interface Compatibility {
  schema: number
  macActivationVerified: boolean
  macActivationReason: string
  windows: { commit: string; version: string; vscodeVersion: string; validation: string }[]
  allowStructurallyCompatibleWindowsBuilds: boolean
}

export interface Dictionary {
  source: string
  entries: Record<string, string>
  privateExtensions: Record<string, Record<string, string>>
}

export interface PlanResources {
  runtime: string
  dictionary: Dictionary
  compatibility: Compatibility
  coverage: Record<string, number>
}

const labels = z.record(z.string().min(1), z.string().min(1))
const pairs = z.array(z.tuple([z.string().min(1), z.string()]))
const rules = z.array(z.object({ regex: z.string().min(1), flags: z.string(), replacement: z.string() }))
const localSchema = z.object({ entries: labels, fragments: pairs.default([]), patterns: rules.default([]) })
const catalogSchema = z.object({
  entries: labels, patterns: rules, fragments: pairs, dropdown: pairs,
  settings: z.object({ symlink: z.object({ zh: z.string(), zhAdmin: z.string(), tail: z.string() }), mcpEntries: pairs, domainEntries: pairs }),
  marketplace: z.object({ pluginNames: labels, skillNames: labels, nameStems: labels, uiLabels: labels, uiFragments: pairs, patterns: rules, descriptionFragments: pairs })
})
const coverageSchema = z.object({
  schema: z.literal(1),
  catalogSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  counts: z.record(z.string(), z.number().int().nonnegative())
})

function normalize(text: string): string { return text.replace(/\r\n/g, '\n') }

function catalogCounts(catalog: z.infer<typeof catalogSchema>): Record<string, number> {
  return {
    entries: Object.keys(catalog.entries).length,
    patterns: catalog.patterns.length,
    fragments: catalog.fragments.length,
    dropdown: catalog.dropdown.length,
    settingsMcp: catalog.settings.mcpEntries.length,
    settingsDomains: catalog.settings.domainEntries.length,
    pluginNames: Object.keys(catalog.marketplace.pluginNames).length,
    skillNames: Object.keys(catalog.marketplace.skillNames).length,
    nameStems: Object.keys(catalog.marketplace.nameStems).length,
    marketLabels: Object.keys(catalog.marketplace.uiLabels).length,
    marketFragments: catalog.marketplace.uiFragments.length,
    marketPatterns: catalog.marketplace.patterns.length,
    marketDescriptions: catalog.marketplace.descriptionFragments.length
  }
}

export async function loadResources(root: string): Promise<PlanResources> {
  const folder = join(root, 'localization')
  const [catalogText, template, supplementText, privateText, coverageText] = await Promise.all([
    readFile(join(folder, 'catalog.json'), 'utf8'),
    readFile(join(folder, 'runtime.js'), 'utf8'),
    readFile(join(folder, 'dictionary.json'), 'utf8'),
    readFile(join(folder, 'private-extensions.json'), 'utf8'),
    readFile(join(folder, 'coverage.json'), 'utf8')
  ])
  const integrity = coverageSchema.parse(JSON.parse(coverageText))
  if (sha256(normalize(catalogText)) !== integrity.catalogSha256 || sha256(normalize(template)) !== integrity.runtimeSha256) {
    throw new Error('完整翻译资源校验失败，请重新安装助手')
  }
  const catalog = catalogSchema.parse(JSON.parse(catalogText))
  const supplement = localSchema.parse(JSON.parse(supplementText))
  const privateExtensions = z.record(z.string().regex(/^[a-z0-9.-]+$/i), labels).parse(JSON.parse(privateText))
  const actual = catalogCounts(catalog)
  if (Object.entries(actual).some(([key, count]) => integrity.counts[key] !== count)) {
    throw new Error('翻译资源覆盖清单不一致，未注入')
  }
  const entries = { ...catalog.entries, ...supplement.entries }
  const config = {
    ...catalog,
    entries,
    patterns: [...catalog.patterns, ...supplement.patterns],
    fragments: [...catalog.fragments, ...supplement.fragments],
    coverage: { ...integrity.counts, effectiveEntries: Object.keys(entries).length }
  }
  for (const rule of [...config.patterns, ...config.marketplace.patterns]) new RegExp(rule.regex, rule.flags)
  if (template.split('__CURSOR_ZH_RESOURCES__').length !== 2) throw new Error('翻译运行时模板锚点不唯一')
  const runtime = template.replace('__CURSOR_ZH_RESOURCES__', () => JSON.stringify(config).replace(/</g, '\\u003c'))
  if (/__CURSOR_ZH_/.test(runtime)) throw new Error('翻译运行时模板未完整组装')
  new Script(runtime, { filename: 'cursor-zh-toggle.js' })
  return {
    runtime,
    dictionary: { source: 'built-in', entries, privateExtensions },
    coverage: config.coverage,
    compatibility: JSON.parse(await readFile(join(root, 'compatibility.json'), 'utf8'))
  }
}
