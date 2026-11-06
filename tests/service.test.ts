import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { LocalizationService } from '../src/main/core/service'
import * as discovery from '../src/main/core/discovery'
import { buildPlan } from '../src/main/patches/plan'
import * as plans from '../src/main/patches/plan'
import { Transaction } from '../src/main/core/transaction'
import { fixture, upgrade } from './fixture'
import * as platform from '../src/main/platform/system'
import * as windowsMetadata from '../src/main/platform/windows-metadata'
import { atomicWrite } from '../src/main/core/files'
import { runLocalizationCommand } from '../src/main/core/cli'

// These service tests use isolated files and must never query or control live processes.
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFile: vi.fn(() => { throw new Error('Unexpected external process command') }) }
})

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

it('allows GUI and CLI restoration after an upgrade without replacing the newer build', async () => {
  const f = await fixture()
  try {
    const plan = await buildPlan(f.installation, f.data, f.resources, () => {}, f.source)
    const transaction = await Transaction.create(f.store, f.installation, f.data, plan.patches)
    await transaction.apply()
    const next = await upgrade(f, { injected: true, tray: true, script: true })
    vi.spyOn(discovery, 'inspectInstallation').mockResolvedValue(next.installation)
    vi.spyOn(platform, 'privilegedIo').mockReturnValue({ write: atomicWrite, remove: path => rm(path, { force: true }) })
    const service = new LocalizationService({ dataRoot: f.data, resourcesRoot: join(process.cwd(), 'resources'), initialInstallation: f.root, chooseInstallation: async () => undefined, emit: vi.fn() })
    const state = await service.initialize()
    expect(state.status).toBe('recovery')
    expect(state.title).toContain('已更新')
    expect(state.action).toBe('restore')
    expect(state.canToggle).toBe(true)
    await expect(runLocalizationCommand({ action: 'restore' }, service)).resolves.toContain('当前 Cursor 版本')
    expect(service.state.completedAction).toBe('restore')
    expect(service.state.status).toBe('inactive')
    expect(service.state.action).toBe('activate')
    expect(service.state.canToggle).toBe(true)
    expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(next.product)
  } finally { vi.restoreAllMocks(); await rm(f.base, { recursive: true, force: true }) }
})

it('keeps restoration available for a trusted Mac backup without enabling new Mac activation', async () => {
  const f = await fixture('darwin')
  try {
    const resources = { ...f.resources, compatibility: { ...f.resources.compatibility, macActivationVerified: true } }
    const plan = await buildPlan(f.installation, f.data, resources, () => {}, f.source)
    const transaction = await Transaction.create(f.store, f.installation, f.data, plan.patches)
    await transaction.apply()
    vi.spyOn(discovery, 'inspectInstallation').mockResolvedValue(f.installation)
    vi.spyOn(platform, 'privilegedIo').mockReturnValue({ write: atomicWrite, remove: path => rm(path, { force: true }) })
    const service = new LocalizationService({ dataRoot: f.data, resourcesRoot: join(process.cwd(), 'resources'), initialInstallation: f.root, chooseInstallation: async () => undefined, emit: vi.fn() })
    await expect(runLocalizationCommand({ action: 'restore' }, service)).resolves.toContain('已撤销并验证')
    expect(service.state.status).toBe('unsupported')
    expect(service.state.canToggle).toBe(false)
    expect(service.state.completedAction).toBe('restore')
    expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(f.originalProduct)
  } finally { vi.restoreAllMocks(); await rm(f.base, { recursive: true, force: true }) }
})

it('activates and restores with restart notices without inspecting or controlling Cursor processes', async () => {
  const f = await fixture()
  try {
    const plan = await buildPlan(f.installation, f.data, f.resources, () => {}, f.source)
    vi.spyOn(plans, 'buildPlan').mockResolvedValue(plan)
    vi.spyOn(discovery, 'inspectInstallation').mockResolvedValue(f.installation)
    vi.spyOn(windowsMetadata, 'captureWindowsAcls').mockResolvedValue({})
    vi.mocked(execFile).mockClear()
    const service = new LocalizationService({ dataRoot: f.data, resourcesRoot: join(process.cwd(), 'resources'), initialInstallation: f.root, chooseInstallation: async () => undefined, emit: vi.fn() })
    const before = await readFile(join(f.appRoot, discovery.WORKBENCH))
    await service.initialize()
    const active = await service.toggle()
    expect(active.status).toBe('active')
    expect(active.completedAction).toBe('activate')
    expect(active.message).toContain('重新启动 Cursor 后生效')
    expect(await readFile(join(f.appRoot, discovery.WORKBENCH))).not.toEqual(before)
    expect(active.backup).toBeTruthy()
    const restored = await service.toggle()
    expect(restored.status).toBe('inactive')
    expect(restored.completedAction).toBe('restore')
    expect(restored.message).toContain('重新启动 Cursor 后生效')
    expect(await readFile(join(f.appRoot, discovery.WORKBENCH))).toEqual(before)
    expect(await readFile(join(f.appRoot, 'product.json'))).toEqual(f.originalProduct)
    await expect(readFile(join(f.appRoot, discovery.SCRIPT))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(execFile).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks(); await rm(f.base, { recursive: true, force: true }) }
})
