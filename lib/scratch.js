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

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** scratch 文档大小上限（512 KiB，与记忆文件读取上限一致）。 */
export const SCRATCH_MAX_BYTES = 512 * 1024

/** scratch 文档路径（<memoryDir>/scratch.md）。 */
export function scratchPath(config) {
  return join(config.memoryDir, 'scratch.md')
}

/**
 * 读取 scratch 文档；文件不存在时返回空内容（首次使用无需预创建）。
 *
 * 读取侧防御（对应用户可经 reveal 通道用外部编辑器写入任意内容，绕过
 * writeScratch 的上限约束）：
 * - **大小上限**：超过 SCRATCH_MAX_BYTES 的文件拒绝读取（超大文件会让
 *   前端 textarea 卡顿，且读入后自动保存会被 writeScratch 拒绝，形成
 *   「一直 dirty、一直重试失败」的死循环）——返回 error 而非内容；
 * - **UTF-8 严格校验**：外部编辑器若以 UTF-16/GBK 等编码保存，宽松解码
 *   会得到乱码，用户一触发自动保存乱码就被当作 UTF-8 覆盖写回、原始
 *   内容不可逆丢失——非 UTF-8 文件拒绝读取，返回 error 提示手动处理。
 *
 * @param {object} config - resolved plugin config。
 * @returns {{ content: string, path: string, mtime: number | null, size: number, error: string | null }}
 */
export function readScratch(config) {
  const path = scratchPath(config)
  let buf
  let stat
  try {
    buf = readFileSync(path)
    stat = statSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return { content: '', path, mtime: null, size: 0, error: null }
    throw error
  }
  // 大小上限（字节）——外部写入的超大文件直接拒绝，见上方模块注释。
  if (stat.size > SCRATCH_MAX_BYTES) {
    return {
      content: '', path, mtime: stat.mtimeMs, size: stat.size,
      error: `文件超过大小上限（${stat.size} 字节 > ${SCRATCH_MAX_BYTES} 字节），已拒绝读取；请用系统工具手动处理该文件`,
    }
  }
  // UTF-8 严格解码（fatal: true 遇非法字节抛错）——非 UTF-8 内容拒绝读取。
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return {
      content: '', path, mtime: stat.mtimeMs, size: stat.size,
      error: '文件不是有效的 UTF-8 编码（可能被外部编辑器以其他编码保存），为避免乱码覆盖已拒绝读取；请用系统工具将文件转为 UTF-8 后重试',
    }
  }
  return { content, path, mtime: stat.mtimeMs, size: stat.size, error: null }
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
  // 清理同名旧残留（上次写入中途崩溃可能留下 .tmp.<pid>；同名覆盖即可，
  // 不清理会在 memoryDir 留下垃圾文件）。
  const tmpPath = `${path}.tmp.${process.pid}`
  try { unlinkSync(tmpPath) } catch { /* 无残留，忽略 */ }
  writeFileSync(tmpPath, content, 'utf8')
  renameSync(tmpPath, path)
  const stat = statSync(path)
  return { ok: true, path, mtime: stat.mtimeMs, size: stat.size, chars: content.length }
}
