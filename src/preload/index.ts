import { contextBridge, ipcRenderer } from 'electron'
import { CHANNEL, type CursorZhApi, type UpdateState, type ViewState } from '../shared/types'

const api: CursorZhApi = {
  state: () => ipcRenderer.invoke(CHANNEL.state),
  toggle: () => ipcRenderer.invoke(CHANNEL.toggle),
  refresh: () => ipcRenderer.invoke(CHANNEL.refresh),
  updateState: () => ipcRenderer.invoke(CHANNEL.updateState),
  checkUpdates: () => ipcRenderer.invoke(CHANNEL.checkUpdates),
  installUpdate: () => ipcRenderer.invoke(CHANNEL.installUpdate),
  onUpdateState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState): void => listener(state)
    ipcRenderer.on(CHANNEL.updateChanged, handler)
    return () => ipcRenderer.removeListener(CHANNEL.updateChanged, handler)
  },
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: ViewState): void => listener(state)
    ipcRenderer.on(CHANNEL.changed, handler)
    return () => ipcRenderer.removeListener(CHANNEL.changed, handler)
  }
}
contextBridge.exposeInMainWorld('cursorZh', api)
