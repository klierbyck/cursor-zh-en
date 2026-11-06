import { build, Platform, Arch } from 'electron-builder'
const mac = process.argv.includes('--mac')
const arch = process.argv.includes('--arm64') ? Arch.arm64 : Arch.x64
const macArchitectures = process.argv.includes('--both') ? [Arch.x64, Arch.arm64] : [arch]
if (process.argv.includes('--both') && !mac) throw new Error('--both 只适用于 macOS 构建')
const targets = mac ? Platform.MAC.createTarget(['dmg'], ...macArchitectures) : Platform.WINDOWS.createTarget(['nsis'], Arch.x64)
await build({
  targets,
  publish: 'never',
  config: {
    extends: 'electron-builder.yml',
    directories: { output: process.env.CURSORZH_OUTPUT || 'release' },
    publish: null,
    ...(mac ? { mac: { identity: null, notarize: false } } : {})
  }
})
