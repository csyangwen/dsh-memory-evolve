/**
 * dsh-memory-evolve — Web GUI API.
 *
 * Serves the settings-panel data for the web half: the pending suggestion
 * queue (with approve/reject operations), the runtime-config view/update,
 * and the badge count. Registered dynamically through `ctx.inject` on the
 * `httpServer` service, so the plugin loads harmlessly on surfaces without
 * it (e.g. the TUI).
 *
 * Routes (prefix `/memory-evolve`):
 *   GET  /api/badge                       → { count }
 *   GET  /api/suggestions                 → { entries }
 *   POST /api/suggestions/approve         { indices }    → report
 *   POST /api/suggestions/reject          { indices }    → report
 *   POST /api/suggestions/approve-all                     → report
 *   POST /api/suggestions/reject-all                      → report
 *   GET  /api/config                      → { config }
 *   POST /api/config                      { patch }      → { config }
 *
 * Zero runtime dependencies (node:http only).
 *
 * @module dsh-memory-evolve/api
 */

import { URL } from 'node:url'
import { approveSuggestions, rejectSuggestions } from './review.js'

/** Read the JSON request body (capped). */
async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
}

/** Send a JSON response with the given status. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/** Parse `indices` from a request body; throws on invalid shapes. */
function parseIndices(body) {
  const raw = body?.indices
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error('indices must be a non-empty array of positive integers')
  }
  return raw
}

/**
 * Install the web API.
 * @param {object} ctx - a context with the `httpServer` service.
 * @param {object} deps - { store, queue, getRuntime, updateRuntime }.
 * @returns {() => void} the httpServer registration disposer.
 */
export function installApi(ctx, deps) {
  const { store, queue, getRuntime, updateRuntime } = deps

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      if (req.method === 'GET' && path === '/memory-evolve/api/badge') {
        sendJson(res, 200, { count: queue.read().length })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/suggestions') {
        sendJson(res, 200, { entries: queue.read() })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/config') {
        sendJson(res, 200, { config: getRuntime() })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/config') {
        const body = await readBody(req)
        const patch = body?.patch
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('patch must be an object')
        }
        sendJson(res, 200, { config: updateRuntime(patch) })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/approve') {
        const body = await readBody(req)
        const report = approveSuggestions(store, queue, parseIndices(body), undefined)
        sendJson(res, 200, report)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/reject') {
        const body = await readBody(req)
        const report = rejectSuggestions(queue, parseIndices(body))
        sendJson(res, 200, report)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/approve-all') {
        const all = Array.from({ length: queue.read().length }, (_, i) => i + 1)
        sendJson(res, 200, approveSuggestions(store, queue, all, undefined))
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/reject-all') {
        const all = Array.from({ length: queue.read().length }, (_, i) => i + 1)
        sendJson(res, 200, rejectSuggestions(queue, all))
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
    }
  }

  return ctx.httpServer.register({ kind: 'prefix', path: '/memory-evolve', handler })
}
