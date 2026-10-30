import type { LocalizationService } from './service'

export type LocalizationCommand = { action: 'activate' | 'restore'; installDir?: string }

export function parseLocalizationCommand(args: string[]): LocalizationCommand {
  const [action, ...rest] = args
  if (action !== 'activate' && action !== 'restore') throw new Error('用法：activate|restore [--install-dir <Cursor 安装目录或 Cursor.app>]')
  if (!rest.length) return { action }
  if (rest.length !== 2 || rest[0] !== '--install-dir' || !rest[1]?.trim()) throw new Error('只能使用 --install-dir <Cursor 安装目录或 Cursor.app> 指定安装路径')
  return { action, installDir: rest[1] }
}

export async function runLocalizationCommand(command: LocalizationCommand, service: Pick<LocalizationService, 'initialize' | 'toggle'>): Promise<string> {
  const state = await service.initialize()
  if (state.action !== command.action || !state.canToggle) {
    if (state.action === 'locate') throw new Error('未找到唯一的 Cursor 安装，请用 --install-dir 指定安装路径；未执行任何写入。')
    throw new Error(`${state.title}：${state.message}；未执行${command.action === 'restore' ? '还原' : '汉化'}。`)
  }
  const result = await service.toggle()
  if (result.status !== (command.action === 'activate' ? 'active' : 'inactive')) throw new Error(`${result.title}：${result.message}。备份和恢复资料已保留，请不要手工删除。`)
  return `${result.message}${result.backup ? `\n恢复资料：${result.backup}` : ''}`
}
