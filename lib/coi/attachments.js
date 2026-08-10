/**
 * COI 图片附件解析 — de_coi_dispatch attachments 参数的来源归一化。
 *
 * 工具/API 传入的 attachments 是「原始描述」（与 de_channel_send 的附件
 * 契约同风格），每条来源三选一：
 *   - path          本地文件绝对路径（直接可用，校验存在性与图片扩展名）
 *   - url           http(s) 远程地址（下载到 COI 附件目录再传）
 *   - attachmentId  引用本会话消息里的图片（浏览器输入框贴图，DSH 新快照
 *                   的 ImageBlock 持久附件层）：先从发起会话的 user/message
 *                   事件里解析出完整 ImageAttachmentRef（readImage 校验
 *                   digest 需要 bytes/width/height 完整元数据），再经
 *                   attachments 服务读字节落盘
 *
 * 解析结果是「本地文件数组」，交给调度器按适配器的 image 配置注入：
 *   flag 模式（codex -i / hermes --image）：直接插 CLI 参数；
 *   prompt 模式（kimi / grok）：图片绝对路径写进任务文本，让 agent 自己
 *   调读图工具。
 * 不支持的适配器（zcode/qoder/dsh 等无 image 配置）在 dispatch 时明确报错。
 *
 * 运行环境说明：attachmentId 来源依赖 DSH 260810 快照的 attachments 服务
 * 与 ImageBlock 机制——进程未重启时服务不存在，会如实报错提示换 path/url
 * 或重启后重试；path/url 来源无此依赖，随时可用。
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/** 单次任务最多携带的图片数量（防止参数/体积失控）。 */
export const MAX_ATTACHMENTS = 5

/** 图片扩展名白名单（按文件名粗判；内容校验交给 COI 端读图）。 */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i

/** 从文件名/URL 推断扩展名；无法推断时默认 .png。 */
function extFrom(value) {
  const clean = String(value ?? '').split('?')[0].split('#')[0]
  const ext = extname(clean)
  return ext && IMAGE_EXT_RE.test(ext) ? ext.toLowerCase() : '.png'
}

/**
 * 从发起会话的事件流里找匹配 attachmentId 的 ImageBlock 完整引用。
 * ImageBlock 形状（DSH 260810 快照）：{ type:'image', attachment:
 * ImageAttachmentRef }，ref 含 attachmentId/mediaType/bytes/width/height——
 * attachments 服务的 readImage 校验 digest 需要完整元数据，所以不能只拿
 * attachmentId 一个字段就调用。事件不可读/未找到返回 null（调用方报错）。
 * @param {object | undefined} agentsService - cordis agents 服务（可选）。
 * @param {string | undefined} sessionId - 发起会话 id。
 * @param {string} attachmentId - 要匹配的图片引用 id。
 * @returns {object | null} 完整 ImageAttachmentRef，找不到返回 null。
 */
function findImageRef(agentsService, sessionId, attachmentId) {
  if (!agentsService?.get || !sessionId) return null
  try {
    const agent = agentsService.get(sessionId)
    const events = agent?.session?.events
    if (!Array.isArray(events)) return null
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      const content = event?.data?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const ref = block?.attachment
        if (block?.type !== 'image' || ref?.attachmentId !== attachmentId) continue
        // 完整 ref 判断：readImage 校验需要这几个字段（bytes/width/height
        // 参与 digest 比对）；不完整则视为未找到（下方走报错路径）
        if (typeof ref.mediaType === 'string' && typeof ref.bytes === 'number') return ref
      }
    }
  } catch {
    /* agents 服务不可用/事件不可读：视为未找到 */
  }
  return null
}

/**
 * 把原始附件描述解析成本地文件数组（每个附件 → 一条 {localPath, name,
 * caption, source, original}）。任一附件非法即整体失败（不产生半成品任务）。
 * @param {unknown} attachments - 原始附件数组（undefined/null = 无附件）。
 * @param {object} opts - 解析环境：
 *   outputDir        附件落盘目录（coiDataDir/attachments，自动创建）
 *   tag              文件名前缀（通常=taskId，保证并发任务不撞名）
 *   attachmentsStore attachments 服务（可选；attachmentId 来源必需）
 *   agentsService    agents 服务（可选；attachmentId 来源解析完整 ref 用）
 *   sessionId        发起会话 id（attachmentId 来源在哪个会话里找 ImageBlock）
 * @returns {Promise<{ok:true, files:object[]}|{ok:false, message:string}>}
 */
export async function resolveAttachments(attachments, { outputDir, tag, attachmentsStore, agentsService, sessionId } = {}) {
  if (attachments === undefined || attachments === null) return { ok: true, files: [] }
  if (!Array.isArray(attachments)) return { ok: false, message: 'attachments 必须是数组' }
  if (attachments.length > MAX_ATTACHMENTS) {
    return { ok: false, message: `图片附件最多 ${MAX_ATTACHMENTS} 张（收到 ${attachments.length} 张）` }
  }
  const files = []
  for (let i = 0; i < attachments.length; i++) {
    const item = attachments[i]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `第 ${i + 1} 个附件必须是对象` }
    }
    const kind = String(item.kind ?? 'image').trim()
    if (kind !== 'image') {
      return { ok: false, message: `第 ${i + 1} 个附件类型 "${kind}" 暂不支持（当前仅支持图片 image）` }
    }
    // 来源三选一校验
    const pathSrc = item.path !== undefined && item.path !== null ? String(item.path).trim() : ''
    const urlSrc = item.url !== undefined && item.url !== null ? String(item.url).trim() : ''
    const idSrc = item.attachmentId !== undefined && item.attachmentId !== null ? String(item.attachmentId).trim() : ''
    const chosen = [pathSrc, urlSrc, idSrc].filter(Boolean)
    if (chosen.length === 0) {
      return { ok: false, message: `第 ${i + 1} 个附件缺少来源（path / url / attachmentId 三选一）` }
    }
    if (chosen.length > 1) {
      return { ok: false, message: `第 ${i + 1} 个附件来源只能三选一（path / url / attachmentId）` }
    }
    const caption = String(item.caption ?? '').trim() || undefined
    const fileName = String(item.fileName ?? '').trim() || undefined
    mkdirSync(outputDir, { recursive: true })

    if (pathSrc) {
      // 来源一：本地路径——校验存在 + 图片扩展名，直接用原路径（不复制）
      try {
        statSync(pathSrc)
      } catch {
        return { ok: false, message: `第 ${i + 1} 个附件本地文件不存在：${pathSrc}` }
      }
      if (!IMAGE_EXT_RE.test(pathSrc)) {
        return { ok: false, message: `第 ${i + 1} 个附件不是图片文件（仅支持 png/jpg/jpeg/webp/gif）：${pathSrc}` }
      }
      files.push({
        localPath: pathSrc,
        name: fileName ?? basename(pathSrc),
        caption,
        source: 'path',
        original: pathSrc,
      })
    } else if (urlSrc) {
      // 来源二：http(s) URL——下载到附件目录（30s 超时，失败即整体报错）
      if (!/^https?:\/\//i.test(urlSrc)) {
        return { ok: false, message: `第 ${i + 1} 个附件 url 必须是 http(s) 地址` }
      }
      const target = join(outputDir, `${tag}-${i + 1}${extFrom(fileName ?? urlSrc)}`)
      let buffer
      try {
        const res = await fetch(urlSrc, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) {
          return { ok: false, message: `第 ${i + 1} 个附件下载失败（HTTP ${res.status}）：${urlSrc}` }
        }
        buffer = Buffer.from(await res.arrayBuffer())
      } catch (error) {
        return { ok: false, message: `第 ${i + 1} 个附件下载失败：${error?.message ?? String(error)}` }
      }
      writeFileSync(target, buffer)
      files.push({
        localPath: target,
        name: fileName ?? (basename(urlSrc.split('?')[0]) || `image-${i + 1}${extname(target)}`),
        caption,
        source: 'url',
        original: urlSrc,
      })
    } else {
      // 来源三：会话图片引用（attachmentId）——新快照机制，服务不可用如实报错
      if (!attachmentsStore || typeof attachmentsStore.readImage !== 'function') {
        return {
          ok: false,
          message: `第 ${i + 1} 个附件引用会话图片需要 DSH 新快照运行时的 attachments 服务（当前进程不支持），请改用 path/url 来源，或重启 DSH 后重试`,
        }
      }
      // 先从发起会话事件解析完整 ref（readImage 校验需要 bytes/width/height）
      const ref = findImageRef(agentsService, sessionId, idSrc)
      if (!ref) {
        return {
          ok: false,
          message: `第 ${i + 1} 个附件在发起会话中未找到匹配的图片（attachmentId=${idSrc}）——图片须来自当前会话消息（浏览器输入框贴图）`,
        }
      }
      let stored
      try {
        stored = await attachmentsStore.readImage(ref)
      } catch (error) {
        return { ok: false, message: `第 ${i + 1} 个附件读取会话图片失败：${error?.message ?? String(error)}` }
      }
      const data = stored?.data
      if (!data) return { ok: false, message: `第 ${i + 1} 个附件读取会话图片失败：未返回数据` }
      const mediaType = stored?.ref?.mediaType ?? ref.mediaType
      const ext = `.${(mediaType.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`
      const target = join(outputDir, `${tag}-${i + 1}${ext}`)
      writeFileSync(target, Buffer.from(data))
      files.push({
        localPath: target,
        name: fileName ?? ref.name ?? `image-${i + 1}${ext}`,
        caption,
        source: 'attachmentId',
        original: idSrc,
      })
    }
  }
  return { ok: true, files }
}
