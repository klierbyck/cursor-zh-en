import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './fixture'
import { captureWindowsAcls, writeWindowsAcl } from '../src/main/platform/windows-metadata'
import { installationLock } from '../src/main/platform/system'

describe('platform safeguards', () => {
  it.runIf(process.platform === 'win32')('parses the restricted privilege worker without invoking elevation', async () => {
    const source = await readFile(join(process.cwd(), 'resources/elevated-windows.ps1'), 'utf8')
    const command = '$tokens=$null; $errors=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors); if($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }'
    expect(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { input: source, windowsHide: true, timeout: 10000 })).not.toThrow()
  })

  it.runIf(process.platform === 'win32')('captures and verifies a real Windows access-control descriptor', async () => {
    const f = await fixture()
    try {
      const path = join(f.appRoot, 'product.json')
      const before = await captureWindowsAcls([path])
      expect(before[path]).toMatch(/^D:/)
      await writeWindowsAcl(path, before[path])
      expect((await captureWindowsAcls([path]))[path]).toBe(before[path])
    } finally { await rm(f.base, { recursive: true, force: true }) }
  })

  it('prevents concurrent operations with an installation lock', async () => {
    const f = await fixture()
    try {
      const release = await installationLock(f.data, f.installation.identity)
      await expect(installationLock(f.data, f.installation.identity)).rejects.toThrow('另一个汉化进程')
      await release()
      const second = await installationLock(f.data, f.installation.identity)
      await second()
    } finally { await rm(f.base, { recursive: true, force: true }) }
  })

  it('detects a Mac bundle layout without enabling unverified Mac patching', async () => {
    const f = await fixture('darwin')
    try {
      expect(f.installation.appRoot).toContain(join('Contents', 'Resources', 'app'))
      expect(f.installation.platform).toBe('darwin')
      expect(f.resources.compatibility.macActivationVerified).toBe(false)
    } finally { await rm(f.base, { recursive: true, force: true }) }
  })
})
