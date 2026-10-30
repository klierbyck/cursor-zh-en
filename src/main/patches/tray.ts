import { parse } from 'acorn'

const chrome: Record<string, string> = {
  'Recent Agents': '最近智能体', 'No recent agents': '暂无最近智能体',
  'New Agent': '新建智能体', 'Clear All Notifications': '清除所有通知',
  'Open Cursor': '打开 Cursor', Settings: '设置', Quit: '退出',
  'Log In': '登录', 'Sign In': '登录', 'Sign Up': '注册', 'Show Count': '显示数量',
  Running: '运行中', 'Needs attention': '需要关注', 'Needs Attention': '需要关注',
  'Local Agents': '本地智能体', 'Cloud Agents': '云端智能体',
  'Local Sessions': '本地会话', 'Cloud Sessions': '云端会话',
  Local: '本地', Cloud: '云端', Agents: '智能体', Recent: '最近',
  'In Progress': '进行中', 'In progress': '进行中', 'Completed': '已完成'
}
export interface TrayResult { text: string; count: number; missing: string[]; strategy: 'structural' | 'literal' }
const keyOf = (node: any) => node?.computed ? undefined : node?.key?.name ?? node?.key?.value
const translateExpression = (value: string) => `(v=>typeof v==="string"?(${JSON.stringify(chrome)}[v]??v.replace(/^(\\d+) more unread$/,"$1 条未读消息").replace(/^View More \\((\\d+)\\)$/,"查看更多（$1）").replace(/^Agent (\\d+)$/,"智能体 $1")):v)(${value})`

/** Restrict rewriting to a proven native-tray menu method, never user agent names. */
export function patchTray(source: string, replacements: [string, string][]): TrayResult {
  let ast: any
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true }) } catch { return literalTray(source, replacements) }
  const candidates: { method: any; owner: any }[] = []
  function walk(node: any, _parent?: any, owner?: any): void {
    if (!node || typeof node !== 'object') return
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') owner = node
    if (node.type === 'MethodDefinition') {
      const body = source.slice(node.start, node.end)
      if (body.includes('tray.settings_opened') && body.includes('tray.open_cursor_clicked') && body.includes('buildFromTemplate')) candidates.push({ method: node, owner })
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, node, owner))
      else if (value && typeof value === 'object' && 'type' in value) walk(value, node, owner)
    }
  }
  walk(ast)
  if (candidates.length > 1) throw new Error('托盘菜单结构不唯一，未修改主进程文件')
  if (!candidates.length) return literalTray(source, replacements)
  const { method, owner } = candidates[0]!
  const edits: { start: number; end: number; text: string }[] = []
  function visit(node: any, mode: 'menu' | 'agent'): void {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Property' && ['label', 'toolTip'].includes(String(keyOf(node)))) {
      let value = node.value
      if (mode === 'agent' && keyOf(node) === 'label') {
        if (value.type !== 'LogicalExpression' || value.operator !== '||') return
        value = value.right // Only the generated fallback; preserve e.name verbatim.
      }
      const raw = source.slice(value.start, value.end)
      const translated = value.type === 'Literal' && typeof value.value === 'string' && chrome[value.value]
      edits.push({ start: value.start, end: value.end, text: translated ? JSON.stringify(translated) : translateExpression(raw) })
      return
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, mode))
      else if (value && typeof value === 'object' && 'type' in value) visit(value, mode)
    }
  }
  visit(method.value.body, 'menu')
  for (const member of owner?.body?.body || []) {
    if (member !== method && keyOf(member) === 'createComposerMenuItem') visit(member.value.body, 'agent')
  }
  let text = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })
  return { text, count: edits.length, missing: [], strategy: 'structural' }
}
function literalTray(source: string, replacements: [string, string][]): TrayResult {
  let text = source
  const missing: string[] = []
  let count = 0
  const builtIn: [string, string][] = Object.entries(chrome).map(([from, to]) => [`label:"${from}"`, `label:"${to}"`])
  for (const [from, to] of replacements.length ? replacements : builtIn) {
    const matches = source.split(from).length - 1
    if (matches > 1) throw new Error('托盘补丁锚点不唯一，未修改主进程文件')
    if (!matches) { missing.push(from); continue }
    text = text.replace(from, () => to)
    count++
  }
  return { text, count, missing, strategy: 'literal' }
}
