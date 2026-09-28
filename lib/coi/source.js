/**
 * 注入消息的来源标识（会话格式 v4 的 producer-owned source kind）。
 *
 * v4 起每条持久化消息的 `source.kind` 必须由生产者自报，canonical 形态是
 * `plugin:<包名>`；已退役的写法是裸字符串 `kind: 'plugin'` 再并列一个 plugin
 * 字段，会被直接拒绝：
 *
 *   format v4 message requires a producer-owned source kind
 *
 * （扫描脚本按「`kind: 'plugin'` 后紧跟逗号」判定退役写法，本注释刻意不写成
 *   对象字面量，避免扫描误报——见 tests/injection-source-kind.test.js。）
 *
 * 校验在 `@deepseek-ai/dsh-session-format-v3-to-v4` 的 message-sources 模块
 * （源码 `assertV4MessageSources`，编译产物 `lib/index.js`），持久化侧同规则。
 * 触发时机是**会话认领该事件时**，所以症状是"注入发生的那一轮整轮失败"，
 * 而不是注入本身报错；重启只是清空了公告板基线/节流状态，过一阵复发。
 *
 * 同包的 `producerKind()` 把未知生产者映射成 `plugin:${plugin}` 并删除
 * `plugin` 字段，本常量与之一致——从 v3 迁移过来的历史注入也是这个形态。
 *
 * 本插件有 4 处注入点，全部引用本常量，防止再次漂移：
 *   - `coi/index.js` `deliver()`：会话广播 + COI 通知（inject / followup）
 *   - `coi/scheduler.js` `#deliver()`：COI 任务状态变更通知
 *   - `coi/ws-coord.js` `userMessage()`：写冲突警告（additionalContexts）
 *   - `coi/ws-coord.js` 公告板：工作区活动状态更新
 */
export const PLUGIN_SOURCE_KIND = 'plugin:dsh-memory-evolve'
