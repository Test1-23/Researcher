/**
 * 文件系统 run 仓库。
 *
 * 每次运行一个目录，产物 append-only 写入：任何阶段失败都不会抹掉已完成的工作，
 * 便于排查、续跑以及对比两次运行。
 */

import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ResearcherError } from './errors.ts'
import type { Artifact, RunStore } from './types.ts'

/** 扩展名 → 格式名的映射，用于产物列表展示。 */
const FORMAT_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.md': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.txt': 'text',
}

/** 落地到磁盘的 run 仓库。 */
export class FileRunStore implements RunStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = resolve(dir)
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  async writeText(relPath: string, content: string, format?: string): Promise<Artifact> {
    const absolute = this.resolveSafe(relPath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
    return {
      path: toPosix(relPath),
      format: format ?? FORMAT_BY_EXTENSION[extname(relPath).toLowerCase()] ?? 'text',
      bytes: Buffer.byteLength(content, 'utf8'),
    }
  }

  async writeJson(relPath: string, value: unknown): Promise<Artifact> {
    return this.writeText(relPath, `${JSON.stringify(value, null, 2)}\n`, 'json')
  }

  async appendLine(relPath: string, line: string): Promise<void> {
    const absolute = this.resolveSafe(relPath)
    await mkdir(dirname(absolute), { recursive: true })
    await appendFile(absolute, `${line}\n`, 'utf8')
  }

  async list(): Promise<readonly Artifact[]> {
    const found: Artifact[] = []
    await walk(this.dir, this.dir, found)
    return found.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** 把相对路径解析到 run 目录内，拒绝越界路径。 */
  private resolveSafe(relPath: string): string {
    const absolute = resolve(this.dir, relPath)
    const rel = relative(this.dir, absolute)
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
      throw new ResearcherError(`产物路径越界：${relPath}`, 'INTERNAL')
    }
    return absolute
  }
}

/** 递归收集产物。 */
async function walk(root: string, current: string, out: Artifact[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) {
      await walk(root, absolute, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = await stat(absolute)
      const rel = toPosix(relative(root, absolute))
      out.push({
        path: rel,
        format: FORMAT_BY_EXTENSION[extname(entry.name).toLowerCase()] ?? 'text',
        bytes: info.size,
      })
    } catch {
      /* 文件在遍历过程中消失就跳过 */
    }
  }
}

/** 统一成正斜杠，让产物路径在界面上跨平台一致。 */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}
