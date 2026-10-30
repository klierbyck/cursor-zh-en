import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AppUpdater } from 'electron-updater'
import type { UpdateState } from '../../shared/types'

export const updateConfigSchema = z.object({
  githubOwner: z.string().regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))?$/),
  githubRepo: z.string().regex(/^[A-Za-z0-9._-]*$/),
  checkOnStartup: z.boolean().default(true)
}).refine(value => Boolean(value.githubOwner) === Boolean(value.githubRepo), '更新仓库的 owner 和 repo 必须同时填写')
export type UpdateConfig = z.infer<typeof updateConfigSchema>
export async function readUpdateConfig(resourcesRoot: string): Promise<UpdateConfig> {
  return updateConfigSchema.parse(JSON.parse(await readFile(join(resourcesRoot, 'updates.json'), 'utf8')))
}
type Adapter = Pick<AppUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease' | 'allowDowngrade' | 'disableWebInstaller' | 'logger' | 'setFeedURL' | 'checkForUpdates' | 'quitAndInstall' | 'on'>
export interface UpdateOptions {
  version: string
  packaged: boolean
  config: UpdateConfig
  updater: Adapter
  emit(state: UpdateState): void
  isBusy(): boolean
  confirmInstall(): Promise<boolean>
  beforeInstall(): void
  // Unsigned macOS apps cannot use Electron's in-place updater.
  manualInstall?: boolean
  openRelease?(): Promise<void>
}

export class UpdateController {
  private value: UpdateState
  private checking = false
  private installing = false
  constructor(private options: UpdateOptions) {
    const configured = Boolean(options.config.githubOwner && options.config.githubRepo)
    this.value = {
      status: !configured ? 'unconfigured' : !options.packaged ? 'development' : 'idle',
      currentVersion: options.version, progress: 0, canCheck: true, canInstall: false,
      message: !configured ? '发布前请配置自己的 GitHub 更新仓库。' : !options.packaged ? '开发模式不下载或安装更新，请在已安装的应用中检查。' : '可以检查助手的新版本。'
    }
    const updater = options.updater
    updater.autoDownload = !options.manualInstall
    updater.autoInstallOnAppQuit = false // Never replace the helper during a localization transaction.
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.disableWebInstaller = true
    updater.logger = null
    if (configured) updater.setFeedURL({ provider: 'github', owner: options.config.githubOwner, repo: options.config.githubRepo, private: false })
    updater.on('checking-for-update', () => this.set({ status: 'checking', canCheck: false, message: '正在检查更新…' }))
    updater.on('update-not-available', () => this.set({ status: 'current', nextVersion: undefined, progress: 0, canCheck: true, canInstall: false, message: '当前已是最新版本。' }))
    updater.on('update-available', info => this.set(options.manualInstall
      ? { status: 'available', nextVersion: info.version, progress: 0, canCheck: false, canInstall: true, message: `发现 v${info.version}。当前 macOS 安装包未签名，请前往 GitHub Release 手动下载安装。` }
      : { status: 'downloading', nextVersion: info.version, progress: 0, canCheck: false, canInstall: false, message: `发现 v${info.version}，正在自动下载…` }))
    updater.on('download-progress', progress => this.set({ status: 'downloading', progress: Math.max(0, Math.min(100, progress.percent)), canCheck: false, message: `正在下载更新 ${Math.round(progress.percent)}%` }))
    updater.on('update-downloaded', info => this.set({ status: 'ready', nextVersion: info.version, progress: 100, canCheck: false, canInstall: true, message: `v${info.version} 已下载，点击“重启并更新”安装。` }))
    updater.on('error', () => this.set({ status: 'error', canCheck: true, canInstall: false, message: '检查或下载失败，请确认网络及 GitHub Release 的更新文件后重试。' }))
  }
  get state(): UpdateState { return structuredClone(this.value) }
  get isInstalling(): boolean { return this.installing }
  private set(patch: Partial<UpdateState>): UpdateState {
    this.value = { ...this.value, ...patch }
    this.options.emit(this.state)
    return this.state
  }
  async check(): Promise<UpdateState> {
    if (this.checking || this.installing || this.value.status === 'downloading' || this.value.status === 'ready' || this.value.status === 'available') return this.state
    if (this.value.status === 'unconfigured' || this.value.status === 'development') return this.set({ message: this.value.message })
    if (this.options.isBusy()) return this.set({ message: '正在处理汉化，请完成后再检查更新。' })
    this.checking = true
    this.set({ status: 'checking', canCheck: false, message: '正在检查更新…' })
    try {
      const result = await this.options.updater.checkForUpdates()
      if (!result && this.value.status === 'checking') this.set({ status: 'error', canCheck: true, message: '此安装暂不支持更新检查。' })
    } catch {
      this.set({ status: 'error', canCheck: true, canInstall: false, message: '检查更新失败，请确认网络和发布配置后重试。' })
    } finally { this.checking = false }
    return this.state
  }
  async install(): Promise<UpdateState> {
    if (!this.value.canInstall || this.installing) return this.state
    if (this.options.isBusy()) return this.set({ message: '请等待汉化操作完成，再安装更新。' })
    if (this.options.manualInstall) {
      try {
        if (!this.options.openRelease) throw new Error('未配置下载地址')
        await this.options.openRelease()
      } catch {
        return this.set({ message: '无法打开 GitHub Release，请检查网络或稍后重试。' })
      }
      return this.state
    }
    if (!await this.options.confirmInstall()) return this.state
    if (this.options.isBusy()) return this.set({ message: '汉化操作尚未完成，本次未安装更新。' })
    this.installing = true
    this.set({ canInstall: false, canCheck: false, message: '正在重启并安装更新…' })
    try {
      this.options.beforeInstall()
      this.options.updater.quitAndInstall(false, true)
    } catch {
      this.installing = false
      this.set({ canInstall: true, message: '无法启动更新安装，请稍后重试。' })
    }
    return this.state
  }
}
