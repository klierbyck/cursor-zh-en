import { app, BrowserWindow, type NativeImage } from 'electron'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LocalizationService } from './core/service'
import type { UpdateController } from './core/updates'
import { loadResources } from './core/resources'

interface SmokeOptions {
  window: BrowserWindow
  service: LocalizationService
  updates: UpdateController
  icon: NativeImage
  resourcesRoot: string
}

export async function runSmokeTest({ window, service, updates, icon, resourcesRoot }: SmokeOptions): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 350))
  const dom = await window.webContents.executeJavaScript('({ buttons: document.querySelectorAll("button").length, decorations: document.querySelector("#toggle")?.querySelectorAll(".button-icon, .button-arrow").length ?? 0, status: document.body.dataset.status, action: document.querySelector("#button-label")?.textContent, bridge: !!window.cursorZh, version: document.querySelector("#app-version")?.textContent, background: getComputedStyle(document.querySelector("#toggle")).backgroundColor, layout: getComputedStyle(document.querySelector(".masthead")).display, brandWidth: document.querySelector(".brand-mark").getBoundingClientRect().width, refresh: !!document.querySelector("#refresh svg"), legacyFooterVersion: !!document.querySelector("footer .build") })')
  if (dom.buttons !== 3 || dom.decorations !== 0 || !dom.bridge || dom.status !== service.state.status || dom.version !== `v${app.getVersion()}` || dom.layout !== 'flex' || dom.brandWidth !== 30 || !dom.refresh || dom.legacyFooterVersion) throw new Error('桌面样式、版本位置或安全桥接启动验证失败')
  const refreshed = await window.webContents.executeJavaScript('window.cursorZh.refresh()')
  if (refreshed.status !== service.state.status) throw new Error('刷新状态验证失败')
  if (!app.isPackaged) await writeFile(resolve('out/smoke.png'), (await window.webContents.capturePage()).toPNG())
  // Exercise the shipped translator in an isolated Chromium page, never in the
  // user's Cursor process/profile. This also verifies packaged resource inclusion.
  const resources = await loadResources(resourcesRoot)
  const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  let translation: { menu: string; setting: string; voice: string; placeholder: string; code: string; active: boolean; coverage: Record<string, number>; checkedLabels: number; unchanged: string[] }
  try {
    await probe.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' + '<main class="monaco-workbench"><nav class="menubar" role="menubar"><div class="menubar-menu-button" role="menuitem"><span class="menubar-menu-title" id="menu">File</span></div></nav><section class="cursor-settings"><p id="setting">Text Size</p><p id="voice">Voice</p><input id="search" placeholder="Search settings Ctrl+F"></section><pre id="code">New Agent</pre></main>'))
    const labels = Object.keys(resources.dictionary.entries).filter(text => /[A-Za-z]/.test(text) && text === text.trim() && resources.dictionary.entries[text] !== text)
    await probe.webContents.executeJavaScript(`window.validationLabels=${JSON.stringify(labels)};const list=document.createElement('section');list.className='cursor-settings';for(const [index,text] of window.validationLabels.entries()){const row=document.createElement('p');row.id='validation-'+index;row.textContent=text;list.append(row)}document.querySelector('main').append(list)`)
    await probe.webContents.executeJavaScript(resources.runtime)
    await new Promise(resolve => setTimeout(resolve, 2000))
    translation = await probe.webContents.executeJavaScript('({menu:document.querySelector("#menu").textContent,setting:document.querySelector("#setting").textContent,voice:document.querySelector("#voice").textContent,placeholder:document.querySelector("#search").getAttribute("placeholder"),code:document.querySelector("#code").textContent,active:window.__cursorZhRuntime===true,coverage:window.__cursorZhCoverage,checkedLabels:window.validationLabels.length,unchanged:window.validationLabels.filter((text,index)=>document.getElementById("validation-"+index).textContent===text)})')
    if (translation.menu !== '文件' || translation.setting !== resources.dictionary.entries['Text Size'] || translation.voice !== '语音' || translation.placeholder !== resources.dictionary.entries['Search settings Ctrl+F'] || translation.code !== 'New Agent') throw new Error('打包翻译运行时验证失败')
    if (translation.coverage.entries !== resources.coverage.entries || (translation.coverage.patterns ?? 0) < 239 || translation.checkedLabels < 2700 || translation.unchanged.length) throw new Error(`完整翻译覆盖启动验证失败：${JSON.stringify(translation.unchanged)}`)
    await probe.webContents.executeJavaScript('window.dispatchEvent(new Event("cursorzh:dispose"))')
  } finally { probe.destroy() }
  console.log('CURSORZH_SMOKE ' + JSON.stringify({ version: app.getVersion(), icon: icon.getSize(), state: service.state, dom, update: updates.state, translation }))
}
