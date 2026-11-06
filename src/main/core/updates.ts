import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
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

const versionPattern = /^\d+\.\d+\.\d+$/
const manifestSchema = z.object({
  version: z.string().regex(versionPattern),
  files: z.array(z.object({
    platform: z.enum(['win32', 'darwin']),
    arch: z.enum(['x64', 'arm64']),
    url: z.string(),
    sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    size: z.number().int().positive()
  })).length(3)
})

export async function fetchLatestVersion(config: UpdateConfig, request: typeof fetch = fetch): Promise<string> {
  if (!config.githubOwner || !config.githubRepo) throw new Error('未配置更新仓库')
  const response = await request(`https://github.com/${config.githubOwner}/${config.githubRepo}/releases/latest/download/latest.yml`, {
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new Error('无法获取发布清单')
  const text = await response.text()
  if (text.length > 32768) throw new Error('发布清单过大')
  const manifest = manifestSchema.parse(parseYaml(text))
  const expected = [
    `win32:x64:CursorZh-${manifest.version}-win-x64.exe`,
    `darwin:x64:CursorZh-${manifest.version}-mac-x64.dmg`,
    `darwin:arm64:CursorZh-${manifest.version}-mac-arm64.dmg`
  ]
  if (manifest.files.map(file => `${file.platform}:${file.arch}:${file.url}`).sort().join('\n') !== expected.sort().join('\n')) {
    throw new Error('发布清单缺少安装包')
  }
  return manifest.version
}

export function isNewerVersion(latest: string, current: string): boolean {
  if (!versionPattern.test(latest) || !versionPattern.test(current)) throw new Error('版本号格式无效')
  const next = latest.split('.').map(BigInt)
  const installed = current.split('.').map(BigInt)
  for (let index = 0; index < 3; index++) {
    if (next[index]! > installed[index]!) return true
    if (next[index]! < installed[index]!) return false
  }
  return false
}

export interface UpdateOptions {
  version: string
  packaged: boolean
  config: UpdateConfig
  emit(state: UpdateState): void
  isBusy(): boolean
  getLatestVersion(): Promise<string>
  openRelease(): Promise<void>
}

export class UpdateController {
  private value: UpdateState
  private checking = false
  constructor(private options: UpdateOptions) {
    const configured = Boolean(options.config.githubOwner && options.config.githubRepo)
    this.value = {
      status: !configured ? 'unconfigured' : !options.packaged ? 'development' : 'idle',
      currentVersion: options.version, canCheck: true, canOpenRelease: false,
      message: !configured ? '发布前请配置自己的 GitHub 更新仓库。' : !options.packaged ? '开发模式不检查更新，请在已安装的应用中检查。' : '可以检查助手的新版本。'
    }
  }
  get state(): UpdateState { return structuredClone(this.value) }
  private set(patch: Partial<UpdateState>): UpdateState {
    this.value = { ...this.value, ...patch }
    this.options.emit(this.state)
    return this.state
  }
  async check(): Promise<UpdateState> {
    if (this.checking || this.value.status === 'available') return this.state
    if (this.value.status === 'unconfigured' || this.value.status === 'development') return this.set({ message: this.value.message })
    if (this.options.isBusy()) return this.set({ message: '正在处理汉化，请完成后再检查更新。' })
    this.checking = true
    this.set({ status: 'checking', canCheck: false, canOpenRelease: false, message: '正在检查更新…' })
    try {
      const version = await this.options.getLatestVersion()
      if (isNewerVersion(version, this.options.version)) {
        this.set({ status: 'available', nextVersion: version, canCheck: false, canOpenRelease: true, message: `发现 v${version}，请前往 GitHub Release 下载安装。` })
      } else {
        this.set({ status: 'current', nextVersion: undefined, canCheck: true, canOpenRelease: false, message: '当前已是最新版本。' })
      }
    } catch {
      this.set({ status: 'error', nextVersion: undefined, canCheck: true, canOpenRelease: false, message: '检查更新失败，请确认网络和 GitHub Release 后重试。' })
    } finally { this.checking = false }
    return this.state
  }
  async open(): Promise<UpdateState> {
    if (!this.value.canOpenRelease) return this.state
    if (this.options.isBusy()) return this.set({ message: '请等待汉化操作完成，再下载更新。' })
    try { await this.options.openRelease() } catch {
      return this.set({ message: '无法打开 GitHub Release，请检查网络或稍后重试。' })
    }
    return this.state
  }
}
