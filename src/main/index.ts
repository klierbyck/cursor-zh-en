import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from 'electron'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { CHANNEL } from '../shared/types'
import { LocalizationService, errorText } from './core/service'
import { runSmokeTest } from './smoke'
import { autoUpdater } from 'electron-updater'
import { readUpdateConfig, UpdateController } from './core/updates'
import { pngIconContainer } from './platform/app-icon'

let window: BrowserWindow | undefined
let service: LocalizationService | undefined
let updates: UpdateController | undefined
let updateTimer: ReturnType<typeof setTimeout> | undefined
let updateInterval: ReturnType<typeof setInterval> | undefined

// Keep smoke tests isolated from an installed CursorZhToggle instance/profile.
const smokeTest = process.argv.includes('--smoke-test') || process.env.CURSORZH_SMOKE_TEST === '1'
app.setPath('userData', join(app.getPath('appData'), smokeTest ? 'CursorZhToggle-Smoke' : 'CursorZhToggle'))

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { window?.show(); window?.focus() })
  app.whenReady().then(async () => {
    const appId = app.isPackaged ? 'com.cursorzh.toggle' : 'com.cursorzh.toggle.development'
    app.setAppUserModelId(appId)
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    const icon = nativeImage.createFromPath(app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve('src/renderer/icon.png'))
    if (icon.isEmpty()) throw new Error('应用图标 icon.png 无法读取')
    window = new BrowserWindow({
      width: 548, height: 694, minWidth: 460, minHeight: 620,
      title: 'Cursor 汉化助手', backgroundColor: '#f6f4ef',
      icon,
      show: false, autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, allowRunningInsecureContent: false
      }
    })
    if (process.platform === 'win32') {
      await mkdir(app.getPath('userData'), { recursive: true })
      const iconPath = join(app.getPath('userData'), 'app-icon.ico')
      await writeFile(iconPath, pngIconContainer(icon.resize({ width: 256, height: 256 }).toPNG()))
      window.setAppDetails({ appId, appIconPath: iconPath, appIconIndex: 0, relaunchDisplayName: 'Cursor 汉化助手', relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"` })
      window.setIcon(icon)
    } else if (process.platform === 'darwin') app.dock?.setIcon(icon)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    if (process.env.CURSORZH_DEVTOOLS === '1') window.webContents.openDevTools({ mode: 'detach' })
    window.on('close', event => {
      if (service?.isBusy) {
        event.preventDefault()
        void dialog.showMessageBox(window!, { type: 'info', title: '操作尚未结束', message: '正在写入或恢复文件，请等待完成后再关闭。', buttons: ['知道了'] })
      }
    })
    window.once('ready-to-show', () => window?.show())

    const resourcesRoot = app.isPackaged ? join(process.resourcesPath, 'resources') : resolve('resources')
    service = new LocalizationService({
      dataRoot: app.getPath('userData'), resourcesRoot,
      emit: state => { if (window && !window.isDestroyed()) window.webContents.send(CHANNEL.changed, state) },
      chooseInstallation: async () => {
        const selected = await dialog.showOpenDialog(window!, {
          title: process.platform === 'darwin' ? '选择 Cursor.app' : '选择 Cursor 安装目录',
          properties: ['openDirectory'],
          message: '选择应用本身或包含 Cursor.exe 的文件夹，不要选择用户数据目录。'
        })
        return selected.canceled ? undefined : selected.filePaths[0]
      }
    })
    const updateConfig = await readUpdateConfig(resourcesRoot)
    updates = new UpdateController({
      version: app.getVersion(), packaged: app.isPackaged, config: updateConfig, updater: autoUpdater,
      emit: state => { if (window && !window.isDestroyed()) window.webContents.send(CHANNEL.updateChanged, state) },
      isBusy: () => Boolean(service?.isBusy),
      confirmInstall: async () => (await dialog.showMessageBox(window!, { type: 'question', title: '安装助手更新', message: '更新已下载。现在重启助手并安装？不会重新启动或修改 Cursor。', buttons: ['重启并更新', '稍后'], defaultId: 0, cancelId: 1 })).response === 0,
      beforeInstall: () => {},
      manualInstall: process.platform === 'darwin',
      openRelease: async () => { await shell.openExternal(`https://github.com/${updateConfig.githubOwner}/${updateConfig.githubRepo}/releases/latest`) }
    })
    const authorized = (event: Electron.IpcMainInvokeEvent, args: unknown[]): void => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || args.length) {
        throw new Error('未授权的调用')
      }
    }
    ipcMain.handle(CHANNEL.state, async (event, ...args) => { authorized(event, args); return service!.state })
    ipcMain.handle(CHANNEL.toggle, async (event, ...args) => { authorized(event, args); return updates!.isInstalling ? service!.state : service!.toggle() })
    ipcMain.handle(CHANNEL.refresh, async (event, ...args) => { authorized(event, args); return updates!.isInstalling ? service!.state : service!.rescan() })
    ipcMain.handle(CHANNEL.updateState, async (event, ...args) => { authorized(event, args); return updates!.state })
    ipcMain.handle(CHANNEL.checkUpdates, async (event, ...args) => { authorized(event, args); return updates!.check() })
    ipcMain.handle(CHANNEL.installUpdate, async (event, ...args) => { authorized(event, args); return updates!.install() })

    if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else await window.loadFile(join(__dirname, '../renderer/index.html'))
    try { await service.initialize() } catch (error) {
      if (smokeTest) throw error
      await dialog.showMessageBox(window, { type: 'error', title: '初始化失败', message: `${errorText(error)}\n未修改任何 Cursor 文件。`, buttons: ['关闭'] })
      app.quit()
    }
    if (!smokeTest && app.isPackaged && updateConfig.checkOnStartup && updateConfig.githubOwner) {
      updateTimer = setTimeout(() => { void updates?.check() }, 5000)
      updateInterval = setInterval(() => { void updates?.check() }, 4 * 60 * 60 * 1000)
    }
    if (smokeTest) {
      await runSmokeTest({ window, service, updates, icon, resourcesRoot })
      app.quit()
    }
  }).catch(error => { console.error(error); app.exit(1) })
}
app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  if (service?.isBusy) { event.preventDefault(); return }
  if (updateTimer) clearTimeout(updateTimer)
  if (updateInterval) clearInterval(updateInterval)
})
