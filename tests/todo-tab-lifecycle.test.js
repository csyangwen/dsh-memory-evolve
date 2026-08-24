import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTodoTabLifecycle } from '../src/client/todo-tab-lifecycle.js'

test('todo tab lifecycle: disabled state disposes immediately and badge refresh cannot revive it', () => {
  let registrations = 0
  let disposals = 0
  const lifecycle = createTodoTabLifecycle(() => {
    registrations += 1
    return () => { disposals += 1 }
  })

  lifecycle.setEnabled(true)
  lifecycle.setEnabled(false)
  lifecycle.setEnabled(false)
  lifecycle.refresh()
  assert.equal(registrations, 1)
  assert.equal(disposals, 1)

  lifecycle.setEnabled(true)
  assert.equal(registrations, 2)
  lifecycle.dispose()
  assert.equal(disposals, 2)
})
