import './style.css'
import type { CursorZhApi, UpdateState, ViewState } from '../shared/types'

declare global { interface Window { cursorZh: CursorZhApi } }
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const button = element<HTMLButtonElement>('toggle')
const refresh = element<HTMLButtonElement>('refresh')
const update = element<HTMLButtonElement>('check-update')
let state: ViewState | undefined
let updateState: UpdateState | undefined
let refreshing = false
let showUpdateMessage = false

function renderUpdate(next?: UpdateState): void {
  if (next) updateState = next
  if (!updateState) return
  element('app-version').textContent = `v${updateState.currentVersion}`
  update.textContent = updateState.status === 'ready' ? '重启并更新'
    : updateState.status === 'available' ? '前往下载更新'
    : updateState.status === 'checking' ? '检查中…'
    : updateState.status === 'downloading' ? `下载 ${Math.round(updateState.progress)}%` : '检查更新'
  update.disabled = refreshing || state?.status === 'busy' || state?.status === 'scanning' || (!updateState.canCheck && !updateState.canInstall)
  update.title = updateState.status === 'ready' ? `安装 v${updateState.nextVersion}` : updateState.status === 'available' ? '在 GitHub Release 下载 macOS 安装包' : '检查助手更新'
  if (['downloading', 'available', 'ready', 'error'].includes(updateState.status)) showUpdateMessage = true
  element('update-message').hidden = !showUpdateMessage
  element('update-message').textContent = updateState.message
}
function render(next: ViewState): void {
  state = next
  document.body.dataset.status = next.status
  const important = ['scanning', 'conflict', 'recovery', 'unsupported', 'error'].includes(next.status)
  element('message').textContent = important ? `${next.title}：${next.message}` : next.message
  element('version').textContent = next.version ? `Cursor v${next.version}` : '尚未检测到 Cursor'
  element('platform').textContent = next.platform
  element('installation').textContent = next.installation || '等待选择'
  element('installation').title = next.installation || ''
  element('backup').textContent = next.backup || ''
  element('backup').title = next.backup || ''
  element('backup-row').hidden = !next.backup
  element('warnings').hidden = !next.warnings.length
  element('warnings').textContent = next.warnings.join('\n')
  element('progress-track').hidden = next.status !== 'busy'
  element('progress-fill').style.width = `${Math.max(0, Math.min(100, next.progress))}%`
  button.disabled = refreshing || !next.canToggle || next.status === 'busy'
  button.setAttribute('aria-busy', String(next.status === 'busy'))
  refresh.disabled = refreshing || next.status === 'busy' || next.status === 'scanning'
  refresh.dataset.loading = String(refreshing || next.status === 'scanning')
  element('button-label').textContent = next.status === 'busy'
    ? '正在处理，请稍候'
    : next.action === 'restore' ? '取消 Cursor 汉化'
    : next.action === 'locate' ? '选择 Cursor 安装位置' : '激活 Cursor 汉化'
  renderUpdate()
}
button.addEventListener('click', async () => {
  if (!state?.canToggle || button.disabled) return
  button.disabled = true
  refresh.disabled = true
  update.disabled = true
  try { render(await window.cursorZh.toggle()) } catch (error) {
    if (state) render(state)
    element('message').textContent = `操作未完成：${error instanceof Error ? error.message : String(error)}`
  }
})
refresh.addEventListener('click', async () => {
  if (refresh.disabled || refreshing) return
  refreshing = true
  if (state) render(state)
  try { state = await window.cursorZh.refresh() } catch (error) {
    element('message').textContent = `刷新失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    refreshing = false
    if (state) render(state)
  }
})
update.addEventListener('click', async () => {
  if (update.disabled) return
  showUpdateMessage = true
  update.disabled = true
  try { renderUpdate(await (updateState?.canInstall ? window.cursorZh.installUpdate() : window.cursorZh.checkUpdates())) } catch {
    element('update-message').hidden = false
    element('update-message').textContent = '更新操作未完成，请稍后重试。'
    renderUpdate()
  }
})
if (window.cursorZh) {
  const unsubscribe = window.cursorZh.onState(render)
  const unsubscribeUpdates = window.cursorZh.onUpdateState(renderUpdate)
  window.addEventListener('beforeunload', () => { unsubscribe(); unsubscribeUpdates() }, { once: true })
  window.cursorZh.state().then(render).catch(error => { element('message').textContent = String(error) })
  window.cursorZh.updateState().then(renderUpdate).catch(() => { update.disabled = true })
} else {
  element('message').textContent = '请使用桌面程序打开。浏览器预览不提供文件系统权限，也不会修改 Cursor。'
  refresh.disabled = true
  update.disabled = true
}
