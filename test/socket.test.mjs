/**
 * Transport integration test: mount the real plugin with a stand-in cordis
 * context, serve its real routes over a real HTTP server, and drive it with a
 * real WebSocket client carrying real PCM.
 *
 * This is the closest thing to the browser path that runs without a browser: it
 * covers route registration, the upgrade handshake, the frame protocol, the
 * state machine over the wire, the forked engine child, and both injection
 * modes.
 */
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import { apply } from '../src/index.js'
import { SOCKET_PATH, STATUS_PATH } from '../src/server.js'
import { DEFAULT_ASR_MODEL, DEFAULT_KWS_MODEL } from '../src/config.js'
import { modelStatus } from '../src/models.js'
import { modelRoot } from './model-dir.mjs'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')
const { WebSocket } = require('ws')

const root = modelRoot
const status = modelStatus({ kwsDir: path.join(root, DEFAULT_KWS_MODEL), asrDir: path.join(root, DEFAULT_ASR_MODEL) })
if (!status.ok) {
  console.log(`SKIP: models missing (kws=${status.kws.missing} asr=${status.asr.missing})`)
  process.exit(0)
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Minimal cordis context: only the members this plugin touches. */
function fakeContext({ agentFor } = {}) {
  const routes = []
  const disposers = []
  return {
    routes,
    disposers,
    ctx: {
      logger: { info() {}, warn() {} },
      get(name) {
        if (name === 'webServer') {
          return {
            registerUpgrade(route) {
              routes.push(route)
              return () => {}
            },
            register(route) {
              routes.push(route)
              return () => {}
            },
          }
        }
        if (name === 'agents') {
          return { get: (id) => (agentFor ? agentFor(id) : undefined) }
        }
        return undefined
      },
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => dispose?.()
      },
    },
  }
}

/** Convert float32 to the Int16 PCM the socket carries. */
function toPcm(samples) {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return Buffer.from(pcm.buffer)
}

/**
 * Serve the plugin's registered routes exactly the way dsh's webserver does.
 * @param {object[]} routes - registered routes.
 * @returns {Promise<{ url: string, httpUrl: string, close: () => Promise<void> }>} server handle.
 */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const route = routes.find((r) => r.kind !== undefined && r.path === req.url?.split('?')[0])
    if (!route) {
      res.writeHead(404).end()
      return
    }
    route.handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const route = routes.find((r) => r.kind === undefined && r.path === req.url?.split('?')[0])
    if (!route) {
      socket.destroy()
      return
    }
    route.handler(req, socket, head)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `ws://127.0.0.1:${port}${SOCKET_PATH}`,
    httpUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Resolve once a matching frame arrives.
 * @param {object[]} frames - received frames.
 * @param {(frame: object) => boolean} predicate - match test.
 * @param {number} timeoutMs - how long to wait.
 * @param {string} label - what is awaited.
 * @returns {Promise<object>} the matching frame.
 */
function waitFor(frames, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const found = frames.find(predicate)
      if (found !== undefined) return resolve(found)
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 100)
    }
    tick()
  })
}

/**
 * Open a socket, wait for the engine to be ready, then run one WAV through it.
 * @param {string} url - socket URL.
 * @param {Buffer} pcm - audio to send.
 * @param {object} [options] - behavior.
 * @returns {Promise<object[]>} frames received.
 */
async function drive(url, pcm, options = {}) {
  const frames = []
  const socket = new WebSocket(url)
  // Subscribe before the handshake completes: the host's first frame arrives
  // during `open`, and ws drops messages that have no listener.
  socket.on('message', (data) => frames.push(JSON.parse(String(data))))
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  if (options.sessionId) socket.send(JSON.stringify({ type: 'hello', sessionId: options.sessionId }))

  // The engine runs in a forked child and loads ~30 MB of models on first use.
  // Wait until it has answered at least once, then request the mode under test.
  await waitFor(frames, (f) => f.type === 'state' && f.phase !== 'starting', 90000, 'engine readiness')
  const dictate = options.mode === 'dictate'
  socket.send(JSON.stringify({ type: 'mode', wake: !dictate, dictate }))
  await waitFor(frames, (f) => f.type === 'state' && f.phase === 'armed', 30000, 'armed phase')

  for (let i = 0; i < pcm.length; i += 3200) socket.send(pcm.subarray(i, i + 3200))
  const silence = Buffer.alloc(3200 * 20)
  for (let i = 0; i < silence.length; i += 3200) socket.send(silence.subarray(i, i + 3200))

  await waitFor(frames, (f) => f.type === 'final', options.waitMs ?? 30000, 'final frame')
  socket.close()
  return frames
}

const wave = sherpa.readWave(path.join(root, DEFAULT_KWS_MODEL, 'test_wavs', '3.wav'))
const pcm = toPcm(wave.samples)

/* ------------------------------------------- 1. composer mode over the socket */

{
  const { ctx, routes, disposers } = fakeContext()
  apply(ctx, { wakeWords: ['法国'], modelDir: root, injectMode: 'composer', beep: false, stayAwakeMs: 0 })
  const server = await serve(routes)
  const frames = await drive(server.url, pcm, { sessionId: 'session-x' })
  await server.close()
  for (const dispose of disposers) dispose()

  const types = frames.map((frame) => frame.type)
  console.log(`frames: ${types.join(', ')}`)
  check('ready frame carries model status', frames.some((f) => f.type === 'ready' && f.ok === true))
  check('wake frame crosses the wire', frames.some((f) => f.type === 'wake' && f.keyword === '法国'))
  check('partial frames cross the wire', frames.some((f) => f.type === 'partial' && f.text))
  const final = frames.find((f) => f.type === 'final')
  check('final frame crosses the wire', final !== undefined)
  check('composer mode asks the browser to inject', final?.injected === 'composer', `injected=${final?.injected}`)
}

/* ----------------------------------------------- 2. agent mode injects on host */

{
  const calls = []
  const { ctx, routes, disposers } = fakeContext({
    agentFor: (id) => (id === 'session-x' ? { followup: (message) => calls.push(message) } : undefined),
  })
  apply(ctx, { wakeWords: ['法国'], modelDir: root, injectMode: 'agent', beep: false, stayAwakeMs: 0 })
  const server = await serve(routes)
  const frames = await drive(server.url, pcm, { sessionId: 'session-x' })
  await server.close()
  for (const dispose of disposers) dispose()

  const final = frames.find((f) => f.type === 'final')
  check('agent mode reports host injection', final?.injected === 'agent', `injected=${final?.injected}`)
  check('agent.followup received one user message', calls.length === 1, `calls=${calls.length}`)
  const message = calls[0]
  check('injected message is a user message', message?.role === 'user')
  check('injected message is tagged with this plugin', message?.source?.kind === 'plugin' && message?.source?.plugin === 'dsh-koein')
  check('injected message carries the transcript', message?.content?.[0]?.text === final?.text, JSON.stringify(message?.content))
  check('injected message is frozen', Object.isFrozen(message) && Object.isFrozen(message.content))
}

/* ------------------------------------------ 3. dictation needs no wake word */

{
  // 0.wav is ordinary speech that contains no wake phrase at all.
  const plain = sherpa.readWave(path.join(root, DEFAULT_ASR_MODEL, 'test_wavs', '0.wav'))
  const { ctx, routes, disposers } = fakeContext()
  apply(ctx, { wakeWords: ['法国'], modelDir: root, injectMode: 'composer', beep: false, stayAwakeMs: 0 })
  const server = await serve(routes)
  const frames = await drive(server.url, toPcm(plain.samples), { sessionId: 'session-x', mode: 'dictate' })
  await server.close()
  for (const dispose of disposers) dispose()

  const final = frames.find((f) => f.type === 'final')
  check('dictation never runs the wake spotter', !frames.some((f) => f.type === 'wake'))
  check('dictation produces a transcript', final !== undefined && final.text.length > 0, JSON.stringify(final?.text))
  check('dictation hands the text to the composer', final?.injected === 'composer', `injected=${final?.injected}`)
}

/* ---------------------------------------------------- 4. status route answers */

{
  const { ctx, routes, disposers } = fakeContext()
  apply(ctx, { wakeWords: ['法国'], modelDir: root })
  const server = await serve(routes)
  const response = await fetch(`${server.httpUrl}${STATUS_PATH}`)
  const body = await response.json()
  await server.close()
  for (const dispose of disposers) dispose()
  check('status route reports readiness', body.ok === true && body.models.dir === root, JSON.stringify(body.models))
  check('status route reports accepted wake words', Array.isArray(body.wakeWords) && body.wakeWords.includes('法国'))
}

console.log(failures === 0 ? '\nsocket: all checks passed' : `\nsocket: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
