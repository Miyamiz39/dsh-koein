/**
 * dsh-koein, host half.
 *
 * This module deliberately imports no native speech code. The engines live in a
 * forked child (`engine-host.js`); here we only resolve configuration, serve
 * the browser transport, and relay frames. See `engine-host.js` for the DLL and
 * crash-isolation reasons — a native addon must never be able to abort the
 * harness process.
 * @module dsh-koein
 */
import { fileURLToPath } from 'node:url'
import { Config, resolveConfig } from './config.js'
import { describeStatus, modelStatus } from './models.js'
import { EngineSupervisor } from './engine-client.js'
import { injectIntoAgent } from './inject.js'
import { registerRoutes, send } from './server.js'

/** Stable cordis plugin name. */
export const name = 'koein'

/** Hard dependency: the browser HTTP carrier provides the socket route. */
export const inject = ['webServer']

export { Config }

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} config - validated row config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const status = modelStatus(resolved)
  const logger = ctx.logger

  if (!status.ok) {
    logger?.warn?.(
      `dsh-koein: models incomplete (${describeStatus(status)}); ` +
        `run "node ${fileURLToPath(new URL('../tools/download-models.mjs', import.meta.url))}" ` +
        'or set modelDir. The plugin stays mounted and reports the gap in its settings page.',
    )
  }

  /** @type {EngineSupervisor | null} */
  let supervisor = null
  /** @type {{ socket: object, connection: object } | null} */
  let active = null
  /** Wake words the engine actually accepted, once a child has started. */
  let keywordReport = { accepted: resolved.wakeWords, rejected: [] }

  /**
   * The state the settings page and each new connection reads.
   * @returns {object} JSON-serializable runtime state.
   */
  function getState() {
    const current = modelStatus(resolved)
    return {
      ok: current.ok,
      models: { kws: current.kws.missing, asr: current.asr.missing, dir: resolved.modelDir },
      wakeWords: keywordReport.accepted,
      rejectedWakeWords: keywordReport.rejected,
      injectMode: resolved.injectMode,
      autoSend: Boolean(resolved.autoSend),
      beep: Boolean(resolved.beep),
      listening: active !== null,
    }
  }

  /**
   * Start (or restart) the engine child, lazily.
   * @returns {EngineSupervisor} the supervisor.
   */
  function ensureSupervisor() {
    if (supervisor === null || supervisor.disposed) {
      supervisor = new EngineSupervisor({
        config: resolved,
        onEvent: (event) => {
          if (event.type === 'final') {
            void settle(event)
            return
          }
          if (active !== null) send(active.socket, event)
        },
        onError: (message) => {
          if (active !== null) send(active.socket, { type: 'error', message })
          else logger?.warn?.(`dsh-koein: ${message}`)
        },
      })
    }
    const engine = supervisor
    void engine
      .start()
      .then(() => {
        keywordReport = { accepted: engine.accepted, rejected: engine.rejected }
        if (keywordReport.rejected.length > 0) {
          logger?.warn?.(`dsh-koein: unusable wake words ${JSON.stringify(keywordReport.rejected)}`)
        }
        applyActiveMode()
      })
      .catch((error) => {
        logger?.warn?.(`dsh-koein: engine start failed: ${error.message}`)
      })
    return engine
  }

  /**
   * Arm the engine to match the active connection's requested modes.
   * Dictation wins over wake-word listening: they share one audio stream.
   */
  function applyActiveMode() {
    if (active === null || supervisor === null || !supervisor.alive) return
    const { connection } = active
    if (connection.dictate) supervisor.arm('dictate')
    else if (connection.wake) supervisor.arm('wake')
    else supervisor.disarm()
  }

  /**
   * Attach one browser connection as the active microphone.
   * @param {object} socket - the WebSocket.
   * @returns {object} the connection handle used by the route handlers.
   */
  function attach(socket) {
    if (active !== null) {
      // One microphone at a time: a new tab takes over from the old one.
      try {
        active.socket.close(4000, 'superseded')
      } catch {
        /* the old socket is already gone */
      }
      active = null
      supervisor?.reset()
    }

    const connection = {
      sessionId: '',
      wake: false,
      dictate: false,
      feed(data) {
        supervisor?.push(data)
      },
      frame(message) {
        if (message.type === 'hello') {
          connection.sessionId = String(message.sessionId || '')
          return
        }
        if (message.type === 'cancel') {
          supervisor?.cancel()
          return
        }
        if (message.type === 'mode') {
          connection.wake = message.wake === true
          connection.dictate = message.dictate === true
          applyActiveMode()
        }
      },
    }

    active = { socket, connection }
    const engine = ensureSupervisor()
    if (!engine.alive) send(socket, { type: 'state', phase: 'starting', mode: 'idle' })
    return connection
  }

  /**
   * Release a connection if it is still the active one.
   * @param {object} connection - the handle returned by attach.
   */
  function detach(connection) {
    if (active !== null && active.connection === connection) {
      active = null
      supervisor?.reset()
    }
  }

  /**
   * Publish a finished transcript and, in `agent` mode, deliver it here.
   * @param {{ text: string, reason: string }} event - the final event.
   */
  async function settle(event) {
    if (active === null) return
    const { socket, connection } = active
    const text = event.text
    if (!text) {
      send(socket, { ...event, injected: null })
      return
    }
    if (resolved.injectMode !== 'agent') {
      send(socket, { ...event, injected: 'composer' })
      return
    }
    if (!connection.sessionId) {
      send(socket, { ...event, injected: null, error: 'no session selected' })
      return
    }
    const outcome = await injectIntoAgent(ctx, connection.sessionId, text)
    if (active !== null && active.socket === socket) {
      send(socket, { ...event, injected: outcome.ok ? 'agent' : null, error: outcome.error })
    }
  }

  ctx.effect(() => registerRoutes(ctx, { getState, attach, detach }), 'dsh-koein: routes')

  ctx.effect(
    () => () => {
      active = null
      supervisor?.dispose()
      supervisor = null
    },
    'dsh-koein: engine supervisor',
  )

  logger?.info?.(`dsh-koein: mounted (${describeStatus(status)}), wake=${keywordReport.accepted.join(' / ')}`)
}
