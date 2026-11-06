import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { LocalizationService } from './main/core/service'
import { parseLocalizationCommand, runLocalizationCommand } from './main/core/cli'

async function main(): Promise<void> {
  const command = parseLocalizationCommand(process.argv.slice(2))
  if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('只支持 Windows 和 macOS')
  const appData = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const service = new LocalizationService({
    dataRoot: join(appData, 'CursorZhToggle'),
    resourcesRoot: resolve('resources'),
    initialInstallation: command.installDir,
    chooseInstallation: async () => undefined,
    emit: state => { if (state.status === 'busy') console.log(`${state.progress}% ${state.message}`) }
  })
  console.log(await runLocalizationCommand(command, service))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
