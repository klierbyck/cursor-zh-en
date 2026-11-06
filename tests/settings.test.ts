import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { loadResources, type PlanResources } from '../src/main/patches/plan'

let resources: PlanResources
const pages: JSDOM[] = []
beforeAll(async () => { resources = await loadResources(join(process.cwd(), 'resources')) })
afterEach(() => { pages.splice(0).forEach(page => page.window.close()) })
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const screenshotLabels = [
  'Pro Plan', 'VS Code Settings', 'General', 'Agents', 'Cloud Agents', 'Models', 'Voice', 'Source Control',
  'Customize', 'Browser & Network', 'Code Intelligence', 'Beta', 'Docs',
  'Wait for MCP Authentication', 'Wait indefinitely to authenticate when prompted. When off, skip authentication prompts after 30 seconds.',
  'Execution and Approvals', 'Run Mode', 'Choose how Agents run tools like command execution, MCP, and file writes.',
  'All commands will run without approval, classification or sandboxing.', 'Run Everything', 'Learn more',
  'Applying Changes', 'Inline Diffs', 'Show inline diff decorations in the editor instead of only showing changes in the review panel',
  'Jump to Next Diff on Accept', 'Automatically jump to the next diff when accepting changes with Ctrl+Y',
  'Auto Format on Agent Finish', 'Automatically format files when the agent finishes', 'Terminal and Editing',
  'Legacy Terminal Tool', 'Use the legacy terminal tool in agent mode, for use on systems with unsupported shell configurations',
  'Toolbar on Selection', 'Show Add to Chat & Quick Edit buttons when selecting code',
  'Auto-Parse Links', 'Automatically parse links when pasted into Quick Edit (Ctrl+K) input',
  'Themed Diff Backgrounds', 'Use themed background colors for inline code diffs',
  'Terminal Hint', 'Show a hint for Ctrl+K in the Terminal',
  'Preview Box for Terminal Ctrl+K', 'Use a preview box instead of streaming responses directly into the shell'
]
const conversationLabels = [
  'Search settings Ctrl+F', 'Conversation', 'Text Size', 'Adjust the conversation text size', 'Submit with Ctrl + Enter',
  'Ctrl+Enter submits chat, Enter inserts a newline, and primary action moves to Ctrl+Alt+Enter',
  'Default Model', 'What model new agents use by default', 'Cursor Default', 'New Messages',
  'Choose the default behavior of messages sent while Agent is working', 'Queue', 'Manually Sent Messages from Queue',
  'Choose the default behavior of messages sent from the queue', 'Interrupt', 'Code Block Word Wrap',
  'Wrap long lines in Agent conversation code blocks', 'Agent Autocomplete', 'Contextual suggestions while prompting Agent',
  'Auto-Approve Mode Transitions', 'Allow agent to switch to modes like Plan or Debug without asking. When off, Cursor asks first, but skips if unanswered within 15 seconds.',
  'Third-Party Imports', 'Include Third-Party Plugins, Skills, and Other Configs', 'Automatically import agent configs from other tools',
  'Context and Tools', 'Web Search Tool', 'Allow Agent to search the web for relevant information', 'Auto-Accept Web Search',
  'Enabled by Run Everything Auto-Run Mode: Agent bypasses approval prompts for tools including Web Search'
]
const voiceLabels = [
  'Voice', 'Agent Voice', 'Default voice for voice chats. Changing the voice plays a short sample.', 'Default voice for voice chats',
  'Speed', 'How quickly the voice speaks in voice chats.', 'How quickly the voice speaks in voice chats',
  'Language', 'Language used in voice chats.', 'Language used in voice chats',
  'Auto-detect', 'Microphone', 'Microphone used in voice chats.', 'System Default',
  'Submit Keywords', 'Voice Submit Keywords', 'Words that send your prompt while you dictate',
  'Words that send your prompt while you dictate. Voice chats ignore them.', 'Choose a voice', 'Play voice sample', 'Stop voice sample'
]
async function render(labels: string[], glass = false) {
  const dom = new JSDOM(`<main class="monaco-workbench"><section class="cursor-settings">${labels.map((value, index) => `<div class="${glass ? 'ui-field-group__entry' : 'cursor-settings-cell'}"><span id="s${index}" class="${glass ? 'ui-field-group__entry-description' : 'cursor-settings-cell-description'}">${escape(value)}</span></div>`).join('')}<input id="keyword" value="submit"><span id="voice-name">Ara</span><span id="rate">1x</span></section></main>`, { runScripts: 'outside-only', pretendToBeVisual: true })
  pages.push(dom)
  dom.window.eval(resources.runtime)
  await new Promise(resolve => setTimeout(resolve, 650))
  return dom
}
function expectTranslated(dom: JSDOM, labels: string[]) {
  const missing = labels.filter((_label, index) => !/[\u4e00-\u9fff]/.test(dom.window.document.querySelector(`#s${index}`)!.textContent || ''))
  expect(missing, 'Visible settings left untranslated').toEqual([])
}
it('translates all 41 visible labels and descriptions in the reported execution/settings screenshot', async () => {
  expectTranslated(await render(screenshotLabels), screenshotLabels)
})
it('retains the complete conversation, queue, autocomplete and approval settings coverage', async () => {
  expectTranslated(await render(conversationLabels), conversationLabels)
})
it.each([false, true])('translates voice labels, descriptions and preview controls with glass=%s while preserving names and keywords', async glass => {
  const dom = await render(voiceLabels, glass)
  expectTranslated(dom, voiceLabels)
  expect((dom.window.document.querySelector('#keyword') as HTMLInputElement).value).toBe('submit')
  expect(dom.window.document.querySelector('#voice-name')!.textContent).toBe('Ara')
  expect(dom.window.document.querySelector('#rate')!.textContent).toBe('1x')
})
