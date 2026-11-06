import { fetchLatestVersion, isNewerVersion, UpdateController, updateConfigSchema } from '../src/main/core/updates'

const config = { githubOwner: 'klierbyck', githubRepo: 'cursor-zh-en', checkOnStartup: true }
const manifest = (version = '1.0.4') => `version: ${version}
files:
  - platform: win32
    arch: x64
    url: CursorZh-${version}-win-x64.exe
    sha512: ${Buffer.alloc(64).toString('base64')}
    size: 1
  - platform: darwin
    arch: x64
    url: CursorZh-${version}-mac-x64.dmg
    sha512: ${Buffer.alloc(64).toString('base64')}
    size: 1
  - platform: darwin
    arch: arm64
    url: CursorZh-${version}-mac-arm64.dmg
    sha512: ${Buffer.alloc(64).toString('base64')}
    size: 1
`

function setup(options: { configured?: boolean; packaged?: boolean } = {}) {
  let busy = false
  const getLatestVersion = vi.fn(async () => '1.0.4')
  const openRelease = vi.fn(async () => {})
  const controller = new UpdateController({
    version: '1.0.3', packaged: options.packaged ?? true,
    config: options.configured === false ? { ...config, githubOwner: '', githubRepo: '' } : config,
    emit: vi.fn(), isBusy: () => busy, getLatestVersion, openRelease
  })
  return { controller, getLatestVersion, openRelease, setBusy: (value: boolean) => { busy = value } }
}

describe('single cross-platform release manifest', () => {
  it('rejects malformed repository settings', () => {
    expect(() => updateConfigSchema.parse({ githubOwner: 'owner', githubRepo: '' })).toThrow()
    expect(() => updateConfigSchema.parse({ githubOwner: 'owner/path', githubRepo: 'app' })).toThrow()
    expect(() => updateConfigSchema.parse({ githubOwner: 'owner', githubRepo: '../app' })).toThrow()
  })
  it('checks only the configured public release manifest and verifies all installers', async () => {
    const request = vi.fn(async () => new Response(manifest())) as unknown as typeof fetch
    expect(await fetchLatestVersion(config, request)).toBe('1.0.4')
    expect(request).toHaveBeenCalledWith('https://github.com/klierbyck/cursor-zh-en/releases/latest/download/latest.yml', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const malformed = vi.fn(async () => new Response(manifest().replace('mac-arm64.dmg', 'mac-arm64.zip'))) as unknown as typeof fetch
    await expect(fetchLatestVersion(config, malformed)).rejects.toThrow('发布清单缺少安装包')
    await expect(fetchLatestVersion(config, vi.fn(async () => new Response('missing', { status: 404 })) as unknown as typeof fetch)).rejects.toThrow()
  })
  it('compares semantic numeric versions rather than their strings', () => {
    expect(isNewerVersion('1.0.10', '1.0.9')).toBe(true)
    expect(isNewerVersion('1.0.3', '1.0.4')).toBe(false)
    expect(isNewerVersion('1.0.4', '1.0.4')).toBe(false)
    expect(() => isNewerVersion('bad-version', '1.0.0')).toThrow()
  })
  it('never requests updates when unconfigured or running from source', async () => {
    for (const options of [{ configured: false }, { packaged: false }]) {
      const f = setup(options)
      await f.controller.check()
      expect(f.getLatestVersion).not.toHaveBeenCalled()
      expect(f.openRelease).not.toHaveBeenCalled()
    }
  })
  it('offers a manual release download and blocks checks or downloads during file writes', async () => {
    const f = setup()
    f.setBusy(true)
    await f.controller.check()
    expect(f.getLatestVersion).not.toHaveBeenCalled()
    f.setBusy(false)
    await f.controller.check()
    expect(f.controller.state.status).toBe('available')
    expect(f.controller.state.canOpenRelease).toBe(true)
    f.setBusy(true)
    await f.controller.open()
    expect(f.openRelease).not.toHaveBeenCalled()
    f.setBusy(false)
    await f.controller.open()
    expect(f.openRelease).toHaveBeenCalledOnce()
  })
  it('handles current versions and sanitizes network errors', async () => {
    const f = setup()
    f.getLatestVersion.mockResolvedValueOnce('1.0.3')
    expect((await f.controller.check()).status).toBe('current')
    f.getLatestVersion.mockRejectedValueOnce(new Error('sensitive endpoint token'))
    expect((await f.controller.check()).status).toBe('error')
    expect(f.controller.state.canCheck).toBe(true)
    expect(f.controller.state.message).not.toContain('https:')
  })
})
