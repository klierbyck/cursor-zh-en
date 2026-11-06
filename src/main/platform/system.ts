import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { open, readFile, rm } from 'node:fs/promises'
import { assertSafePath, atomicWrite, fileHash, restoreTimes, sha256 } from '../core/files'
import { captureWindowsAcls, writeWindowsAcl } from './windows-metadata'
import type { Io, Transaction } from '../core/transaction'

const exec = promisify(execFile)

export async function installationLock(store: string, identity: string): Promise<() => Promise<void>> {
  const path = join(store, `${identity}.lock`)
  await assertSafePath(store, path)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync() } finally { await handle.close() }
      return async () => { await rm(path, { force: true }) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = JSON.parse(await readFile(path, 'utf8'))
      if (!Number.isSafeInteger(existing.pid) || existing.pid < 1) throw new Error('操作锁损坏，请先检查备份目录')
      try {
        process.kill(existing.pid, 0)
        throw new Error('另一个汉化进程正在操作此安装，请稍后重试')
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe
        await rm(path)
      }
    }
  }
  throw new Error('无法取得安装操作锁')
}

const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`

async function elevateWindows(helper: string, transaction: Transaction, action: 'apply' | 'restore'): Promise<void> {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${helper}"`, '-Manifest', `"${join(transaction.directory, 'manifest.json')}"`, '-Action', action]
  const command = `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath "$PSHOME\\powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList @(${args.map(literal).join(',')}); exit $p.ExitCode`
  try {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 180000 })
  } catch {
    throw new Error('管理员授权被取消或受限写入失败。已保留事务和备份，请查看恢复状态后重试。')
  }
}

// The GUI stays unelevated. Only fixed app-resource writes are delegated on EACCES/EPERM.
export function privilegedIo(transaction: Transaction, resourcesRoot: string): Io {
  let elevatedAction: string | undefined
  const appEntry = (path: string) => transaction.manifest.entries.find(entry => entry.scope === 'app' && join(transaction.installation.appRoot, entry.path) === path)
  const permissionDenied = (error: unknown) => transaction.installation.platform === 'win32' && ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')
  async function elevate(action: 'apply' | 'restore'): Promise<void> {
    await transaction.save()
    await elevateWindows(join(resourcesRoot, 'elevated-windows.ps1'), transaction, action)
    elevatedAction = action
  }
  async function delegated(path: string, bytes: Buffer | null, mode?: number): Promise<void> {
    const entry = appEntry(path)
    const action = transaction.manifest.state === 'restoring' ? 'restore' : 'apply'
    if (entry && elevatedAction === action) {
      const expected = bytes === null ? null : sha256(bytes)
      if (await fileHash(path) !== expected) throw new Error('提权批量写入验证失败')
      return
    }
    try {
      if (bytes === null) await rm(path, { force: true })
      else await atomicWrite(path, bytes, mode)
    } catch (error) {
      if (!entry || !permissionDenied(error)) throw error
      await elevate(action)
      const expected = bytes === null ? null : sha256(bytes)
      if (await fileHash(path) !== expected) throw new Error('提权后的文件校验失败')
    }
  }
  return {
    write: (path, bytes, mode) => delegated(path, bytes, mode),
    remove: path => delegated(path, null),
    acls: captureWindowsAcls,
    times: async (path, info) => {
      if (appEntry(path) && elevatedAction === 'restore') return
      try { await restoreTimes(path, info) } catch (error) {
        if (!appEntry(path) || !permissionDenied(error) || transaction.manifest.state !== 'restoring') throw error
        await elevate('restore')
      }
    },
    security: async (path, sddl) => {
      const current = await captureWindowsAcls([path])
      if (current[path] !== sddl) await writeWindowsAcl(path, sddl)
      const verified = await captureWindowsAcls([path])
      if (verified[path] !== sddl) throw new Error('文件访问权限恢复验证失败')
    }
  }
}
