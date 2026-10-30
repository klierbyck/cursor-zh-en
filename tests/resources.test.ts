import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadResources } from '../src/main/core/resources'
import { loadResources as legacyLoadResources } from '../src/main/patches/plan'

it('preserves the resource-loading API at the original import path', () => {
  expect(legacyLoadResources).toBe(loadResources)
})

it('preserves the injected runtime bytes, merge priority and metadata after extracting resource loading', async () => {
  const root = join(process.cwd(), 'resources')
  const folder = join(root, 'localization')
  const [catalogText, supplementText, integrityText, template, privateText, compatibilityText] = await Promise.all([
    readFile(join(folder, 'catalog.json'), 'utf8'),
    readFile(join(folder, 'dictionary.json'), 'utf8'),
    readFile(join(folder, 'coverage.json'), 'utf8'),
    readFile(join(folder, 'runtime.js'), 'utf8'),
    readFile(join(folder, 'private-extensions.json'), 'utf8'),
    readFile(join(root, 'compatibility.json'), 'utf8')
  ])
  const catalog = JSON.parse(catalogText)
  const supplement = JSON.parse(supplementText)
  const integrity = JSON.parse(integrityText)
  // Keep the established serialization order: a module move must not make an
  // already active installation appear to need a different injected runtime.
  const entries = { ...catalog.entries, ...supplement.entries }
  const config = {
    ...catalog,
    entries,
    patterns: [...catalog.patterns, ...(supplement.patterns || [])],
    fragments: [...catalog.fragments, ...(supplement.fragments || [])],
    coverage: { ...integrity.counts, effectiveEntries: Object.keys(entries).length }
  }
  const expectedRuntime = template.replace('__CURSOR_ZH_RESOURCES__', () => JSON.stringify(config).replace(/</g, '\\u003c'))
  const actual = await loadResources(root)
  expect(Buffer.from(actual.runtime)).toEqual(Buffer.from(expectedRuntime))
  expect(actual.coverage).toEqual(config.coverage)
  expect(actual.dictionary).toEqual({ source: 'built-in', entries, privateExtensions: JSON.parse(privateText) })
  expect(actual.compatibility).toEqual(JSON.parse(compatibilityText))
})
