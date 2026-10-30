import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { loadResources } from '../src/main/patches/plan'

let code: string
let entries: Record<string, string>
const pages: JSDOM[] = []
beforeAll(async () => { const resources = await loadResources(join(process.cwd(), 'resources')); code = resources.runtime; entries = resources.dictionary.entries })
afterEach(() => { for (const dom of pages.splice(0).reverse()) { dom.window.dispatchEvent(new dom.window.Event('cursorzh:dispose')); dom.window.close() } })
async function page(body: string, setup: (dom: JSDOM) => void = () => {}) {
  const dom = new JSDOM(`<body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true })
  pages.push(dom); setup(dom); dom.window.eval(code)
  await new Promise(resolve => setTimeout(resolve, 80))
  return dom
}
describe('project-owned UI translation runtime', () => {
  it('translates owned dictionary labels and attributes in supported UI roots', async () => {
    const dom = await page('<main class="monaco-workbench"><section class="cursor-settings"><button id="button" title="Settings">New Agent</button><p id="voice">Agent Voice</p><p id="voice-description">Default voice for voice chats. Changing the voice plays a short sample.</p><input id="search" placeholder="Search settings Ctrl+F"></section></main>')
    const document = dom.window.document
    expect(document.querySelector('#button')!.textContent).toBe(entries['New Agent'])
    expect(document.querySelector('#button')!.getAttribute('title')).toBe(entries.Settings)
    expect(document.querySelector('#voice')!.textContent).toBe(entries['Agent Voice'])
    expect(document.querySelector('#voice-description')!.textContent).toBe(entries['Default voice for voice chats. Changing the voice plays a short sample.'])
    expect(document.querySelector('#search')!.getAttribute('placeholder')).toBe(entries['Search settings Ctrl+F'])
  })
  it('translates dynamic UI but never code, terminal, chat or user input', async () => {
    const dom = await page('<main class="monaco-workbench"><div class="cursor-settings"><span id="dynamic">Settings</span><input id="input" value="Settings"><div contenteditable="true" id="typed">Settings</div></div><div class="monaco-editor" id="code">Settings</div><div class="xterm" id="terminal">Settings</div><div class="composer-ai-message" id="chat">Settings</div></main>')
    const document = dom.window.document
    document.querySelector('#dynamic')!.textContent = 'Voice'
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(document.querySelector('#dynamic')!.textContent).toBe(entries.Voice)
    expect((document.querySelector('#input') as HTMLInputElement).value).toBe('Settings')
    for (const id of ['typed', 'code', 'terminal', 'chat']) expect(document.querySelector(`#${id}`)!.textContent).toBe('Settings')
  })
  it('translates every visible dropdown option and nested description without translating model names', async () => {
    const dom = await page('<main class="monaco-workbench"><section class="cursor-settings"><div class="context-view"><div role="option"><span>Steer</span><small>Steer the agent without stopping it</small></div><div role="option"><span>Queue</span><small>Send after Agent finishes</small></div><div role="option"><span>Interrupt</span><small>Stop the agent and send the message</small></div><div role="option"><span>Auto-Review</span></div></div><div class="ui-model-picker__popover"><div class="ui-model-picker__list" role="listbox"><div class="ui-model-picker__item-content" role="option"><span>Auto</span></div><div class="ui-model-picker__item-content" role="option"><span>gpt-5.2-codex</span></div><div class="ui-model-picker__item-content" role="option"><span>claude-4-sonnet</span></div></div></div></section></main>')
    const document = dom.window.document
    expect(document.querySelector('[role="option"] span')!.textContent).toBe('引导')
    expect(document.querySelectorAll('[role="option"]')[0]!.textContent).toContain('在不中断智能体的情况下引导它')
    expect(document.querySelectorAll('[role="option"]')[1]!.textContent).toContain('队列')
    expect(document.querySelectorAll('[role="option"]')[1]!.textContent).toContain('智能体完成后发送')
    expect(document.querySelectorAll('[role="option"]')[2]!.textContent).toContain('中断')
    expect(document.querySelectorAll('[role="option"]')[2]!.textContent).toContain('停止智能体并发送消息')
    expect(document.querySelectorAll('[role="option"]')[3]!.textContent).toBe('自动审查')
    const modelOptions = document.querySelectorAll('.ui-model-picker__list [role="option"]')
    expect(Array.from(modelOptions).map(option => option.textContent)).toEqual(['Auto', 'gpt-5.2-codex', 'claude-4-sonnet'])
  })
  it('translates menus, welcome controls and notifications', async () => {
    const dom = await page('<main class="monaco-workbench"><nav class="menubar"><span id="file">File</span><span id="edit">Edit</span></nav><div class="welcome-page"><button id="project">Open Project</button></div><div class="notification-list-item"><span id="notice">Upgrade to Pro</span></div></main>')
    const document = dom.window.document
    expect(document.querySelector('#file')!.textContent).toBe(entries.File)
    expect(document.querySelector('#edit')!.textContent).toBe(entries.Edit)
    expect(document.querySelector('#project')!.textContent).toBe(entries['Open Project'])
    expect(document.querySelector('#notice')!.textContent).toBe(entries['Upgrade to Pro'])
  })
  it('translates browser guest UI without navigating anywhere', async () => {
    const guest = new JSDOM('<div class="browser-welcome-title">Browser</div><button class="browser-error-restart-button">Restart Browser</button><button id="web-content">Restart Browser</button>', { runScripts: 'outside-only' })
    pages.push(guest)
    const execute = vi.fn(async (script: string) => { guest.window.eval(script) })
    await page('<main class="monaco-workbench"><div class="browser-tab"><webview></webview></div></main>', host => { (host.window.document.querySelector('webview') as any).executeJavaScript = execute })
    expect(execute).toHaveBeenCalled()
    expect(guest.window.document.querySelector('.browser-welcome-title')!.textContent).toBe(entries.Browser)
    expect(guest.window.document.querySelector('.browser-error-restart-button')!.textContent).toBe(entries['Restart Browser'])
    expect(guest.window.document.querySelector('#web-content')!.textContent).toBe('Restart Browser')
  })
  it('stops observer work when disposed', async () => {
    const dom = await page('<main class="monaco-workbench"><div class="cursor-settings"></div></main>')
    dom.window.dispatchEvent(new dom.window.Event('cursorzh:dispose'))
    const value = dom.window.document.createElement('button'); value.textContent = 'Save'
    dom.window.document.querySelector('.cursor-settings')!.append(value)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(value.textContent).toBe('Save')
  })
  it('handles split mnemonic labels, lazy menus and keyboard hints without removing child elements', async () => {
    const dom = await page('<main class="monaco-workbench"><nav class="menubar"><div class="menubar-menu-title" id="file"><span>F</span>ile</div></nav></main>')
    const document = dom.window.document
    expect(document.querySelector('#file')!.textContent).toBe('文件')
    expect(document.querySelector('#file span')).not.toBeNull()
    const menu = document.createElement('div')
    menu.className = 'context-view'
    menu.innerHTML = '<div role="menu"><a role="menuitem"><span class="action-label">Add to Chat</span><span class="keybinding">Ctrl+L</span></a></div>'
    document.body.append(menu)
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(menu.querySelector('.action-label')!.textContent).toMatch(/添加到/)
    expect(menu.querySelector('.keybinding')!.textContent).toBe('Ctrl+L')
    document.querySelector('#file')!.innerHTML = '<span>F</span>ile'
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(document.querySelector('#file')!.textContent).toBe('文件')
  })
  it('translates multipart descriptions while preserving code tokens and links', async () => {
    const dom = await page('<main class="monaco-workbench"><section class="cursor-settings"><p id="fragment" class="cursor-settings-cell-description">MCP tools that can run automatically. Format: <code>server:tool</code> for all tools from a server, <code>*:tool</code> for a tool from any server, or \'*:*\' for all tools from all servers</p></section></main>')
    const fragment = dom.window.document.querySelector('#fragment')!
    expect(fragment.textContent).not.toContain('for all tools')
    expect(fragment.querySelectorAll('code')).toHaveLength(2)
    expect(fragment.querySelector('code')!.textContent).toBe('server:tool')
  })
  it('keeps full offline marketplace names, descriptions and labels without transmitting text', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('Unexpected network')))
    const dom = await page('<main class="monaco-workbench"><section class="plugin-marketplace"><h1>All Plugins</h1><p id="name">Datadog</p><p id="description">Use Datadog directly in Cursor through a preconfigured Datadog MCP server.</p><p id="unknown">An unknown publisher description stays local and unchanged.</p><button>Add to Cursor</button></section></main>', host => { host.window.fetch = fetch as any })
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(dom.window.document.querySelector('#name')!.textContent).toBe('Datadog（监控观测）')
    expect(dom.window.document.querySelector('#description')!.textContent).toContain('预配置')
    expect(dom.window.document.querySelector('#unknown')!.textContent).toBe('An unknown publisher description stays local and unchanged.')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('protects code, terminal output, file names, chat text and keywords during specialized translation', async () => {
    const dom = await page('<main class="monaco-workbench"><section class="plugin-marketplace"><h1>All Plugins</h1></section><div class="composer-ai-message"><p id="answer">Datadog</p><span id="stop">Stop Ctrl+X</span></div><div class="composer-human-message" id="prompt">Run Everything</div><div class="xterm"><p id="terminal">Upgrade to Pro</p></div><div class="monaco-editor"><span id="code">Run Everything</span><button title="Settings" id="code-action">Settings</button></div><div class="explorer-viewlet" id="file">New Agent</div><div contenteditable="true" id="typed">MCP tools that can run automatically.</div><div class="tabs-container"><span class="label-name" id="filename">Settings</span></div></main>')
    await new Promise(resolve => setTimeout(resolve, 650))
    const expected = { answer: 'Datadog', stop: 'Stop Ctrl+X', prompt: 'Run Everything', terminal: 'Upgrade to Pro', code: 'Run Everything', 'code-action': 'Settings', file: 'New Agent', typed: 'MCP tools that can run automatically.', filename: 'Settings' }
    for (const [id, text] of Object.entries(expected)) expect(dom.window.document.getElementById(id)!.textContent, id).toBe(text)
    expect(dom.window.document.querySelector('#code-action')!.getAttribute('title')).toBe('Settings')
  })
  it('translates updates to character data and placeholder attributes while preserving editable text', async () => {
    const dom = await page('<main class="monaco-workbench"><section class="cursor-settings"><span id="changing">General</span><input id="search" placeholder="Search"><div id="prompt" contenteditable="true" data-placeholder="Search">Voice</div></section></main>')
    const document = dom.window.document
    document.querySelector('#changing')!.firstChild!.nodeValue = 'Voice'
    document.querySelector('#search')!.setAttribute('placeholder', 'Search settings Ctrl+F')
    document.querySelector('#prompt')!.setAttribute('data-placeholder', 'Search settings Ctrl+F')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(document.querySelector('#changing')!.textContent).toBe('语音')
    expect(document.querySelector('#search')!.getAttribute('placeholder')).toBe(entries['Search settings Ctrl+F'])
    expect(document.querySelector('#prompt')!.getAttribute('data-placeholder')).toBe(entries['Search settings Ctrl+F'])
    expect(document.querySelector('#prompt')!.textContent).toBe('Voice')
  })
  it('handles browser load errors without translating normal website content', async () => {
    const guest = new JSDOM('<div class="browser-welcome-title">Browser</div><p id="page-content">Browser</p>', { runScripts: 'outside-only' })
    pages.push(guest)
    const execute = vi.fn(async (script: string) => { guest.window.eval(script) })
    const dom = await page('<main class="monaco-workbench"><div class="browser-tab"><webview></webview></div></main>', host => { (host.window.document.querySelector('webview') as any).executeJavaScript = execute })
    expect(guest.window.document.querySelector('#page-content')!.textContent).toBe('Browser')
    guest.window.document.body.innerHTML = '<div class="browser-error-title">Connection Failed</div><button class="browser-error-restart-button">Restart Browser</button><p id="user-page">Restart Browser</p>'
    dom.window.document.querySelector('webview')!.dispatchEvent(new dom.window.Event('did-fail-load'))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(guest.window.document.querySelector('.browser-error-title')!.textContent).toBe('连接失败')
    expect(guest.window.document.querySelector('.browser-error-restart-button')!.textContent).toBe('重启浏览器')
    expect(guest.window.document.querySelector('#user-page')!.textContent).toBe('Restart Browser')
  })
  it('translates auxiliary About windows and restores the open hook and observers on dispose', async () => {
    const auxiliary = new JSDOM('<div data-component="glass-about-dialog"><button id="copy">Copy</button><p id="version">Version: 3.27.14</p></div>', { runScripts: 'outside-only' })
    pages.push(auxiliary)
    const open = vi.fn(() => auxiliary.window)
    const dom = await page('<main class="monaco-workbench"></main>', host => { host.window.open = open as any })
    dom.window.open('about:blank', '', 'popup=yes,width=500,height=400')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(auxiliary.window.document.querySelector('#copy')!.textContent).toBe('复制')
    expect(auxiliary.window.document.querySelector('#version')!.textContent).toMatch(/版本/)
    dom.window.dispatchEvent(new dom.window.Event('cursorzh:dispose'))
    expect(dom.window.open).toBe(open)
    const paragraph = auxiliary.window.document.createElement('p')
    paragraph.textContent = 'Copy'
    auxiliary.window.document.querySelector('[data-component]')!.append(paragraph)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(paragraph.textContent).toBe('Copy')
  })
  it('never submits chat, code or terminal text even when marketplace online translation is explicitly enabled', async () => {
    const dom = new JSDOM('<main class="monaco-workbench"><section class="plugin-marketplace"><h1>All Plugins</h1><p>Unlisted vendor widgets provide stellar analytics for distributed production services.</p></section><div class="composer-ai-message">Private conversation information must never leave this machine.</div><div class="xterm">Private terminal output must never leave this machine.</div><pre>Private source code must never leave this machine.</pre></main>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://cursorzh.test/' })
    pages.push(dom)
    dom.window.localStorage.setItem('CursorZh_Market_Online_Translate', '1')
    const fetch = vi.fn(async () => ({ json: async () => [[['仅翻译插件的公开介绍']]] }))
    dom.window.fetch = fetch as any
    dom.window.eval(code)
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(fetch).toHaveBeenCalled()
    const requests = (fetch.mock.calls as unknown as [string][]).map(([url]) => new URL(url).searchParams.get('q'))
    expect(requests.some(value => value?.includes('Private'))).toBe(false)
    expect(requests).toContain('Unlisted vendor widgets provide stellar analytics for distributed production services.')
  })
  it('can be disposed and reinjected without leaving stale installation flags', async () => {
    const dom = await page('<main class="monaco-workbench"><section class="cursor-settings"><button>Save</button></section></main>')
    dom.window.dispatchEvent(new dom.window.Event('cursorzh:dispose'))
    dom.window.eval(code)
    const value = dom.window.document.createElement('button')
    value.textContent = 'Save'
    dom.window.document.querySelector('section')!.append(value)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(value.textContent).toBe('保存')
  })
})
