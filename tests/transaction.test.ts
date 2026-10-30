import { mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fixture, html, main } from './fixture'
import { buildPlan } from '../src/main/patches/plan'
import { Transaction, pendingTransactions, type Io } from '../src/main/core/transaction'
import { atomicWrite, exists, sha256 } from '../src/main/core/files'
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

  it('refuses an old backup after a Cursor build update', async () => {
    const f = await setup()
    const transaction = await create(f)
    await transaction.apply()
    const updated = { ...f.installation, build: 'different-build' }
    const loaded = await Transaction.load(transaction.directory, updated, f.data)
    await expect(loaded.restore()).rejects.toThrow('Cursor 已更新')
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
