import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { loadResources } from '../src/main/patches/plan'

const root = join(process.cwd(), 'resources')
const minimum = {
  core: 2598, notices: 179, entries: 2631, patterns: 239, fragments: 86, dropdown: 332,
  settingsMcp: 8, settingsDomains: 8, pluginNames: 31, skillNames: 8, nameStems: 36,
  marketLabels: 35, marketFragments: 15, marketPatterns: 2, marketDescriptions: 103
}
it('retains all complete functional resource groups, not a small replacement dictionary', async () => {
  const resources = await loadResources(root)
  for (const [group, count] of Object.entries(minimum)) expect(resources.coverage[group], group).toBeGreaterThanOrEqual(count)
  expect(resources.coverage.effectiveEntries).toBeGreaterThan(2700)
})
it('translates every registered dropdown option in a real role=option menu while leaving no option on the source text', async () => {
  const resources = await loadResources(root)
  const catalog = JSON.parse(await readFile(join(root, 'localization/catalog.json'), 'utf8'))
  const dom = new JSDOM(`<body><main class="monaco-workbench"><div class="context-view"><div role="listbox">${catalog.dropdown.map(([from]: [string, string], index: number) => `<div role="option" id="dropdown-${index}">${from.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</div>`).join('')}</div></div></main></body>`, { runScripts: 'outside-only', pretendToBeVisual: true })
  try {
    dom.window.eval(resources.runtime)
    await new Promise(resolve => setTimeout(resolve, 700))
    const untranslated = catalog.dropdown.filter(([_from, to]: [string, string], index: number) => (dom.window.document.querySelector(`#dropdown-${index}`)!.textContent || '').trim() !== to.trim()).map(([from]: [string]) => from)
    expect(untranslated).toEqual([])
  } finally { dom.window.dispatchEvent(new dom.window.Event('cursorzh:dispose')); dom.window.close() }
})
it('loads every effective dictionary entry, pattern and contextual fragment into the actual injected runtime', async () => {
  const resources = await loadResources(root)
  const catalog = JSON.parse(await readFile(join(root, 'localization/catalog.json'), 'utf8'))
  const end = resources.runtime.lastIndexOf('})();')
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', pretendToBeVisual: true })
  try {
    dom.window.eval(resources.runtime.slice(0, end) + `window.testApi={dictionary:FanYi_CiDian,patterns:MoShi_FanYi,partial:DingXiang_SuiPian,dropdown:XiaLa_MianBan_SuiPian,mcp:Cursor_SheZhi_MCP_SuiPian,domains:Cursor_SheZhi_Domain_SuiPian,market:__ShiChang_CiDian_Ke(),lookup:ChaZhao_FanYi,capabilities:[typeof XiuZheng_Cursor_SheZhi,typeof XiuZheng_DingBu_CaiDanTiao,typeof XiuZheng_BianJiQi_YouJianCaiDan,typeof XiuZheng_TiJi_CaiDan,typeof XiuZheng_SheZhi_XiaLaKuang,typeof XiuZheng_LiaoTian_LiShi,typeof XiuZheng_GuangGao_TanChuang,typeof XiuZheng_LiuLanQi_GongJuTiao,typeof XiuZheng_LiuLanQi_CuoWu,typeof XiuZheng_SheJi_MianBan,typeof XiuZheng_ShiChang_FanYi,typeof AnZhuang_Monaco_Hover_FanYi,typeof AnZhuang_FuZhu_ChuangKou_FanYi,typeof FanYi_PromptBar_WenBen,typeof XiuZheng_DuiLie_XiaoXi]};` + resources.runtime.slice(end))
    const api = (dom.window as any).testApi
    expect(Array.from(api.capabilities)).toEqual(Array(15).fill('function'))
    for (const [text, translated] of Object.entries(resources.dictionary.entries)) expect(api.dictionary.get(text), text).toBe(translated)
    for (const [index, rule] of catalog.patterns.entries()) {
      expect(api.patterns[index][0].source).toBe(new RegExp(rule.regex, rule.flags).source)
      expect(api.patterns[index][0].flags).toBe(new RegExp(rule.regex, rule.flags).flags)
      expect(api.patterns[index][1]).toBe(rule.replacement)
    }
    expect(Array.from(api.partial).slice(0, catalog.fragments.length)).toEqual(catalog.fragments)
    expect(Array.from(api.dropdown)).toEqual(catalog.dropdown)
    expect(Array.from(api.mcp)).toEqual(catalog.settings.mcpEntries)
    expect(Array.from(api.domains)).toEqual(catalog.settings.domainEntries)
    for (const key of ['pluginNames', 'skillNames', 'nameStems', 'uiLabels', 'uiFragments', 'descriptionFragments']) expect(api.market[key]).toEqual(catalog.marketplace[key])
    expect(api.lookup('12 requests remaining')).toBe('12 次请求剩余')
    expect(api.lookup('12 files indexed')).toBe('12 个文件已索引')
  } finally { dom.window.dispatchEvent(new dom.window.Event('cursorzh:dispose')); dom.window.close() }
})
it.each(['catalog.json', 'runtime.js'])('fails closed rather than silently using a subset when %s is missing or changed', async file => {
  const base = await mkdtemp(join(tmpdir(), 'cursorzh-coverage-'))
  try {
    await cp(join(root, 'localization'), join(base, 'localization'), { recursive: true })
    await cp(join(root, 'compatibility.json'), join(base, 'compatibility.json'))
    const path = join(base, 'localization', file)
    const bytes = await readFile(path)
    await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]))
    await expect(loadResources(base)).rejects.toThrow('资源校验失败')
    await rm(path)
    await expect(loadResources(base)).rejects.toThrow()
  } finally { await rm(base, { recursive: true, force: true }) }
})
