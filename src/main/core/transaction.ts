import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rm, rmdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { Installation } from './discovery'
import { SCRIPT, WORKBENCH } from './discovery'
import { assertSafePath, atomicWrite, exists, fileHash, metadata, readOptional, restoreTimes, sha256, within, writeJson } from './files'
import { reverseChanges, type JsonChange } from './json'

export type Scope = 'app' | 'user' | 'argv' | 'owned'
export interface Patch {
  scope: Scope
  path: string
  data: Buffer
  expected?: string | null
  changes?: JsonChange[]
}

const changeSchema = z.object({ path: z.array(z.string()).min(1), beforeExists: z.boolean(), before: z.unknown().optional(), applied: z.unknown(), beforeAncestors: z.array(z.boolean()).optional() })
const entrySchema = z.object({
  scope: z.enum(['app', 'user', 'argv', 'owned']), path: z.string(),
  before: z.string().nullable(), after: z.string(), original: z.string().nullable(),
  metadata: z.object({ mode: z.number(), mtime: z.number(), atime: z.number() }).optional(),
  changes: z.array(changeSchema).optional(),
  windowsAcl: z.string().optional(),
  restored: z.boolean().default(false),
  restoreHash: z.string().nullable().optional(),
  restoreBlob: z.string().optional()
})
const schema = z.object({
  schema: z.literal(1), id: z.uuid(), identity: z.string(), build: z.string(),
  root: z.string(), userData: z.string(), argv: z.string(), version: z.string(), commit: z.string(),
  state: z.enum(['preparing', 'prepared', 'applying', 'active', 'restoring', 'restored', 'conflict']),
  created: z.string(), entries: z.array(entrySchema),
  createdDirectories: z.array(z.object({ scope: z.enum(['app', 'user', 'argv', 'owned']), path: z.string() })),
  warnings: z.array(z.string()), lastError: z.string().optional()
})
export type Manifest = z.infer<typeof schema>
export type Entry = Manifest['entries'][number]
export type Progress = (message: string, progress: number) => void
export interface Io {
  write(path: string, bytes: Buffer, mode?: number): Promise<void>
  remove(path: string): Promise<void>
  security?(path: string, sddl: string): Promise<void>
}
const defaultIo: Io = {
  write: atomicWrite,
  remove: async path => { await rm(path, { force: true }) }
}

export class Transaction {
  private constructor(
    readonly directory: string,
    readonly installation: Installation,
    readonly ownedRoot: string,
    public manifest: Manifest,
    private io: Io = defaultIo
  ) {}

  static async create(store: string, installation: Installation, ownedRoot: string, patches: Patch[], warnings: string[] = [], io: Io = defaultIo): Promise<Transaction> {
    const id = randomUUID()
    const directory = join(store, installation.identity, id)
    await assertSafePath(store, directory)
    await mkdir(join(directory, 'originals'), { recursive: true, mode: 0o700 })
    const transaction = new Transaction(directory, installation, ownedRoot, {
      schema: 1, id, identity: installation.identity, build: installation.build,
      root: installation.root, userData: installation.userData, argv: installation.argv,
      version: installation.version, commit: installation.commit,
      state: 'preparing', created: new Date().toISOString(), entries: [], createdDirectories: [], warnings
    }, io)
    // Persist an intent before snapshots. A preparing transaction has never written targets.
    await transaction.save()
    const seen = new Set<string>()
    for (const [index, patch] of patches.entries()) {
      const target = await transaction.target(patch)
      if (seen.has(target)) throw new Error(`重复补丁目标：${target}`)
      seen.add(target)
      const info = await metadata(target)
      const bytes = await readOptional(target)
      if (patch.expected !== undefined && (bytes === null ? null : sha256(bytes)) !== patch.expected) {
        throw new Error(`补丁规划后文件已变化，拒绝覆盖：${patch.path}`)
      }
      const original = bytes === null ? null : `${index}.bin`
      if (original !== null) {
        await atomicWrite(join(directory, 'originals', original), bytes!)
        if (await fileHash(join(directory, 'originals', original)) !== sha256(bytes!)) throw new Error('备份校验失败')
      }
      const entry: Entry = {
        scope: patch.scope, path: patch.path, before: bytes === null ? null : sha256(bytes),
        after: sha256(patch.data), original, metadata: info, changes: patch.changes,
        restored: false
      }
      // Staging and original snapshots are both durable before any target write.
      await atomicWrite(join(directory, `${index}.after`), patch.data)
      transaction.manifest.entries.push(entry)
      let parent = dirname(target)
      const root = transaction.scopeRoot(patch.scope)
      while (within(root, parent) && !(await exists(parent))) {
        const rel = relative(root, parent)
        if (!transaction.manifest.createdDirectories.some(d => d.scope === patch.scope && d.path === rel)) {
          transaction.manifest.createdDirectories.push({ scope: patch.scope, path: rel })
        }
        const next = dirname(parent)
        if (next === parent) break
        parent = next
      }
      await transaction.save()
    }
    transaction.manifest.state = 'prepared'
    await transaction.save()
    return transaction
  }

  static async load(directory: string, installation: Installation, ownedRoot: string, io: Io = defaultIo): Promise<Transaction> {
    await assertSafePath(dirname(dirname(directory)), directory)
    const manifest = schema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
    if (manifest.identity !== installation.identity || resolve(manifest.root) !== resolve(installation.root) ||
        resolve(manifest.userData) !== resolve(installation.userData) || resolve(manifest.argv) !== resolve(installation.argv)) {
      throw new Error('备份与当前安装或用户数据目录不一致，拒绝写入')
    }
    const transaction = new Transaction(directory, installation, ownedRoot, manifest, io)
    for (const entry of manifest.entries) {
      await transaction.target(entry)
      if (entry.original !== null && !/^\d+\.bin$/.test(entry.original)) throw new Error('备份文件名无效')
      if (entry.restoreBlob && !/^\d+\.restore$/.test(entry.restoreBlob)) throw new Error('恢复暂存文件名无效')
    }
    return transaction
  }

  scopeRoot(scope: Scope): string {
    return ({ app: this.installation.appRoot, user: this.installation.userData, argv: dirname(this.installation.argv), owned: this.ownedRoot })[scope]
  }

  async target(entry: Pick<Entry, 'scope' | 'path'>): Promise<string> {
    if (entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error(`非白名单或不安全相对路径：${entry.path}`)
    }
    const allow = {
      app: [WORKBENCH, SCRIPT, 'out/main.js', 'product.json'],
      user: ['languagepacks.json', 'User/locale.json'], argv: ['argv.json']
    }
    if (entry.scope !== 'owned' && !allow[entry.scope].includes(entry.path)) throw new Error(`非白名单目标：${entry.path}`)
    if (entry.scope === 'owned' && !/^packs\/[a-zA-Z0-9._-]+\//.test(entry.path)) throw new Error('非白名单语言包目录')
    const root = this.scopeRoot(entry.scope)
    const target = resolve(root, entry.path)
    if (target === resolve(root)) throw new Error('不能将根目录用作文件')
    await assertSafePath(root, target)
    return target
  }

  useIo(io: Io): void { this.io = io }

  async save(): Promise<void> {
    await writeJson(join(this.directory, 'manifest.json'), this.manifest)
  }

  assertBuild(): void {
    if (this.manifest.build !== this.installation.build) throw new Error('Cursor 已更新：禁止旧版备份覆盖新版。请保留备份并先使用官方安装包修复或联系维护者。')
  }

  async apply(progress: Progress = () => {}): Promise<void> {
    this.assertBuild()
    // Validate the complete read set before committing anything.
    for (const entry of this.manifest.entries) {
      if (await fileHash(await this.target(entry)) !== entry.before) throw new Error(`激活前文件发生变化：${entry.path}`)
    }
    this.manifest.state = 'applying'
    await this.save()
    for (const [index, entry] of this.manifest.entries.entries()) {
      const target = await this.target(entry)
      const bytes = await readFile(join(this.directory, `${index}.after`))
      if (sha256(bytes) !== entry.after) throw new Error('暂存补丁损坏，已停止')
      const current = await fileHash(target)
      if (current !== entry.before && current !== entry.after) throw new Error(`文件被并发修改：${entry.path}`)
      if (current !== entry.after) await this.io.write(target, bytes, entry.metadata?.mode ?? (entry.scope === 'app' ? 0o644 : 0o600))
      if (await fileHash(target) !== entry.after) throw new Error(`写入校验失败：${entry.path}`)
      if (entry.windowsAcl) {
        if (!this.io.security) throw new Error('缺少文件权限恢复适配器')
        await this.io.security(target, entry.windowsAcl)
      }
      progress(`正在应用汉化 ${index + 1}/${this.manifest.entries.length}`, 30 + Math.round((index + 1) / this.manifest.entries.length * 65))
    }
    this.manifest.state = 'active'
    await this.save()
  }

  async inspect(): Promise<{ intact: boolean; conflicts: string[] }> {
    const conflicts: string[] = []
    for (const entry of this.manifest.entries) {
      const hash = await fileHash(await this.target(entry))
      if (hash !== entry.after) conflicts.push(entry.path)
    }
    return { intact: !conflicts.length, conflicts }
  }

  async restore(progress: Progress = () => {}): Promise<void> {
    this.assertBuild()
    if (this.manifest.state === 'preparing') {
      this.manifest.state = 'restored'
      await this.save()
      return
    }
    // Preflight EVERY file and snapshot before changing any target.
    for (const [index, entry] of this.manifest.entries.entries()) {
      const target = await this.target(entry)
      const current = await readOptional(target)
      const hash = current === null ? null : sha256(current)
      if (entry.restoreHash !== undefined && hash === entry.restoreHash) continue
      let original: Buffer | null = null
      if (entry.original !== null) {
        original = await readFile(join(this.directory, 'originals', entry.original))
        if (sha256(original) !== entry.before) throw new Error(`原始备份损坏：${entry.path}`)
      }
      let restored: Buffer | null
      if (hash === entry.before) restored = current
      else if (hash === entry.after) restored = original
      else if (entry.changes?.length && current !== null) {
        restored = Buffer.from(reverseChanges(current.toString('utf8'), entry.changes))
      } else throw new Error(`文件发生外部修改，未覆盖：${entry.path}`)
      if (entry.before === null && entry.changes?.length && /^\s*\{\s*\}\s*$/.test(restored?.toString('utf8') || '')) restored = null
      entry.restoreHash = restored === null ? null : sha256(restored)
      if (restored !== null) {
        entry.restoreBlob = `${index}.restore`
        await atomicWrite(join(this.directory, entry.restoreBlob), restored)
      }
      // Persist intended restore hash BEFORE the corresponding write (crash safe).
      await this.save()
    }
    this.manifest.state = 'restoring'
    await this.save()
    for (const [index, entry] of [...this.manifest.entries.entries()].reverse()) {
      const target = await this.target(entry)
      const hash = await fileHash(target)
      if (hash !== entry.restoreHash) {
        if (hash !== entry.after && !(entry.changes?.length)) throw new Error(`恢复时发现并发修改：${entry.path}`)
        if (entry.restoreHash === null) await this.io.remove(target)
        else {
          if (!entry.restoreBlob) throw new Error('恢复暂存丢失')
          const bytes = await readFile(join(this.directory, entry.restoreBlob))
          if (sha256(bytes) !== entry.restoreHash) throw new Error('恢复暂存损坏')
          // Shared configuration must not overwrite concurrent unrelated edits.
          if (entry.changes?.length && hash !== entry.after) {
            const current = await readFile(target, 'utf8')
            const rebased = Buffer.from(reverseChanges(current, entry.changes))
            if (sha256(rebased) !== entry.restoreHash) throw new Error(`共享配置被并发修改，请重试：${entry.path}`)
          }
          await this.io.write(target, bytes, entry.metadata?.mode ?? 0o600)
          if (entry.metadata && process.platform !== 'win32') await chmod(target, entry.metadata.mode)
          if (entry.restoreHash === entry.before) await restoreTimes(target, entry.metadata)
        }
      }
      if (await fileHash(target) !== entry.restoreHash) throw new Error(`恢复校验失败：${entry.path}`)
      if (entry.windowsAcl && entry.restoreHash !== null) {
        if (!this.io.security) throw new Error('缺少文件权限恢复适配器')
        await this.io.security(target, entry.windowsAcl)
      }
      entry.restored = true
      await this.save()
      progress(`正在验证恢复 ${this.manifest.entries.length - index}/${this.manifest.entries.length}`, 20 + Math.round((this.manifest.entries.length - index) / this.manifest.entries.length * 75))
    }
    for (const directory of [...this.manifest.createdDirectories].sort((a, b) => b.path.length - a.path.length)) {
      const root = this.scopeRoot(directory.scope)
      const target = resolve(root, directory.path)
      await assertSafePath(root, target)
      try { await rmdir(target) } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error
      }
    }
    this.manifest.state = 'restored'
    delete this.manifest.lastError
    await this.save()
  }
}

export async function pendingTransactions(store: string, identity: string): Promise<string[]> {
  const directory = join(store, identity)
  if (!(await exists(directory))) return []
  await assertSafePath(store, directory)
  const pending: { path: string; created: string }[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || !z.uuid().safeParse(item.name).success) continue
    const path = join(directory, item.name)
    const manifestPath = join(path, 'manifest.json')
    if (!(await exists(manifestPath))) throw new Error(`备份清单丢失，请保留目录检查：${path}`)
    const manifest = schema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    if (manifest.state !== 'restored') pending.push({ path, created: manifest.created })
  }
  return pending.sort((a, b) => b.created.localeCompare(a.created)).map(item => item.path)
}
