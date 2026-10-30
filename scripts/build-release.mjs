import { readFile } from 'node:fs/promises'
import { build, Platform, Arch } from 'electron-builder'

const settings = JSON.parse(await readFile(new URL('../resources/updates.json', import.meta.url), 'utf8'))
const owner = settings.githubOwner
const repo = settings.githubRepo
if (Boolean(owner) !== Boolean(repo) || (owner && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) || (repo && !/^[A-Za-z0-9._-]+$/.test(repo))) throw new Error('updates.json 的 GitHub 仓库配置无效')
const mac = process.argv.includes('--mac')
const arch = process.argv.includes('--arm64') ? Arch.arm64 : Arch.x64
const macArchitectures = process.argv.includes('--both') ? [Arch.x64, Arch.arm64] : [arch]
if (process.argv.includes('--both') && !mac) throw new Error('--both 只适用于 macOS 构建')
const targets = mac ? Platform.MAC.createTarget(['dmg', 'zip'], ...macArchitectures) : Platform.WINDOWS.createTarget(['nsis'], Arch.x64)
if (!owner) console.warn('未配置自己的 GitHub 更新仓库：本次生成本地测试包，不启用远程更新。')
await build({
  targets,
  publish: 'never',
  config: {
    extends: 'electron-builder.yml',
    directories: { output: process.env.CURSORZH_OUTPUT || 'release' },
    publish: owner ? [{ provider: 'github', owner, repo, releaseType: 'release' }] : null,
    ...(mac ? { mac: { identity: null, notarize: false } } : {})
  }
})
