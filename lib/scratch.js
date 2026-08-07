/**
 * dsh-memory-evolve — 临时信息（scratch pad）存储。
 *
 * 一个持久化的 Markdown 便签文档：<memoryDir>/scratch.md。用户把临时的
 * 想法/随手记写在这里，最终会迁移到别处或删除——但内容本身要跨
 * DSH web 重启保留（存在 ~/.dsh/memories 下，随记忆目录一起持久化）。
 *
 * 与结构化记忆文件（§ 分隔）无关：scratch.md 是自由文本，用户可以随意
 * 编辑，不会破坏任何解析格式。读写均做大小上限与原子写保护。
 *
 * @module dsh-memory-evolve/scratch
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** scratch 文档大小上限（512 KiB，与记忆文件读取上限一致）。 */
export const SCRATCH_MAX_BYTES = 512 * 1024

/** scratch 文档路径（<memoryDir>/scratch.md）。 */
export function scratchPath(config) {
  return join(config.memoryDir, 'scratch.md')
}

/**
 * 读取 scratch 文档；文件不存在时返回空内容（首次使用无需预创建）。
 * @param {object} config - resolved plugin config。
 * @returns {{ content: string, path: string, mtime: number | null, size: number }}
 */
export function readScratch(config) {
  const path = scratchPath(config)
  try {
    const content = readFileSync(path, 'utf8')
    const stat = statSync(path)
    return { content, path, mtime: stat.mtimeMs, size: stat.size }
  } catch (error) {
    if (error?.code === 'ENOENT') return { content: '', path, mtime: null, size: 0 }
    throw error
  }
}

/**
 * 写入 scratch 文档（原子写：先写临时文件再 rename）。空内容也合法
 * （清空便签）；超过上限抛错。
 * @param {object} config - resolved plugin config。
 * @param {string} content - 完整的新内容。
 * @returns {{ ok: true, path: string, mtime: number, size: number, chars: number }}
 */
export function writeScratch(config, content) {
  if (typeof content !== 'string') throw new Error('内容必须是字符串')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > SCRATCH_MAX_BYTES) {
    throw new Error(`内容超过上限（${SCRATCH_MAX_BYTES} 字节）`)
  }
  const path = scratchPath(config)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp.${process.pid}`, content, 'utf8')
  renameSync(`${path}.tmp.${process.pid}`, path)
  const stat = statSync(path)
  return { ok: true, path, mtime: stat.mtimeMs, size: stat.size, chars: content.length }
}
