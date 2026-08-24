export const RUNTIME_CONFIG_CHANGED = 'dsh-memory-evolve:runtime-config-changed'

/** Framework-free lifecycle for a conditional conversation tab. */
export function createTodoTabLifecycle(register) {
  let enabled = false
  let disposer
  const mount = () => {
    disposer?.()
    disposer = register()
  }
  return {
    setEnabled(next) {
      enabled = next === true
      if (!enabled) {
        disposer?.()
        disposer = undefined
      } else if (disposer === undefined) {
        mount()
      }
    },
    refresh() {
      if (enabled && disposer !== undefined) mount()
    },
    dispose() {
      enabled = false
      disposer?.()
      disposer = undefined
    },
    enabled: () => enabled,
  }
}
