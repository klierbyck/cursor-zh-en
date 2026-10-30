import { EventEmitter } from 'node:events'
import type { AppUpdater } from 'electron-updater'
import { UpdateController, updateConfigSchema } from '../src/main/core/updates'

function setup(options: { configured?: boolean; packaged?: boolean; manualInstall?: boolean } = {}) {
  const adapter = new EventEmitter() as EventEmitter & Record<string, any>
  adapter.setFeedURL = vi.fn()
  adapter.checkForUpdates = vi.fn(async () => { adapter.emit('update-not-available', { version: '0.3.0' }); return {} })
  adapter.quitAndInstall = vi.fn()
  let busy = false
  const confirm = vi.fn(async () => true)
  const beforeInstall = vi.fn()
  const openRelease = vi.fn(async () => {})
  const controller = new UpdateController({
    version: '0.3.0', packaged: options.packaged ?? true,
    config: { githubOwner: options.configured === false ? '' : 'my-account', githubRepo: options.configured === false ? '' : 'my-app', checkOnStartup: true },
    updater: adapter as unknown as AppUpdater, emit: vi.fn(),
    isBusy: () => busy, confirmInstall: confirm, beforeInstall, manualInstall: options.manualInstall, openRelease
  })
  return { controller, adapter, confirm, beforeInstall, openRelease, setBusy: (value: boolean) => { busy = value } }
}
describe('self-owned GitHub updates', () => {
  it('never uses a fallback repository or network request when not configured', async () => {
    const { controller, adapter } = setup({ configured: false })
    expect((await controller.check()).status).toBe('unconfigured')
    expect(adapter.setFeedURL).not.toHaveBeenCalled()
    expect(adapter.checkForUpdates).not.toHaveBeenCalled()
  })
  it('keeps development mode free of update installation', async () => {
    const { controller, adapter } = setup({ packaged: false })
    expect((await controller.check()).status).toBe('development')
    expect(adapter.checkForUpdates).not.toHaveBeenCalled()
  })
  it('uses only configured public GitHub releases and downloads without downgrade or silent quit installs', async () => {
    const { controller, adapter } = setup()
    expect(adapter.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'my-account', repo: 'my-app', private: false })
    expect(adapter.autoDownload).toBe(true)
    expect(adapter.autoInstallOnAppQuit).toBe(false)
    expect(adapter.allowDowngrade).toBe(false)
    expect(adapter.allowPrerelease).toBe(false)
    expect(adapter.disableWebInstaller).toBe(true)
    await controller.check()
    expect(controller.state.status).toBe('current')
    adapter.emit('update-available', { version: '0.4.0' })
    expect(controller.state.status).toBe('downloading')
    adapter.emit('download-progress', { percent: 42.5 })
    expect(controller.state.progress).toBe(42.5)
    adapter.emit('update-downloaded', { version: '0.4.0' })
    expect(controller.state.canInstall).toBe(true)
    expect(adapter.quitAndInstall).not.toHaveBeenCalled()
  })
  it('checks macOS releases without trying to install an unsigned app in place', async () => {
    const f = setup({ manualInstall: true })
    expect(f.adapter.autoDownload).toBe(false)
    f.adapter.emit('update-available', { version: '0.4.0' })
    expect(f.controller.state.status).toBe('available')
    expect(f.controller.state.canInstall).toBe(true)
    f.setBusy(true)
    await f.controller.install()
    expect(f.openRelease).not.toHaveBeenCalled()
    f.setBusy(false)
    await f.controller.install()
    expect(f.openRelease).toHaveBeenCalledOnce()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.adapter.quitAndInstall).not.toHaveBeenCalled()
  })
  it('requires confirmation and prevents updates during localization writes', async () => {
    const f = setup()
    f.adapter.emit('update-downloaded', { version: '0.4.0' })
    f.setBusy(true)
    await f.controller.install()
    expect(f.adapter.quitAndInstall).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    f.setBusy(false)
    f.confirm.mockResolvedValueOnce(false)
    await f.controller.install()
    expect(f.adapter.quitAndInstall).not.toHaveBeenCalled()
    await f.controller.install()
    expect(f.beforeInstall).toHaveBeenCalledOnce()
    expect(f.adapter.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
  it('rechecks the transaction lock after the confirmation dialog', async () => {
    const f = setup()
    f.adapter.emit('update-downloaded', { version: '0.4.0' })
    f.confirm.mockImplementationOnce(async () => { f.setBusy(true); return true })
    await f.controller.install()
    expect(f.adapter.quitAndInstall).not.toHaveBeenCalled()
  })
  it('sanitizes failures without exposing raw endpoints or diagnostics', async () => {
    const { controller, adapter } = setup()
    adapter.checkForUpdates.mockRejectedValueOnce(new Error('network request failed'))
    expect((await controller.check()).status).toBe('error')
    expect(controller.state.canCheck).toBe(true)
    expect(controller.state.message).not.toContain('http')
  })
  it('rejects malformed repository settings', () => {
    expect(() => updateConfigSchema.parse({ githubOwner: 'owner', githubRepo: '', checkOnStartup: true })).toThrow()
    expect(() => updateConfigSchema.parse({ githubOwner: 'owner/path', githubRepo: 'app' })).toThrow()
    expect(() => updateConfigSchema.parse({ githubOwner: 'owner', githubRepo: '../app' })).toThrow()
  })
})
