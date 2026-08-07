/**
 * COI 任务模板 — 常用任务预设，一键发起（GUI/命令/API 通用）。
 * 模板字段：{ id, name, adapterId?, prompt, scope?, note? }
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 内置默认模板（用户可覆盖同 id）。 */
export const BUILTIN_TEMPLATES = [
  { id: 'review-code', name: 'Review 代码', adapterId: 'kimi', prompt: '请 review 当前项目的代码，列出最需要修复的三个问题（附理由与修复建议），并输出简要报告。' },
  { id: 'fix-tests', name: '修复测试', adapterId: 'codex', prompt: '运行项目测试，定位失败原因，给出最小修复方案并实施，最后运行测试验证。' },
  { id: 'summarize-logs', name: '总结日志', adapterId: 'grok', prompt: '总结下列日志/报错，分类并给出处理建议。' },
  { id: 'architecture-analysis', name: '架构分析', adapterId: 'hermes', prompt: '分析当前项目的架构：模块划分、依赖关系、潜在问题与改进建议。' },
]

/**
 * @param {string} file - templates.json 的绝对路径。
 */
export class TemplateStore {
  constructor(file) {
    this.file = file
    this.custom = this.#load()
    this.byId = new Map()
    for (const t of BUILTIN_TEMPLATES) this.byId.set(t.id, t)
    for (const [id, t] of Object.entries(this.custom)) this.byId.set(id, t)
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw error
    }
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(this.custom, null, 2) + '\n')
    renameSync(tmp, this.file)
  }

  list() {
    return [...this.byId.values()]
  }

  get(id) {
    return this.byId.get(id)
  }

  upsert(def) {
    const id = String(def.id ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error('id 必须是小写字母数字连字符')
    if (typeof def.name !== 'string' || def.name.trim() === '') throw new Error('name 不能为空')
    if (typeof def.prompt !== 'string' || def.prompt.trim() === '') throw new Error('prompt 不能为空')
    const clean = {
      id,
      name: def.name.trim(),
      adapterId: def.adapterId ?? undefined,
      prompt: def.prompt.trim(),
      scope: def.scope ?? undefined,
      note: def.note ?? undefined,
    }
    this.custom[id] = clean
    this.#save()
    this.byId.set(id, clean)
    return clean
  }

  remove(id) {
    if (id in this.custom) {
      delete this.custom[id]
      this.#save()
      this.byId.delete(id)
      return true
    }
    return false
  }
}
