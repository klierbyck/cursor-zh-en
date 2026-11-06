import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, upgrade } from './fixture'
import { buildPlan } from '../src/main/patches/plan'
import { Transaction } from '../src/main/core/transaction'
import { SCRIPT, WORKBENCH } from '../src/main/core/discovery'
import { captureWindowsAcls, writeWindowsAcl } from '../src/main/platform/windows-metadata'
import { installationLock } from '../src/main/platform/system'

describe('platform safeguards', () => {
  it.runIf(process.platform === 'win32')('parses the restricted privilege worker without invoking elevation', async () => {
    const source = await readFile(join(process.cwd(), 'resources/elevated-windows.ps1'), 'utf8')
    const command = '$tokens=$null; $errors=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors); if($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }'
    expect(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { input: source, windowsHide: true, timeout: 10000 })).not.toThrow()
  })

  it.runIf(process.platform === 'win32').each(['restore', 'concurrent', 'corrupt'])('validates the prepared cross-version restore in the Windows worker: %s', async scenario => {
    const f = await fixture()
    try {
      const plan = await buildPlan(f.installation, f.data, f.resources, () => {}, f.source)
      const transaction = await Transaction.create(f.store, f.installation, f.data, plan.patches)
      await transaction.apply()
      const next = await upgrade(f, { injected: true, tray: true, script: true })
      const restored = await Transaction.load(transaction.directory, next.installation, f.data, {
        write: async () => { throw new Error('stop before commit') },
        remove: async () => { throw new Error('stop before commit') }
      })
      await expect(restored.restore()).rejects.toThrow('stop before commit')
      if (scenario === 'concurrent') await writeFile(join(f.appRoot, WORKBENCH), 'concurrent external content')
      if (scenario === 'corrupt') {
        const entry = restored.manifest.entries.find(entry => entry.path === 'out/main.js')!
        await writeFile(join(restored.directory, entry.restoreBlob!), 'corrupt restore blob')
      }
      const before = await readFile(join(f.appRoot, WORKBENCH))
      const source = await readFile(join(process.cwd(), 'resources/elevated-windows.ps1'), 'utf8')
      // The fixture executable is unsigned. Stub only publisher inspection; run the
      // actual path, state, hash, staging and commit checks without requesting UAC.
      const command = `function Get-AuthenticodeSignature { param([string]$LiteralPath) [pscustomobject]@{Status='Valid'; SignerCertificate=[pscustomobject]@{Subject='CN=Anysphere'}} }; $helper=[scriptblock]::Create([Console]::In.ReadToEnd()); & $helper -Manifest '${join(restored.directory, 'manifest.json').replace(/'/g, "''")}' -Action restore`
      const run = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { input: source, windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] })
      if (scenario === 'restore') {
        expect(run).not.toThrow()
        expect(await readFile(join(f.appRoot, WORKBENCH), 'utf8')).toBe(next.html)
        expect(await readFile(join(f.appRoot, 'out/main.js'), 'utf8')).toBe(next.main)
        expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(next.product)
        await expect(readFile(join(f.appRoot, SCRIPT))).rejects.toMatchObject({ code: 'ENOENT' })
        const resumed = await Transaction.load(restored.directory, next.installation, f.data)
        await resumed.restore()
        expect(resumed.manifest.state).toBe('restored')
      } else {
        expect(run).toThrow()
        expect(await readFile(join(f.appRoot, WORKBENCH))).toEqual(before)
        expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(next.product)
      }
    } finally { await rm(f.base, { recursive: true, force: true }) }
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
