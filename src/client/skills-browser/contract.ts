/**
 * Shared wire types for the skills-manager client. The node half serves these
 * shapes over `/skills-manager/api/*`; the UI consumes them verbatim.
 */

/** Resource base of a skill (mirrors the host-side SkillResourceBase). */
export type SkillResourceBase =
  | { kind: 'directory'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'opaque'; description: string }

/** One skill summary from GET /api/skills. */
export interface SkillSummary {
  name: string
  description: string
  whenToUse: string | null
  source: string
  provider: string
  invocable: boolean
  /** User-disabled through this plugin (shadowed from the model catalog). */
  disabled: boolean
  /** Protected system skill (project source) — cannot be disabled. */
  protected: boolean
  resourceBase: SkillResourceBase | null
  path: string | null
}

/** POST /api/skills/disable | /enable response. */
export interface ToggleResponse {
  ok: boolean
  name: string
  disabled: boolean
}

/** One user-managed custom skill directory from GET /api/dirs. */
export interface DirInfo {
  path: string
  /** Whether the directory currently exists on disk. */
  exists: boolean
  /** Number of skills discovered inside (0 when missing/invalid). */
  skillCount: number
}

/** GET /api/dirs response. */
export interface DirsResponse {
  dirs: DirInfo[]
}

/** POST/DELETE /api/dirs response. */
export interface DirMutationResponse {
  ok: boolean
  path?: string
  error?: string
}

/** GET /api/skills response. */
export interface SkillsResponse {
  skills: SkillSummary[]
  roots: string[]
  cwd: string | null
}

/** One directory entry from GET /api/browse. */
export interface FsEntry {
  name: string
  type: 'dir' | 'file'
  size: number | null
  mtime: number
}

/** GET /api/browse response. */
export interface BrowseResponse {
  root: string
  path: string
  entries: FsEntry[]
}

/** GET /api/read response. */
export interface ReadResponse {
  path: string
  content: string
  size: number
  mtime: number
}

/** PUT /api/write response. */
export interface WriteResponse {
  ok: boolean
  path: string
  size: number
  mtime: number
}

/** Error envelope returned by the API. */
export interface ApiError {
  error: string
}

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** The component's props: a wide translate function bound to the `skills-manager` namespace. */
export interface SkillsBrowserProps {
  /** Translate a key of the `skills-manager` dictionary (fallback `common`). */
  t: Translate
}
