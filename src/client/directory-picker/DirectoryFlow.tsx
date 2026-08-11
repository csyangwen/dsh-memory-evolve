/**
 * 本机感知目录选择 flow —— directoryFlow slot occupant（二合一）。
 *
 * 解决的问题（2026-08-11 用户拍板集成进 dsh-memory-evolve）：
 * DSH 官方 directory-picker-auto 在 `dsh web --host 0.0.0.0` 启动时（为手机
 * 局域网访问）强制退化为网页内浏览弹窗（browse），本机 Mac 浏览器也因此
 * 失去系统 Finder 文件夹选择框。本 occupant 替代官方 browse/native 后端的
 * 位置（patch 中 disabled 官方 directory-picker 行），每次打开时按两因素
 * 判定选择交互：
 *
 *   1. 功能开关 directoryPickerNative（设置 Tab「综合」小开关，localStorage
 *      实时读取，切换即时生效）：关 → 一律网页弹窗（等价官方 browse 行为）；
 *   2. 浏览器地址是否本机 loopback（localhost / 127.x / [::1]）：开且本机 →
 *      走系统原生选择框（macOS osascript Finder / Windows IFileOpenDialog /
 *      Linux zenity/kdialog，由 host 端 ctx.workspaces.pickDirectory 提供）；
 *      开但远程（手机、其他电脑经局域网 IP/域名访问）→ 仍走网页弹窗
 *      （远程浏览器看不到服务器屏幕上的原生框）。
 *
 * 判定信号选择依据（调研文档 docs-local/DSH目录选择机制-调研-20260811.md）：
 * location.hostname 是本机判定的最稳信号——访问 127.0.0.1/localhost 的
 * 浏览器必然跑在服务器本机；远程设备访问该地址指向它自己，连不到本机。
 * 不依赖 UA（用户在其他电脑上访问也不弹 Finder）、不依赖服务端
 * remoteAddress（frp 反向代理场景下手机经 frpc 本地转发会误判本机）。
 *
 * 双路径实现分别对齐官方 NativeDirectoryFlow（renderless pick）与
 * BrowseDirectoryFlow（DirectoryBrowser 弹窗）的语义：open 上升沿恰好
 * 执行一次 pick（armed ref 防重入）、adoption 期间 busy、失败走 owner
 * 错误面；浏览弹窗的失败在弹窗内部呈现，不驱动 owner.onError。
 */
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the owner conversation of the directory-flow holes.
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DirectoryBrowser } from './DirectoryBrowser.tsx'
import { readFeatures } from '../ui-settings-features.ts'

/** 注入面：宿主侧目录能力（bound in apply 的闭包，经 slots.register 的 inject 传入）。 */
export interface SmartDirectoryFlowInjected {
  /** 打开 host 端系统原生单目录选择框（macOS osascript choose folder 等）。 */
  pick: () => Promise<string | null>
  /** 列出一个目录层级（缺省路径 = host 主目录）；signal 中止被取代的扫描。 */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** 在既有父目录下创建一个子目录。 */
  createDirectory: (path: string, name: string) => Promise<string>
  /** 本命名空间的翻译函数。 */
  t: (key: string) => string
}

/**
 * 浏览器当前地址是否指向本机 loopback 权威。
 * 与官方 client-connection 的 isLoopbackHostname 同语义（localhost / [::1] /
 * 127/8 任意 IPv4），浏览器侧直接读地址栏，无需服务端往返。
 * @returns true=浏览器与服务器同机（可弹系统原生框）。
 */
export function isLoopbackLocation(): boolean {
  const hostname = window.location.hostname
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 二合一 flow occupant：open 时按「开关 + 本机判定」选择交互路径。
 * - 原生路径（renderless）：open 上升沿恰好一次 pick；本机判定与开关在
 *   open 时刻实时读取，切换即时生效（无需刷新/重启）。
 * - 浏览路径：渲染 DirectoryBrowser 弹窗（复用官方组件，dp- 前缀样式）。
 * @param props - owner 会话 + 注入的目录能力。
 * @returns 原生路径渲染 null（宿主端弹系统框）；浏览路径渲染弹窗元素。
 */
export function SmartDirectoryFlow(props: DirectoryFlowOwnerProps & SmartDirectoryFlowInjected): ReactElement | null {
  const { open } = props

  // ---- 路径判定（open 时刻实时）：开关开 + 本机地址 → 原生框 ----
  const native = readFeatures().directoryPickerNative && isLoopbackLocation()

  // ---- 原生路径（renderless pick）状态机：对齐官方 NativeDirectoryFlow ----
  // 仅在 native 判定成立时 arm——浏览路径下绝不触发原生 pick（否则弹窗一
  // 打开就误提交）。browse→native 切换时重新 arm（armed 随 native 重置）。
  const armed = useRef(false)
  // 回调走 ref：settled 结果报告给 owner 的最新 handlers，而非 open 时捕获的旧 props。
  const outcome = useRef(props)
  outcome.current = props
  // HMR 替换 occupant 时丢弃未落地的结果：已打开的原生框仍存活于宿主端显示，
  // 其答案落在替换实例的 still-open 请求上（重新 arm）。
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (!native || !open) {
      armed.current = false
      return
    }
    if (armed.current) return
    armed.current = true
    props.pick().then(
      (path) => {
        if (!alive.current) return
        if (path === null) outcome.current.onCancel(); else outcome.current.onPicked(path)
      },
      (reason: unknown) => {
        if (!alive.current) return
        outcome.current.onError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }, [open, native, props.pick])

  if (native) return null
  return (
    <DirectoryBrowser
      open={open}
      busy={props.busy}
      listDirectory={props.listDirectory}
      createDirectory={props.createDirectory}
      t={props.t}
      onOpen={props.onPicked}
      onClose={props.onCancel}
    />
  )
}
