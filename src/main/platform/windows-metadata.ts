import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`

async function powershell(command: string): Promise<string> {
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; ${command}`, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 })
  return result.stdout.trim()
}

export async function captureWindowsAcls(paths: string[]): Promise<Record<string, string>> {
  if (process.platform !== 'win32' || !paths.length) return {}
  const command = `$result=@{}; foreach($p in @(${paths.map(quote).join(',')})) { $result[$p]=(Get-Acl -LiteralPath $p).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access) }; $result | ConvertTo-Json -Compress`
  return JSON.parse(await powershell(command))
}

export async function writeWindowsAcl(path: string, sddl?: string): Promise<void> {
  if (process.platform !== 'win32' || !sddl) return
  await powershell(`$acl=Get-Acl -LiteralPath ${quote(path)}; $acl.SetSecurityDescriptorSddlForm(${quote(sddl)}, [System.Security.AccessControl.AccessControlSections]::Access); Set-Acl -LiteralPath ${quote(path)} -AclObject $acl`)
}
