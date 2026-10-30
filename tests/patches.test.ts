import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { fixture, html, packBytes } from './fixture'
import { buildPlan, checkCompatibility, injectWorkbench, patchTray } from '../src/main/patches/plan'
import { compatibleVersion, unpackLanguagePack, prepareLanguagePack } from '../src/main/patches/language-pack'
import { Transaction } from '../src/main/core/transaction'
import { parseObject } from '../src/main/core/json'

const cleanups: string[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('patch safety', () => {
  it('preserves newline style and refuses duplicate or foreign injections', () => {
    const patched = injectWorkbench(html)
    expect(patched).toContain('CURSOR_ZH_TOGGLE_V1')
    expect(patched).toContain('defer></script>\r\n</html>')
    expect(() => injectWorkbench(patched)).toThrow('没有可用事务')
    expect(() => injectWorkbench(html.replace('</body>', '<!-- CURSOR_LOCALIZATION_INJECTION --></body>'))).toThrow('其他汉化')
    expect(() => injectWorkbench(html.replace("'self'", "'none'"))).toThrow('CSP')
    expect(() => injectWorkbench(html + '</html>')).toThrow('结构')
  })

  it('only changes unique tray labels and leaves unrelated text untouched', () => {
    const source = 'const title="New Agent";const menu={label:"New Agent"};'
    expect(patchTray(source, [['label:"New Agent"', 'label:"新建智能体"']]).text).toBe('const title="New Agent";const menu={label:"新建智能体"};')
    expect(() => patchTray(source + 'label:"New Agent"', [['label:"New Agent"', 'label:"新建智能体"']])).toThrow('不唯一')
  })

  it('rejects unvalidated Windows builds and Mac writes', async () => {
    const f = await fixture(); cleanups.push(f.base)
    expect(() => checkCompatibility({ ...f.installation, commit: 'unknown' }, f.resources.compatibility)).toThrow('适配清单')
    expect(() => checkCompatibility({ ...f.installation, platform: 'darwin' }, f.resources.compatibility)).toThrow('安全禁用')
  })

  it('selects only language packs matching the embedded VS Code major.minor', () => {
    expect(compatibleVersion('1.128.20261001', '1.128.0')).toBe(true)
    expect(compatibleVersion('1.127.20261001', '1.128.0')).toBe(false)
    expect(() => unpackLanguagePack(packBytes('1.127.0'), '1.128.0', '/test')).toThrow('版本不匹配')
  })

  it('rejects unsafe or substituted language packs', () => {
    const substituted = zipSync({ 'extension/package.json': strToU8('{"publisher":"evil","name":"vscode-language-pack-zh-hans","version":"1.128.0"}') })
    expect(() => unpackLanguagePack(substituted, '1.128.0', '/test')).toThrow('来源标识')
    const unsafe = zipSync({
      'extension/package.json': strToU8('{"publisher":"MS-CEINTL","name":"vscode-language-pack-zh-hans","version":"1.128.0","contributes":{"localizations":[{"languageId":"zh-cn","translations":[]}]}}'),
      'extension/../../escape': strToU8('bad')
    })
    expect(() => unpackLanguagePack(unsafe, '1.128.0', '/test')).toThrow('不安全路径')
  })

  it('reuses an existing matching language pack without downloading or modifying it', async () => {
    const f = await fixture(); cleanups.push(f.base)
    const existing = join(f.base, 'user-existing-pack', 'translations', 'main.i18n.json')
    await mkdir(join(f.base, 'user-existing-pack', 'translations'), { recursive: true })
    await writeFile(existing, '{"contents":{}}')
    const registry = JSON.stringify({ 'zh-cn': { extensions: [{ version: '1.128.0' }], hash: 'existing', translations: { vscode: existing, custom: '/untouched' }, label: '中文(简体)' }, en: { label: 'English' } })
    await writeFile(join(f.userData, 'languagepacks.json'), registry)
    const plan = await buildPlan(f.installation, f.data, f.resources, () => {}, async () => { throw new Error('must not download') })
    const registration = parseObject(plan.patches.find(patch => patch.path === 'languagepacks.json')!.data.toString())['zh-cn'] as { hash: string; translations: Record<string, string> }
    expect(registration.hash).not.toBe('existing')
    for (const id of Object.keys(f.resources.dictionary.privateExtensions)) expect(registration.translations[id], id).toBeTruthy()
    expect(registration.translations['inspecta.inspecta-ide-integration']).toBeTruthy()
    const transaction = await Transaction.create(f.store, f.installation, f.data, plan.patches)
    await transaction.apply()
    await transaction.restore()
    expect(await readFile(join(f.userData, 'languagepacks.json'), 'utf8')).toBe(registry)
    expect(await readFile(existing, 'utf8')).toBe('{"contents":{}}')
  })

  it('uses a compatible official language package source and rejects an incompatible one', async () => {
    const f = await fixture(); cleanups.push(f.base)
    const source = vi.fn(async () => packBytes())
    const plan = await prepareLanguagePack(f.installation, f.data, '{}', () => {}, source)
    expect(source).toHaveBeenCalledWith('1.128.0')
    expect(plan.patches.some(patch => patch.path.endsWith('/extension/translations/main.i18n.json'))).toBe(true)
    await expect(prepareLanguagePack(f.installation, f.data, '{}', () => {}, async () => packBytes('1.105.0'))).rejects.toThrow('版本不匹配')
  })

  it('records field-level language registration changes so unrelated registry fields survive', async () => {
    const f = await fixture(); cleanups.push(f.base)
    const plan = await buildPlan(f.installation, f.data, f.resources, () => {}, f.source)
    const registry = plan.patches.find(patch => patch.scope === 'user')!
    expect(registry.changes!.length).toBeGreaterThan(3)
    expect(registry.changes!.every(change => change.path[0] === 'zh-cn')).toBe(true)
    expect(registry.changes!.some(change => change.path.join('.') === 'zh-cn.translations.vscode')).toBe(true)
    expect(registry.changes!.every(change => change.beforeExists === false)).toBe(true)
    expect(parseObject(registry.data.toString())['zh-cn']).toBeTruthy()
  })
})
