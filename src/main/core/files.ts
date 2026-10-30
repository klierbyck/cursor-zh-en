import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')
export const checksum = (data: Uint8Array): string => createHash('sha256').update(data).digest('base64').replace(/=+$/, '')

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function readOptional(path: string): Promise<Buffer | null> {
  try { return await readFile(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function fileHash(path: string): Promise<string | null> {
  const bytes = await readOptional(path)
  return bytes === null ? null : sha256(bytes)
}

export function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

// Reject existing symlinks/junctions in every component, including ancestor directories.
export async function assertSafePath(root: string, target: string): Promise<void> {
  root = resolve(root)
  target = resolve(target)
  if (!within(root, target)) throw new Error(`拒绝访问白名单目录之外的路径：${target}`)
  let cursor = target
  for (;;) {
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new Error(`拒绝通过符号链接或 junction 写入：${cursor}`)
      const canonical = await realpath(cursor)
      if (resolve(canonical).toLowerCase() !== resolve(cursor).toLowerCase()) {
        throw new Error(`路径已被重定向：${cursor}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

export async function atomicWrite(path: string, data: Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.cursorzh-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', mode)
    try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    // Never unlink the destination first: a failed replacement must leave the old file intact.
    await rename(temporary, path)
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, Buffer.from(JSON.stringify(value, null, 2) + '\n'))
}

export async function ensureWritable(path: string): Promise<void> {
  let parent = dirname(path)
  while (!(await exists(parent))) parent = dirname(parent)
  await access(parent, constants.W_OK)
}

export async function metadata(path: string): Promise<{ mode: number; mtime: number; atime: number } | undefined> {
  if (!(await exists(path))) return undefined
  const info = await stat(path)
  return { mode: info.mode & 0o777, mtime: info.mtimeMs, atime: info.atimeMs }
}

export async function restoreTimes(path: string, info?: { atime: number; mtime: number }): Promise<void> {
  if (info) await utimes(path, info.atime / 1000, info.mtime / 1000)
}
