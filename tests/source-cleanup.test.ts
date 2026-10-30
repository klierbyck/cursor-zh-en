import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

it('keeps project docs and first-party code free of unrelated reference links', async () => {
  const paths: string[] = []
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'release', 'release-clean', 'out', '.git', 'coverage'].includes(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (/\.(?:md|html|json|[cm]?[jt]s|ya?ml|sh|bat|py)$/i.test(entry.name) && entry.name !== 'package-lock.json') paths.push(path)
    }
  }
  await collect(process.cwd())
  const found: string[] = []
  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    for (const value of text.matchAll(/https?:\/\/[^\s"'<>`\\)]+/g)) found.push(`${path.slice(process.cwd().length + 1)} ${value[0]}`)
    if (path.endsWith('README.md')) expect(text).not.toMatch(/https?:\/\//)
  }
  if (process.env.CURSORZH_AUDIT_LINKS) process.stdout.write('FUNCTIONAL_URL_AUDIT ' + JSON.stringify(found) + '\n')
  const functionalHosts = new Set(['localhost', '127.0.0.1', 'cursor.com', 'translate.googleapis.com', 'marketplace.visualstudio.com', 'cursorzh.test'])
  // The updater opens this project's own Release page; do not permit arbitrary GitHub links.
  const ownRelease = /^src[\\/]main[\\/]index\.ts https:\/\/github\.com\/\$\{updateConfig\.githubOwner\}\/\$\{updateConfig\.githubRepo\}\/releases\/latest$/
  const ownManifest = /^src[\\/]main[\\/]core[\\/]updates\.ts https:\/\/github\.com\/\$\{config\.githubOwner\}\/\$\{config\.githubRepo\}\/releases\/latest\/download\/latest\.yml$/
  const manifestTest = /^tests[\\/]updates\.test\.ts https:\/\/github\.com\/klierbyck\/cursor-zh-en\/releases\/latest\/download\/latest\.yml$/
  expect(found.filter(entry => !functionalHosts.has(entry.match(/https?:\/\/([^/:]+)/)?.[1] || '') && ![ownRelease, ownManifest, manifestTest].some(pattern => pattern.test(entry)))).toEqual([])
  const removedDirectory = ['up', 'stream'].join('')
  expect(paths.some(path => path.toLowerCase().includes(removedDirectory))).toBe(false)
  await expect(access(join(process.cwd(), 'resources', removedDirectory))).rejects.toThrow()
  await expect(access(join(process.cwd(), 'resources', `${removedDirectory}-lock.json`))).rejects.toThrow()
})
