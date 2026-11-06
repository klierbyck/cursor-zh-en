import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

it('keeps project docs and first-party code free of unrelated reference links', async () => {
  const readmeReferences = [
    /^README\.md https:\/\/github\.com\/klierbyck\/cursor-zh-en\/releases(?:\/latest)?$/,
    /^README\.md https:\/\/img\.shields\.io\/github\/(?:v\/release\/klierbyck\/cursor-zh-en|downloads\/klierbyck\/cursor-zh-en\/total|license\/klierbyck\/cursor-zh-en)\?label=(?:%[0-9A-Fa-f]{2})+$/,
    /^README\.md https:\/\/img\.shields\.io\/badge\/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-yellow$/,
    /^README\.md https:\/\/img\.shields\.io\/badge\/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20macOS%20%E6%B5%8B%E8%AF%95%E5%8C%85-blue$/
  ]
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
    for (const value of text.matchAll(/https?:\/\/[^\s"'<>`\\)]+/g)) {
      const reference = `${path.slice(process.cwd().length + 1)} ${value[0]}`
      found.push(reference)
      if (path.endsWith('README.md')) expect(readmeReferences.some(pattern => pattern.test(reference)), reference).toBe(true)
    }
  }
  if (process.env.CURSORZH_AUDIT_LINKS) process.stdout.write('FUNCTIONAL_URL_AUDIT ' + JSON.stringify(found) + '\n')
  const functionalHosts = new Set(['localhost', '127.0.0.1', 'cursor.com', 'translate.googleapis.com', 'marketplace.visualstudio.com', 'cursorzh.test'])
  // The updater opens this project's own Release page; do not permit arbitrary GitHub links.
  const ownRelease = /^src[\\/]main[\\/]index\.ts https:\/\/github\.com\/\$\{updateConfig\.githubOwner\}\/\$\{updateConfig\.githubRepo\}\/releases\/latest$/
  const ownManifest = /^src[\\/]main[\\/]core[\\/]updates\.ts https:\/\/github\.com\/\$\{config\.githubOwner\}\/\$\{config\.githubRepo\}\/releases\/latest\/download\/latest\.yml$/
  const manifestTest = /^tests[\\/]updates\.test\.ts https:\/\/github\.com\/klierbyck\/cursor-zh-en\/releases\/latest\/download\/latest\.yml$/
  expect(found.filter(entry => !functionalHosts.has(entry.match(/https?:\/\/([^/:]+)/)?.[1] || '') && ![ownRelease, ownManifest, manifestTest, ...readmeReferences].some(pattern => pattern.test(entry)))).toEqual([])
  const removedDirectory = ['up', 'stream'].join('')
  expect(paths.some(path => path.toLowerCase().includes(removedDirectory))).toBe(false)
  await expect(access(join(process.cwd(), 'resources', removedDirectory))).rejects.toThrow()
  await expect(access(join(process.cwd(), 'resources', `${removedDirectory}-lock.json`))).rejects.toThrow()
})
