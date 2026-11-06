import { mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fixture, html, main, upgrade } from './fixture'
import { buildPlan } from '../src/main/patches/plan'
import { Transaction, pendingTransactions, type Io } from '../src/main/core/transaction'
import { atomicWrite, checksum, exists, sha256 } from '../src/main/core/files'
import { parseObject, setField } from '../src/main/core/json'
import { SCRIPT, WORKBENCH } from '../src/main/core/discovery'

const cleanups: string[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() { const f = await fixture(); cleanups.push(f.base); return f }

async function create(f: Awaited<ReturnType<typeof fixture>>, io?: Io) {
  const plan = await buildPlan(f.installation, f.data, f.resources, () => {}, f.source)
  return Transaction.create(f.store, f.installation, f.data, plan.patches, plan.warnings, io)
}

describe('transactional localization', () => {
  it('activates and restores all original bytes, deleting only new owned files', async () => {
    const f = await setup()
    await mkdir(dirname(f.installation.argv), { recursive: true })
    const argv = '// Keep this comment\r\n{ "locale": "en", "other": 7 }\r\n'
    await writeFile(f.installation.argv, argv)
    const transaction = await create(f)
    await transaction.apply()
    expect((await transaction.inspect()).intact).toBe(true)
    expect(parseObject(await readFile(f.installation.argv, 'utf8')).locale).toBe('zh-cn')
    expect(parseObject(await readFile(join(f.userData, 'User/locale.json'), 'utf8')).locale).toBe('zh-cn')
    expect(await exists(join(f.appRoot, SCRIPT))).toBe(true)
    expect(await readFile(join(f.appRoot, 'out/main.js'), 'utf8')).toContain('新建智能体')
    await transaction.restore()
    expect(await readFile(join(f.appRoot, WORKBENCH), 'utf8')).toBe(html)
    expect(await readFile(join(f.appRoot, 'out/main.js'), 'utf8')).toBe(main)
    expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(f.originalProduct)
    expect(await readFile(f.installation.argv, 'utf8')).toBe(argv)
    expect(await exists(join(f.appRoot, SCRIPT))).toBe(false)
    expect(await exists(join(f.userData, 'languagepacks.json'))).toBe(false)
    expect(await exists(join(f.userData, 'User/locale.json'))).toBe(false)
    expect(await exists(join(f.userData, 'User'))).toBe(false)
    expect(await exists(join(f.data, 'packs'))).toBe(false)
    expect(await pendingTransactions(f.store, f.installation.identity)).toEqual([])
    expect(await exists(join(transaction.directory, 'originals'))).toBe(true)
  })

  it('restores absence of a new argv.json and its newly created empty parent', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    await transaction.restore()
    expect(await exists(f.installation.argv)).toBe(false)
    expect(await exists(dirname(f.installation.argv))).toBe(false)
  })

  it('preserves unrelated user edits by reversing only owned JSON fields', async () => {
    const f = await setup()
    await mkdir(dirname(f.installation.argv), { recursive: true })
    await writeFile(f.installation.argv, '// user comment\n{"locale":"en", "font":14}\n')
    const transaction = await create(f)
    await transaction.apply()
    const argv = await readFile(f.installation.argv, 'utf8')
    await writeFile(f.installation.argv, setField(argv, ['font'], 18))
    const registryPath = join(f.userData, 'languagepacks.json')
    const registry = await readFile(registryPath, 'utf8')
    await writeFile(registryPath, setField(registry, ['de'], { label: 'Deutsch' }))
    await transaction.restore()
    const restored = await readFile(f.installation.argv, 'utf8')
    expect(restored).toContain('// user comment')
    expect(parseObject(restored)).toEqual({ locale: 'en', font: 18 })
    expect(parseObject(await readFile(registryPath, 'utf8'))).toEqual({ de: { label: 'Deutsch' } })
  })

  it('restores User/locale.json by field and keeps unrelated user preferences', async () => {
    const f = await setup()
    const path = join(f.userData, 'User/locale.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '// display preferences\n{"locale":"en","font":14}\n')
    const transaction = await create(f)
    await transaction.apply()
    await writeFile(path, setField(await readFile(path, 'utf8'), ['font'], 18))
    await transaction.restore()
    const restored = await readFile(path, 'utf8')
    expect(restored).toContain('// display preferences')
    expect(parseObject(restored)).toEqual({ locale: 'en', font: 18 })
  })

  it('does not overwrite a changed owned locale and makes no partial target restore', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    await writeFile(f.installation.argv, '{"locale":"ja"}')
    const activeHtml = await readFile(join(f.appRoot, WORKBENCH))
    await expect(transaction.restore()).rejects.toThrow('配置字段发生冲突')
    expect(await readFile(join(f.appRoot, WORKBENCH))).toEqual(activeHtml)
    expect(parseObject(await readFile(f.installation.argv, 'utf8')).locale).toBe('ja')
  })

  it('rejects changed application resources before touching any other target', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    await writeFile(join(f.appRoot, WORKBENCH), 'external edit')
    const argv = await readFile(f.installation.argv)
    await expect(transaction.restore()).rejects.toThrow('文件发生外部修改')
    expect(await readFile(f.installation.argv)).toEqual(argv)
  })

  it('restores unchanged resources even if the recorded build has changed', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const updated = { ...f.installation, build: 'different-build' }
    const loaded = await Transaction.load(transaction.directory, updated, f.data)
    await loaded.restore()
    expect(await readFile(join(f.appRoot, WORKBENCH), 'utf8')).toBe(html)
    expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(f.originalProduct)
    expect(loaded.manifest.state).toBe('restored')
  })

  it.each([
    { injected: false, tray: false, script: false },
    { injected: true, tray: false, script: true },
    { injected: false, tray: true, script: true },
    { injected: true, tray: true, script: true }
  ])('preserves the new build while removing only surviving patches: %j', async options => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const next = await upgrade(f, options)
    const loaded = await Transaction.load(transaction.directory, next.installation, f.data)
    await loaded.restore()
    expect(await readFile(join(f.appRoot, WORKBENCH), 'utf8')).toBe(next.html)
    expect(await readFile(join(f.appRoot, 'out/main.js'), 'utf8')).toBe(next.main)
    expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(next.product)
    expect(await exists(join(f.appRoot, SCRIPT))).toBe(false)
    expect(await exists(f.installation.argv)).toBe(false)
    expect(await exists(join(f.data, 'packs'))).toBe(false)
    expect(loaded.manifest.state).toBe('restored')
    f.installation = next.installation
    const reactivated = await create(f)
    await reactivated.apply()
    expect((await reactivated.inspect()).intact).toBe(true)
    await reactivated.restore()
    expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(next.product)
  })

  it('accepts legacy schema-1 backups without product field changes or restore read sets', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const productEntry = transaction.manifest.entries.find(entry => entry.path === 'product.json')!
    delete productEntry.changes
    await transaction.save()
    const next = await upgrade(f, { injected: true, tray: true })
    const loaded = await Transaction.load(transaction.directory, next.installation, f.data)
    await loaded.restore()
    expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(next.product)
    expect(await readFile(join(f.appRoot, WORKBENCH), 'utf8')).toBe(next.html)
  })

  it('preserves the current Windows ACL when undoing patches in newer program files', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    transaction.manifest.entries.find(entry => entry.path === WORKBENCH)!.windowsAcl = 'D:old-build'
    await transaction.save()
    const next = await upgrade(f, { injected: true })
    const security = vi.fn(async () => {})
    const loaded = await Transaction.load(transaction.directory, next.installation, f.data, {
      write: atomicWrite,
      remove: path => rm(path, { force: true }),
      acls: async paths => Object.fromEntries(paths.map(path => [path, 'D:current-build'])),
      security
    })
    await loaded.restore()
    expect(security).toHaveBeenCalledWith(join(f.appRoot, WORKBENCH), 'D:current-build')
    expect(security.mock.calls.flat()).not.toContain('D:old-build')
  })

  it.each([false, true])('keeps a rebuilt registry and removes only known bridge registrations: upgraded=%s', async upgraded => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const registryPath = join(f.userData, 'languagepacks.json')
    const active = parseObject(await readFile(registryPath, 'utf8')) as Record<string, { translations: Record<string, string> }>
    const newer = {
      'zh-cn': { hash: 'new-cache', extensions: [{ version: '1.129.0' }], label: '中文(简体)', translations: { ...active['zh-cn']!.translations, vscode: join(f.base, 'new-language-pack.json'), custom: '/new/custom.json' } },
      de: { label: 'Deutsch' }
    }
    await writeFile(registryPath, JSON.stringify(newer))
    const installation = upgraded ? (await upgrade(f)).installation : f.installation
    const loaded = await Transaction.load(transaction.directory, installation, f.data)
    await loaded.restore()
    expect(parseObject(await readFile(registryPath, 'utf8'))).toEqual({
      'zh-cn': { ...newer['zh-cn'], translations: { vscode: join(f.base, 'new-language-pack.json'), custom: '/new/custom.json' } },
      de: { label: 'Deutsch' }
    })
    expect(await exists(join(f.data, 'packs'))).toBe(false)
  })

  it('does not resurrect a registry removed by an upgrade', async () => {
    const f = await setup()
    const registryPath = join(f.userData, 'languagepacks.json')
    await writeFile(registryPath, '{"de":{"label":"Deutsch"}}')
    const transaction = await create(f)
    await transaction.apply()
    const next = await upgrade(f)
    await rm(registryPath)
    const loaded = await Transaction.load(transaction.directory, next.installation, f.data)
    await loaded.restore()
    expect(await exists(registryPath)).toBe(false)
  })

  it('retains the entire owned language pack if an unrelated registration still references it', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const file = transaction.manifest.entries.find(entry => entry.scope === 'owned' && entry.path.endsWith('main.i18n.json'))!
    const registryPath = join(f.userData, 'languagepacks.json')
    await writeFile(registryPath, setField(await readFile(registryPath, 'utf8'), ['custom'], { translations: { vscode: await transaction.target(file) } }))
    const next = await upgrade(f)
    const loaded = await Transaction.load(transaction.directory, next.installation, f.data)
    await loaded.restore()
    for (const entry of transaction.manifest.entries.filter(entry => entry.scope === 'owned' && entry.path.split('/')[1] === file.path.split('/')[1])) {
      expect(await exists(await transaction.target(entry))).toBe(true)
    }
    expect(Object.keys(parseObject(await readFile(registryPath, 'utf8')))).toEqual(['custom'])
    f.installation = next.installation
    const reactivated = await create(f)
    await reactivated.apply()
    await reactivated.restore()
    expect(await exists(await transaction.target(file))).toBe(true)
    expect(Object.keys(parseObject(await readFile(registryPath, 'utf8')))).toEqual(['custom'])
  })

  it('preserves unrelated product fields rather than restoring the whole product snapshot', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const path = join(f.appRoot, 'product.json')
    await writeFile(path, setField(await readFile(path, 'utf8'), ['userPreference'], 42))
    await transaction.restore()
    expect(parseObject(await readFile(path, 'utf8'))).toEqual({ ...parseObject(f.originalProduct.toString('utf8')), userPreference: 42 })
  })

  it('rejects unknown current checksums before restoring any file after an upgrade', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const next = await upgrade(f)
    const path = join(f.appRoot, 'product.json')
    await writeFile(path, setField(await readFile(path, 'utf8'), ['checksums', 'main.js'], 'unknown-checksum'))
    const argv = await readFile(f.installation.argv)
    const loaded = await Transaction.load(transaction.directory, next.installation, f.data)
    await expect(loaded.restore()).rejects.toThrow('程序文件校验发生冲突')
    expect(await readFile(f.installation.argv)).toEqual(argv)
  })

  it('rechecks checksum dependencies even when no tray patch was installed', async () => {
    const f = await setup()
    const mainPath = join(f.appRoot, 'out/main.js')
    const mainText = 'const mainWithoutTray=1;'
    await writeFile(mainPath, mainText)
    const productPath = join(f.appRoot, 'product.json')
    await writeFile(productPath, setField(await readFile(productPath, 'utf8'), ['checksums', 'main.js'], checksum(Buffer.from(mainText))))
    const transaction = await create(f)
    expect(transaction.manifest.entries.some(entry => entry.path === 'out/main.js')).toBe(false)
    await transaction.apply()
    const activeHtml = await readFile(join(f.appRoot, WORKBENCH))
    const activeProduct = await readFile(productPath)
    transaction.useIo({
      write: atomicWrite,
      remove: path => rm(path, { force: true }),
      acls: async () => {
        await writeFile(mainPath, 'const concurrentMainUpdate=2;')
        return {}
      }
    })
    await expect(transaction.restore()).rejects.toThrow('恢复依赖文件被并发修改')
    expect(await readFile(join(f.appRoot, WORKBENCH))).toEqual(activeHtml)
    expect(await readFile(productPath)).toEqual(activeProduct)
    expect(await readFile(mainPath, 'utf8')).toBe('const concurrentMainUpdate=2;')
  })

  it('does not delete a concurrently edited configuration after preflight planned removal', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    let edited = false
    transaction.useIo({
      write: async (path, data, mode) => {
        await atomicWrite(path, data, mode)
        if (!edited) {
          edited = true
          await writeFile(f.installation.argv, '{"locale":"zh-cn","userPreference":42}')
        }
      },
      remove: path => rm(path, { force: true })
    })
    await expect(transaction.restore()).rejects.toThrow('并发修改')
    expect(parseObject(await readFile(f.installation.argv, 'utf8')).userPreference).toBe(42)
    const recovered = await Transaction.load(transaction.directory, f.installation, f.data)
    await recovered.restore()
    expect(parseObject(await readFile(f.installation.argv, 'utf8'))).toEqual({ userPreference: 42 })
  })

  it.each(['workbench', 'configuration'])('resumes an upgraded restore interrupted after a %s change', async point => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const next = await upgrade(f, { injected: true, tray: true, script: true })
    const loaded = await Transaction.load(transaction.directory, next.installation, f.data, {
      write: async (path, data, mode) => {
        await atomicWrite(path, data, mode)
        if (point === 'workbench' && path === join(f.appRoot, WORKBENCH)) throw new Error('interrupted upgraded restore')
      },
      remove: async path => {
        await rm(path, { force: true })
        if (point === 'configuration' && path === f.installation.argv) throw new Error('interrupted upgraded restore')
      }
    })
    await expect(loaded.restore()).rejects.toThrow('interrupted upgraded restore')
    const resumed = await Transaction.load(transaction.directory, next.installation, f.data)
    await resumed.restore()
    expect(resumed.manifest.state).toBe('restored')
    expect(await readFile(join(f.appRoot, WORKBENCH), 'utf8')).toBe(next.html)
    expect(await readFile(join(f.appRoot, 'out/main.js'), 'utf8')).toBe(next.main)
    expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(next.product)
    expect(await exists(join(f.appRoot, SCRIPT))).toBe(false)
  })

  it('rejects a concurrent pack registration before deleting any owned pack files', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const owned = transaction.manifest.entries.find(entry => entry.scope === 'owned')!
    const registryPath = join(f.userData, 'languagepacks.json')
    const referenced = await transaction.target(owned)
    const nonOwned = transaction.manifest.entries.filter(entry => entry.scope !== 'owned').length
    let completed = 0
    await expect(transaction.restore(() => {
      if (++completed === nonOwned) writeFileSync(registryPath, JSON.stringify({ custom: { translations: { vscode: referenced } } }))
    })).rejects.toThrow('语言包注册被并发修改')
    expect(await exists(referenced)).toBe(true)
  })

  it('preflights all original backup hashes before restore writes', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const entry = transaction.manifest.entries.find(entry => entry.original !== null)!
    await writeFile(join(transaction.directory, 'originals', entry.original!), 'corrupt')
    const argv = await readFile(f.installation.argv)
    await expect(transaction.restore()).rejects.toThrow('原始备份损坏')
    expect(await readFile(f.installation.argv)).toEqual(argv)
  })

  it('rechecks the preimage between planning and backup', async () => {
    const f = await setup()
    const plan = await buildPlan(f.installation, f.data, f.resources, () => {}, f.source)
    await writeFile(join(f.appRoot, WORKBENCH), 'concurrent edit')
    await expect(Transaction.create(f.store, f.installation, f.data, plan.patches)).rejects.toThrow('补丁规划后文件已变化')
    expect(await readFile(join(f.appRoot, WORKBENCH), 'utf8')).toBe('concurrent edit')
  })

  it('survives interruption at every activation write and restores untouched targets too', async () => {
    const f = await setup()
    const plan = await buildPlan(f.installation, f.data, f.resources, () => {}, f.source)
    for (let failAt = 1; failAt <= plan.patches.length; failAt++) {
      let count = 0
      const io: Io = {
        write: async (path, data, mode) => {
          if (++count === failAt) throw new Error('simulated power loss')
          await atomicWrite(path, data, mode)
        }, remove: path => rm(path, { force: true })
      }
      const transaction = await Transaction.create(f.store, f.installation, f.data, plan.patches, [], io)
      await expect(transaction.apply()).rejects.toThrow('simulated power loss')
      const recovered = await Transaction.load(transaction.directory, f.installation, f.data)
      await recovered.restore()
      expect(await readFile(join(f.appRoot, WORKBENCH), 'utf8')).toBe(html)
      expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(f.originalProduct)
      expect(await exists(f.installation.argv)).toBe(false)
      expect(await exists(join(f.data, 'packs'))).toBe(false)
    }
  }, 90000)

  it('can resume a restore that crashed after a merged configuration write', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const registryPath = join(f.userData, 'languagepacks.json')
    await writeFile(registryPath, setField(await readFile(registryPath, 'utf8'), ['fr'], { label: 'Français' }))
    let crashed = false
    transaction.useIo({
      write: async (path, data, mode) => {
        await atomicWrite(path, data, mode)
        if (path === registryPath && !crashed) { crashed = true; throw new Error('crash after write') }
      }, remove: path => rm(path, { force: true })
    })
    await expect(transaction.restore()).rejects.toThrow('crash after write')
    const recovered = await Transaction.load(transaction.directory, f.installation, f.data)
    await recovered.restore()
    expect(parseObject(await readFile(registryPath, 'utf8'))).toEqual({ fr: { label: 'Français' } })
    expect(recovered.manifest.state).toBe('restored')
  })

  it('rejects symlink/junction redirection and non-allowlisted targets', async () => {
    const f = await setup()
    await expect(Transaction.create(f.store, f.installation, f.data, [{ scope: 'app', path: '../../forbidden', data: Buffer.from('x') }])).rejects.toThrow('非白名单')
    const real = join(f.base, 'outside')
    await mkdir(real)
    const redirected = join(f.data, 'packs')
    await symlink(real, redirected, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(Transaction.create(f.store, f.installation, f.data, [{ scope: 'owned', path: 'packs/test/file', data: Buffer.from('x') }])).rejects.toThrow('符号链接或 junction')
  })

  it('supports ten consecutive activation/restore cycles without stale backups', async () => {
    const f = await setup()
    for (let i = 0; i < 10; i++) {
      const transaction = await create(f)
      await transaction.apply()
      await transaction.restore()
    }
    expect(sha256(await readFile(join(f.appRoot, 'product.json')))).toBe(sha256(f.originalProduct))
    expect(await pendingTransactions(f.store, f.installation.identity)).toEqual([])
  })
})
