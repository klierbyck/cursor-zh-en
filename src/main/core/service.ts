import { mkdir, readFile, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { ViewState } from '../../shared/types'
import { discover, inspectInstallation, LEGACY, MARKER, SCRIPT, WORKBENCH, type Installation } from './discovery'
import { assertSafePath, exists, readOptional, sha256, writeJson } from './files'
import { parseObject } from './json'
import { pendingTransactions, Transaction, type Progress } from './transaction'
import { buildPlan, checkCompatibility } from '../patches/plan'
import { loadResources, type PlanResources } from './resources'
import { ensureCursorStopped, installationLock, privilegedIo } from '../platform/system'
import { captureWindowsAcls } from '../platform/windows-metadata'

export interface ServiceOptions {
  dataRoot: string
  resourcesRoot: string
  chooseInstallation(): Promise<string | undefined>
  initialInstallation?: string
  emit(state: ViewState): void
}

export class LocalizationService {
  private installation?: Installation
  private busy = false
  private scanning = false
  private resources?: PlanResources
  private value: ViewState = {
    status: 'scanning', title: '正在检测 Cursor', message: '只读检查安装与恢复资料',
    platform: process.platform === 'darwin' ? `macOS · ${process.arch === 'arm64' ? 'Apple Silicon' : 'Intel'}` : 'Windows · x64',
    progress: 0, canToggle: false, action: 'retry', warnings: []
  }
  readonly store: string

  constructor(private options: ServiceOptions) { this.store = join(options.dataRoot, 'transactions') }
  get state(): ViewState { return structuredClone(this.value) }
  get isBusy(): boolean { return this.busy || this.scanning }

  private set(patch: Partial<ViewState>): ViewState {
    this.value = { ...this.value, ...patch }
    this.options.emit(this.state)
    return this.state
  }
  private progress: Progress = (message, progress) => { this.set({ status: 'busy', message, progress, canToggle: false }) }

  async initialize(): Promise<ViewState> {
    await assertSafePath(this.options.dataRoot, this.store)
    await mkdir(this.store, { recursive: true, mode: 0o700 })
    this.resources = await loadResources(this.options.resourcesRoot)
    if (this.options.initialInstallation) {
      this.installation = await inspectInstallation(this.options.initialInstallation)
      await writeJson(join(this.options.dataRoot, 'selection.json'), { root: this.installation.root })
    }
    const saved = this.installation ? null : await readOptional(join(this.options.dataRoot, 'selection.json'))
    if (saved) {
      const selection = parseObject(saved.toString('utf8'))
      if (typeof selection.root === 'string') {
        try { this.installation = await inspectInstallation(selection.root) } catch { /* Re-discover moved installation. */ }
      }
    }
    if (!this.installation) {
      const candidates = await discover()
      if (candidates.length === 1) this.installation = candidates[0]
    }
    return this.refresh()
  }

  async rescan(): Promise<ViewState> {
    if (this.isBusy) return this.state
    this.scanning = true
    try {
      this.installation = undefined
      this.set({ status: 'scanning', title: '正在刷新状态', message: '重新检查安装、资源与恢复资料', canToggle: false, action: 'retry', progress: 0, warnings: [], backup: undefined, installation: undefined, version: undefined })
      return await this.initialize()
    } catch (error) {
      return this.set({ status: 'error', title: '刷新未完成', message: errorText(error), canToggle: false, action: 'retry', progress: 0 })
    } finally { this.scanning = false }
  }

  async refresh(): Promise<ViewState> {
    if (this.busy) return this.state
    try {
      if (!this.installation) {
        return this.set({ status: 'missing', title: '请选择 Cursor', message: '点击按钮选择 Cursor.exe 所在文件夹或 Cursor.app', canToggle: true, action: 'locate', progress: 0 })
      }
      const installation = this.installation = await inspectInstallation(this.installation.root)
      this.set({ installation: installation.root, version: installation.version })
      const pending = await pendingTransactions(this.store, installation.identity)
      if (pending.length > 1) throw new Error('检测到多个未完成事务，为避免覆盖已停止；请保留全部备份联系维护者。')
      if (pending[0]) {
        const transaction = await Transaction.load(pending[0], installation, this.options.dataRoot)
        this.set({ backup: pending[0], warnings: transaction.manifest.warnings.map(warning => warning.startsWith('托盘汉化匹配') ? '当前使用旧版托盘适配。取消汉化后重新激活，即可应用新版托盘修复。' : warning) })
        if (transaction.manifest.build !== installation.build) {
          return this.set({ status: 'conflict', title: 'Cursor 已更新', message: '已禁止旧版备份覆盖新版。请保留恢复资料；当前版本需要人工核实后清理。', canToggle: false, action: 'restore', progress: 0 })
        }
        if (transaction.manifest.state === 'active') {
          const result = await transaction.inspect()
          const installedRuntime = transaction.manifest.entries.find(entry => entry.scope === 'app' && entry.path === SCRIPT)
          const newerTranslation = result.intact && installedRuntime?.after !== sha256(this.resources!.runtime)
          return this.set({
            status: result.intact ? 'active' : 'recovery', title: result.intact ? '汉化已激活' : '汉化状态发生变化',
            message: result.intact
              ? newerTranslation ? '检测到新版翻译资源。请先取消旧汉化，再重新激活以应用完整翻译和语音补充。' : '取消时恢复激活前的文件与语言配置'
              : '检测到文件或配置变化，将在取消前逐项检查，不覆盖冲突内容',
            canToggle: true, action: 'restore', progress: result.intact ? 100 : 0
          })
        }
        return this.set({ status: 'recovery', title: '需要完成恢复', message: transaction.manifest.lastError || '上次操作未完成，点击按钮继续安全恢复', canToggle: true, action: 'restore', progress: 0 })
      }
      const html = await readFile(join(installation.appRoot, WORKBENCH), 'utf8')
      if (LEGACY.test(html) || html.includes(MARKER) || await exists(join(installation.appRoot, SCRIPT))) {
        return this.set({ status: 'conflict', title: '发现已有汉化', message: '没有可信原始备份，不能直接接管。请先使用原工具恢复或用官方安装包修复。', canToggle: false, action: 'activate', progress: 0 })
      }
      checkCompatibility(installation, this.resources!.compatibility)
      return this.set({ status: 'inactive', title: '准备就绪', message: '先完整备份，再应用汉化；不会强制退出 Cursor', canToggle: true, action: 'activate', progress: 0, backup: undefined, warnings: [] })
    } catch (error) {
      return this.set({ status: 'unsupported', title: '安全检查未通过', message: errorText(error), canToggle: false, progress: 0 })
    }
  }

  async toggle(): Promise<ViewState> {
    if (this.isBusy) return this.state
    if (this.value.action === 'locate') {
      const selected = await this.options.chooseInstallation()
      if (!selected) return this.state
      try {
        this.installation = await inspectInstallation(selected)
        await writeJson(join(this.options.dataRoot, 'selection.json'), { root: this.installation.root })
        return this.refresh()
      } catch (error) {
        return this.set({ status: 'error', title: '目录无法使用', message: errorText(error), canToggle: true, action: 'locate' })
      }
    }
    if (!this.value.canToggle || !this.installation) return this.refresh()
    this.busy = true
    const requested = this.value.action
    let release: (() => Promise<void>) | undefined
    let transaction: Transaction | undefined
    try {
      this.progress('检查 Cursor 是否已完全退出', 2)
      const installation = this.installation = await inspectInstallation(this.installation.root)
      await ensureCursorStopped(installation)
      release = await installationLock(this.store, installation.identity)
      const pending = await pendingTransactions(this.store, installation.identity)
      if (pending.length > 1) throw new Error('存在多个未完成事务，已停止操作')
      if (requested === 'restore') {
        if (!pending[0]) throw new Error('未找到恢复清单，不能猜测原始文件')
        transaction = await Transaction.load(pending[0], installation, this.options.dataRoot)
        transaction.useIo(privilegedIo(transaction, this.options.resourcesRoot))
        await transaction.restore(this.progress)
        this.set({ message: '恢复验证通过。重新启动 Cursor 后生效。' })
      } else {
        if (pending.length) throw new Error('请先完成上一次恢复')
        checkCompatibility(installation, this.resources!.compatibility)
        this.progress('预演补丁与检查语言包', 6)
        const plan = await buildPlan(installation, this.options.dataRoot, this.resources!, this.progress)
        // Downloads and preparation can take time: re-check processes and build before commit.
        await ensureCursorStopped(installation)
        const fresh = await inspectInstallation(installation.root)
        if (fresh.build !== installation.build) throw new Error('准备期间 Cursor 已更新，未修改任何程序文件')
        const required = plan.patches.reduce((sum, patch) => sum + patch.data.length * 3, 0) + 64 * 1024 * 1024
        for (const path of [this.options.dataRoot, installation.appRoot]) {
          const disk = await statfs(path)
          if (disk.bavail * disk.bsize < required) throw new Error('可用磁盘空间不足，未开始写入')
        }
        this.progress('保存并验证原始备份', 25)
        transaction = await Transaction.create(this.store, installation, this.options.dataRoot, plan.patches, plan.warnings)
        const originalTargets = await Promise.all(transaction.manifest.entries.filter(entry => entry.before !== null).map(entry => transaction!.target(entry)))
        const acls = await captureWindowsAcls(originalTargets)
        for (const entry of transaction.manifest.entries) entry.windowsAcl = acls[await transaction.target(entry)]
        await transaction.save()
        transaction.useIo(privilegedIo(transaction, this.options.resourcesRoot))
        await transaction.apply(this.progress)
      }
      this.busy = false
      const state = await this.refresh()
      if (requested === 'restore' && state.status === 'inactive') return this.set({ message: '已验证恢复到激活前状态。请重新启动 Cursor。', progress: 100 })
      return state
    } catch (error) {
      let message = errorText(error)
      if (transaction && requested !== 'restore' && transaction.manifest.state === 'applying') {
        try {
          this.progress('激活失败，正在回滚原始文件', 15)
          await transaction.restore(this.progress)
          message += '\n所有已写入内容均已回滚并验证。'
        } catch (rollback) {
          message += `\n自动回滚未完成：${errorText(rollback)}。备份已保留，请点击取消继续恢复。`
          transaction.manifest.lastError = message
          await transaction.save().catch(() => {})
        }
      } else if (transaction && requested === 'restore') {
        transaction.manifest.lastError = message
        await transaction.save().catch(() => {})
      }
      this.busy = false
      await this.refresh()
      return this.set({ title: requested === 'restore' ? '恢复尚未完成' : '操作未完成', message })
    } finally {
      this.busy = false
      await release?.()
    }
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
