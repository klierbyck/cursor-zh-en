import { parseLocalizationCommand, runLocalizationCommand } from '../src/main/core/cli'
import type { LocalizationService } from '../src/main/core/service'
import type { ViewState } from '../src/shared/types'

const state = (patch: Partial<ViewState>): ViewState => ({
  status: 'inactive', title: '准备就绪', message: '可以汉化', platform: 'Windows',
  progress: 0, canToggle: true, action: 'activate', warnings: [], ...patch
})
function service(initial: ViewState, result: ViewState) {
  return { initialize: vi.fn(async () => initial), toggle: vi.fn(async () => result) } as unknown as Pick<LocalizationService, 'initialize' | 'toggle'> & { toggle: ReturnType<typeof vi.fn> }
}

it('accepts only an explicit action and optional installation directory', () => {
  expect(parseLocalizationCommand(['activate'])).toEqual({ action: 'activate' })
  expect(parseLocalizationCommand(['restore', '--install-dir', '/Applications/Cursor.app'])).toEqual({ action: 'restore', installDir: '/Applications/Cursor.app' })
  for (const args of [[], ['toggle'], ['activate', '--force'], ['restore', '--install-dir', ''], ['activate', '--install-dir', '/tmp/app', 'extra']]) {
    expect(() => parseLocalizationCommand(args)).toThrow()
  }
})

it('never activates when asked to restore or when compatibility blocks writing', async () => {
  const active = service(state({ status: 'active', action: 'restore' }), state({ status: 'inactive', action: 'activate', message: '已恢复' }))
  await expect(runLocalizationCommand({ action: 'restore' }, active)).resolves.toContain('已恢复')
  expect(active.toggle).toHaveBeenCalledOnce()
  const inactive = service(state({}), state({ status: 'active', action: 'restore' }))
  await expect(runLocalizationCommand({ action: 'restore' }, inactive)).rejects.toThrow('未执行还原')
  expect(inactive.toggle).not.toHaveBeenCalled()
  const unsupported = service(state({ status: 'unsupported', canToggle: false, message: 'macOS 汉化尚未验收' }), state({}))
  await expect(runLocalizationCommand({ action: 'activate' }, unsupported)).rejects.toThrow('macOS 汉化尚未验收')
  expect(unsupported.toggle).not.toHaveBeenCalled()
})

it('rejects ambiguous discovery and reports failed operations without claiming success', async () => {
  const missing = service(state({ status: 'missing', action: 'locate' }), state({}))
  await expect(runLocalizationCommand({ action: 'activate' }, missing)).rejects.toThrow('--install-dir')
  expect(missing.toggle).not.toHaveBeenCalled()
  const failed = service(state({}), state({ status: 'recovery', action: 'restore', message: '备份已保留' }))
  await expect(runLocalizationCommand({ action: 'activate' }, failed)).rejects.toThrow('备份已保留')
})
