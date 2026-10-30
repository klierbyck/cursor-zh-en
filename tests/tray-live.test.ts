import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { patchTray } from '../src/main/patches/tray'

// Read-only opt-in validation: never executes or modifies installed program code.
it.skipIf(!process.env.CURSORZH_AUDIT_INSTALL)('matches the installed native tray structurally', async () => {
  const source = await readFile(join(process.env.CURSORZH_AUDIT_INSTALL!, 'resources/app/out/main.js'), 'utf8')
  const result = patchTray(source, [])
  expect(result.strategy).toBe('structural')
  expect(result.missing).toEqual([])
  expect(result.count).toBeGreaterThanOrEqual(10)
  expect(result.text).toContain('显示数量')
  expect(result.text).toContain('条未读消息')
}, 30000)
