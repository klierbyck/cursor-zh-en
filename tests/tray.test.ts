import { runInNewContext } from 'node:vm'
import { patchTray } from '../src/main/patches/tray'

const fixture = `
const nativeMenu={buildFromTemplate:v=>v}; const processApi={quit(){}};
function countLabel(n){return \`\${n} more unread\`}
class Tray {
 trackEvent(){} focusOrOpenWindow(){} openComposerFromMenu(){}
 createComposerMenuItem(e,t){return {label:e.name||t,toolTip:e.toolTip}}
 createContextMenu(e){
   const items=[];
   for(const section of e.sections){items.push({label:section.label,enabled:false});section.items.forEach((agent,index)=>items.push(this.createComposerMenuItem(agent,\`Agent \${index+1}\`)))}
   if(e.overflowUnreadCount)items.push({label:countLabel(e.overflowUnreadCount)});
   items.push({label:e.newComposerActionLabel,click:()=>this.trackEvent('tray.new_agent_clicked')});
   items.push({label:'Open Cursor',click:()=>{this.trackEvent('tray.open_cursor_clicked');this.focusOrOpenWindow()}});
   items.push({label:'Settings',click:()=>this.trackEvent('tray.settings_opened')});
   items.push({label:'Quit',click:()=>processApi.quit()});
   return nativeMenu.buildFromTemplate(items)
 }
}
globalThis.menu = new Tray().createContextMenu({sections:[{label:'Recent Agents',items:[{name:'Running',toolTip:'Running'},{name:'',toolTip:'Needs attention'}]}],overflowUnreadCount:12,newComposerActionLabel:'New Agent'});
`
describe('structural native tray localization', () => {
  it('translates dynamic labels, counts and statuses while preserving user agent names', () => {
    const result = patchTray(fixture, [])
    expect(result.strategy).toBe('structural')
    expect(result.missing).toEqual([])
    const context = { menu: [] as { label: string; toolTip?: string }[] }
    runInNewContext(result.text, context)
    expect(context.menu.map(item => item.label)).toEqual(['最近智能体', 'Running', '智能体 2', '12 条未读消息', '新建智能体', '打开 Cursor', '设置', '退出'])
    expect(context.menu[1]!.toolTip).toBe('运行中')
    expect(context.menu[2]!.toolTip).toBe('需要关注')
  })
  it('does not depend on minified helper names or the Quit receiver identifier', () => {
    const renamed = fixture.replaceAll('processApi', 'newMinifiedName').replaceAll('countLabel', 'otherCounter').replaceAll('nativeMenu', 'otherMenu')
    expect(patchTray(renamed, []).strategy).toBe('structural')
  })
  it('fails closed on ambiguous tray classes', () => {
    expect(() => patchTray(fixture + 'class OtherTray{createContextMenu(){this.trackEvent("tray.settings_opened");this.trackEvent("tray.open_cursor_clicked");return api.buildFromTemplate([])}}', [])).toThrow('不唯一')
  })
})
