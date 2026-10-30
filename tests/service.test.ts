import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalizationService } from '../src/main/core/service'
import * as discovery from '../src/main/core/discovery'
import { buildPlan } from '../src/main/patches/plan'
import { Transaction } from '../src/main/core/transaction'
import { fixture } from './fixture'

it('keeps refresh retryable after a resource or discovery error', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cursorzh-refresh-'))
  try {
    const data = join(base, 'data')
    await mkdir(data)
    const service = new LocalizationService({ dataRoot: data, resourcesRoot: join(base, 'missing-resources'), chooseInstallation: async () => undefined, emit: vi.fn() })
    const first = await service.rescan()
    expect(first.status).toBe('error')
    expect(first.title).toBe('刷新未完成')
    expect(service.isBusy).toBe(false)
    const second = await service.rescan()
    expect(second.status).toBe('error')
    expect(service.isBusy).toBe(false)
  } finally { await rm(base, { recursive: true, force: true }) }
})

it.each([false, true])('detects old translation resources without overwriting active injection: outdated=%s', async outdated => {
  const f = await fixture()
  const inspect = vi.spyOn(discovery, 'inspectInstallation').mockResolvedValue(f.installation)
  try {
    const resources = outdated ? { ...f.resources, runtime: '/* previous translation runtime */' } : f.resources
    const plan = await buildPlan(f.installation, f.data, resources, () => {}, f.source)
    const transaction = await Transaction.create(f.store, f.installation, f.data, plan.patches)
    await transaction.apply()
    await writeFile(join(f.data, 'selection.json'), JSON.stringify({ root: f.root }))
    const before = await readFile(join(f.appRoot, discovery.SCRIPT))
    const service = new LocalizationService({ dataRoot: f.data, resourcesRoot: join(process.cwd(), 'resources'), chooseInstallation: async () => undefined, emit: vi.fn() })
    const state = await service.initialize()
    expect(state.status).toBe('active')
    expect(state.action).toBe('restore')
    expect(state.message.includes('新版翻译资源')).toBe(outdated)
    expect(await readFile(join(f.appRoot, discovery.SCRIPT))).toEqual(before)
  } finally { inspect.mockRestore(); await rm(f.base, { recursive: true, force: true }) }
})
