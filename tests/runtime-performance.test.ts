import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { loadResources } from '../src/main/patches/plan'

let code: string
const pages: JSDOM[] = []
beforeAll(async () => { code = (await loadResources(join(process.cwd(), 'resources'))).runtime })
afterEach(() => {
  for (const dom of pages.splice(0)) {
    dom.window.dispatchEvent(new dom.window.Event('cursorzh:dispose'))
    dom.window.close()
  }
})

async function controlledPage(body: string) {
  const dom = new JSDOM(`<body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true })
  pages.push(dom)
  await new Promise<void>(resolve => dom.window.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }))
  const tasks = new Map<number, () => void>()
  let id = 0
  dom.window.setTimeout = ((fn: () => void) => { tasks.set(++id, fn); return id }) as typeof dom.window.setTimeout
  dom.window.clearTimeout = value => { if (value !== undefined) tasks.delete(value) }
  // Use the work limit instead of machine speed to make yielding deterministic.
  vi.spyOn(dom.window.performance, 'now').mockReturnValue(0)
  async function step() {
    const item = tasks.entries().next().value
    if (!item) throw new Error('No scheduled translation task')
    tasks.delete(item[0]); item[1]()
    await Promise.resolve()
  }
  async function flush() {
    await Promise.resolve()
    for (let count = 0; tasks.size; count++) {
      if (count > 1000) throw new Error('Translation tasks did not settle')
      await step()
    }
  }
  return { dom, document: dom.window.document, tasks, step, flush, start: () => dom.window.eval(code) }
}

it('prunes a large conversation before visiting its contents and keeps subsequent updates local', async () => {
  const history = Array.from({ length: 400 }, (_, i) => `<div class="composer-ai-message"><div><span data-history="${i}">Settings</span><code>Save</code></div></div>`).join('')
  const page = await controlledPage(`<main class="monaco-workbench"><section class="composer-history">${history}</section><div class="composer-bottom-bar" id="controls"><button id="send" title="Settings">Save</button></div></main>`)
  let historyReads = 0
  const getAttribute = page.dom.window.Element.prototype.getAttribute
  vi.spyOn(page.dom.window.Element.prototype, 'getAttribute').mockImplementation(function (this: Element, name: string) {
    if (this.hasAttribute('data-history')) historyReads++
    return getAttribute.call(this, name)
  })
  const globalQueries = vi.spyOn(page.document, 'querySelectorAll')
  page.start(); await page.flush()
  expect(page.document.getElementById('send')!.textContent).toBe('保存')
  expect(historyReads).toBe(0)
  globalQueries.mockClear()
  const oldMessages = page.document.querySelector('.composer-history')!.innerHTML
  page.document.getElementById('controls')!.insertAdjacentHTML('beforeend', '<button id="next">New Agent</button>')
  await page.flush()
  expect(page.document.getElementById('next')!.textContent).toBe('新建智能体')
  expect(historyReads).toBe(0)
  expect(globalQueries).not.toHaveBeenCalled()
  expect(page.document.querySelector('.composer-history')!.innerHTML).toBe(oldMessages)
  // Streaming text and edits in protected content must not start a translation pass.
  page.document.querySelector('[data-history]')!.firstChild!.nodeValue = 'Voice'
  await Promise.resolve()
  expect(page.tasks.size).toBe(0)
})

it('splits a large UI update across tasks and cancels the remaining work on disposal', async () => {
  const page = await controlledPage(`<main class="monaco-workbench"><section class="cursor-settings">${'<button>Save</button>'.repeat(400)}</section><input id="draft" value="My prompt"></main>`)
  page.start()
  await page.step()
  const buttons = Array.from(page.document.querySelectorAll('button'))
  expect(buttons.some(button => button.textContent === '保存')).toBe(true)
  expect(buttons.some(button => button.textContent === 'Save')).toBe(true)
  expect(page.tasks.size).toBeGreaterThan(0)
  const draft = page.document.querySelector<HTMLInputElement>('#draft')!
  const send = vi.fn()
  draft.addEventListener('input', send)
  draft.value = 'My updated prompt'
  draft.dispatchEvent(new page.dom.window.Event('input'))
  expect(send).toHaveBeenCalledOnce()
  expect(draft.value).toBe('My updated prompt')
  const before = page.document.body.innerHTML
  page.dom.window.dispatchEvent(new page.dom.window.Event('cursorzh:dispose'))
  expect(page.tasks.size).toBe(0)
  await Promise.resolve()
  expect(page.document.body.innerHTML).toBe(before)
})

it('handles overlapping mutations, reused labels and removals without retaining a full-page fallback', async () => {
  const page = await controlledPage('<main class="monaco-workbench"><section class="cursor-settings" id="settings"></section></main>')
  page.start(); await page.flush()
  const section = page.document.getElementById('settings')!
  const group = page.document.createElement('div')
  section.append(group)
  group.innerHTML = '<div><button id="value">Save</button></div>'
  group.querySelector('div')!.insertAdjacentHTML('beforeend', '<span id="other">Settings</span>')
  await page.flush()
  expect(page.document.getElementById('value')!.textContent).toBe('保存')
  expect(page.document.getElementById('other')!.textContent).toBe('设置')
  page.document.getElementById('value')!.firstChild!.nodeValue = 'Voice'
  await page.flush()
  expect(page.document.getElementById('value')!.textContent).toBe('语音')
  const removed = page.document.createElement('button')
  removed.textContent = 'Save'; section.append(removed)
  await Promise.resolve()
  removed.remove()
  await page.flush()
  expect(removed.textContent).toBe('Save')
  expect(page.tasks.size).toBe(0)
})

it.each(['characterData', 'textContent'])('skips pure percentage changes made through %s without scheduling translation', async update => {
  const page = await controlledPage('<main class="monaco-workbench"><div role="tooltip"><span id="percent">59%</span><span id="label">context used</span><span id="tokens">160K / 272K</span></div></main>')
  page.start(); await page.flush()
  const percent = page.document.getElementById('percent')!
  const label = page.document.getElementById('label')!
  const tokens = page.document.getElementById('tokens')!
  expect(label.textContent).toBe('上下文已用')
  const closest = vi.spyOn(page.dom.window.Element.prototype, 'closest')
  if (update === 'characterData') percent.firstChild!.nodeValue = '59.5%'
  else percent.textContent = '59.5%'
  await Promise.resolve()
  expect(closest).not.toHaveBeenCalled()
  expect(page.tasks.size).toBe(0)
  expect(percent.textContent).toBe('59.5%')
  expect(label.textContent).toBe('上下文已用')
  expect(tokens.textContent).toBe('160K / 272K')
})

it('translates new context tooltips in the queue and refreshes reused labels immediately only on hover or focus', async () => {
  const page = await controlledPage('<main class="monaco-workbench"></main>')
  page.start(); await page.flush()
  page.document.body.insertAdjacentHTML('beforeend', '<div role="tooltip"><span id="usage">25% context used</span><span id="tokens">64K / 256K</span></div>')
  await page.flush()
  const usage = page.document.getElementById('usage')!
  expect(usage.textContent).toBe('25% 上下文已用')
  for (const event of ['mouseover', 'focusin']) {
    usage.firstChild!.nodeValue = '59% context used'
    await Promise.resolve()
    expect(usage.textContent).toBe('59% context used')
    usage.dispatchEvent(new page.dom.window.Event(event, { bubbles: true }))
    expect(usage.textContent).toBe('59% 上下文已用')
    await page.flush()
  }
  usage.firstChild!.nodeValue = '60% context used'
  await Promise.resolve()
  expect(usage.textContent).toBe('60% context used')
  await page.flush()
  expect(usage.textContent).toBe('60% 上下文已用')
  expect(page.document.getElementById('tokens')!.textContent).toBe('64K / 256K')
})
