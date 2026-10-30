import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const folder = new URL('../resources/localization/', import.meta.url)
const normalize = text => text.replace(/\r\n/g, '\n')
const hash = text => createHash('sha256').update(normalize(text)).digest('hex')
const [catalogText, runtimeText, integrityText] = await Promise.all(['catalog.json', 'runtime.js', 'coverage.json'].map(file => readFile(new URL(file, folder), 'utf8')))
const catalog = JSON.parse(catalogText)
const integrity = JSON.parse(integrityText)
const counts = {
  entries: Object.keys(catalog.entries).length, patterns: catalog.patterns.length,
  fragments: catalog.fragments.length, dropdown: catalog.dropdown.length,
  settingsMcp: catalog.settings.mcpEntries.length, settingsDomains: catalog.settings.domainEntries.length,
  pluginNames: Object.keys(catalog.marketplace.pluginNames).length, skillNames: Object.keys(catalog.marketplace.skillNames).length,
  nameStems: Object.keys(catalog.marketplace.nameStems).length, marketLabels: Object.keys(catalog.marketplace.uiLabels).length,
  marketFragments: catalog.marketplace.uiFragments.length, marketPatterns: catalog.marketplace.patterns.length,
  marketDescriptions: catalog.marketplace.descriptionFragments.length
}
for (const [key, count] of Object.entries(counts)) {
  if (count < integrity.counts[key]) throw new Error(`翻译资源覆盖减少：${key} ${integrity.counts[key]} → ${count}`)
}
for (const rule of [...catalog.patterns, ...catalog.marketplace.patterns]) new RegExp(rule.regex, rule.flags)
if (runtimeText.split('__CURSOR_ZH_RESOURCES__').length !== 2) throw new Error('翻译运行时模板锚点不唯一')
const hashes = { catalogSha256: hash(catalogText), runtimeSha256: hash(runtimeText) }
if (process.argv.includes('--seal')) {
  await writeFile(new URL('coverage.json', folder), JSON.stringify({ ...integrity, ...hashes, counts: { ...integrity.counts, ...counts } }, null, 2) + '\n')
  console.log('翻译资源覆盖与校验值已更新；请继续执行 npm test。')
} else {
  if (Object.entries(hashes).some(([key, value]) => integrity[key] !== value) || Object.entries(counts).some(([key, value]) => integrity.counts[key] !== value)) throw new Error('翻译资源校验失败；完成改动后请执行 npm run localization:seal 并运行测试')
  console.log(`翻译资源验证通过：${counts.entries} 条界面文本，${counts.patterns} 条动态规则，${counts.dropdown} 条下拉片段。`)
}
