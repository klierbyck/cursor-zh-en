import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'

it('generates one manifest for exactly the Windows and two macOS installers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cursorzh-release-'))
  const names = ['CursorZh-1.0.5-win-x64.exe', 'CursorZh-1.0.5-mac-x64.dmg', 'CursorZh-1.0.5-mac-arm64.dmg']
  try {
    for (const name of names) await writeFile(join(directory, name), name)
    execFileSync(process.execPath, ['scripts/create-release-manifest.mjs', '1.0.5', directory])
    const manifest = parse(await readFile(join(directory, 'latest.yml'), 'utf8'))
    expect(manifest.version).toBe('1.0.5')
    expect(manifest.files.map((file: { url: string }) => file.url)).toEqual(names)
    for (const file of manifest.files) {
      expect(file.sha512).toBe(createHash('sha512').update(file.url).digest('base64'))
      expect(file.size).toBe(Buffer.byteLength(file.url))
    }
    await writeFile(join(directory, 'CursorZh-1.0.5-mac-universal.dmg'), 'unexpected installer')
    expect(() => execFileSync(process.execPath, ['scripts/create-release-manifest.mjs', '1.0.5', directory], { stdio: 'ignore' })).toThrow()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
