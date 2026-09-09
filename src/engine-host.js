/**
 * The speech engine child process.
 *
 * This is the ONLY module that loads `sherpa-onnx-node`, and it is never
 * imported by the harness process — it is forked. Two reasons:
 *
 * 1. **DLL collision.** sherpa-onnx ships `onnxruntime.dll` 1.27 (ORT API 27);
 *    `@huggingface/transformers` (used by a memory plugin) ships
 *    `onnxruntime.dll` 1.21 (API ≤ 21). Windows resolves DLLs by name within a
 *    process, so whichever loads first wins, and the loser's addon aborts the
 *    process with an access violation. A separate process gets its own loader
 *    namespace and always sees sherpa's own runtime.
 *
 * 2. **Crash containment.** A native addon that segfaults must not be able to
 *    take the harness down with it. Here it only kills this child, which the
 *    supervisor restarts.
 *
 * Protocol (parent ↔ child, structured clone over the IPC channel):
 *   → { t: 'start', config }   → { t: 'ready', accepted, rejected } | { t: 'fatal', message }
 *   → { t: 'audio', pcm }      → { t: 'event', event }
 *   → { t: 'cancel' } / { t: 'reset' } / { t: 'stop' }
 * @module dsh-koein/engine-host
 */
import { WakeSpotter } from './kws.js'
import { UtteranceRecognizer } from './asr.js'
import { VoicePipeline } from './pipeline.js'
import { modelStatus } from './models.js'

/** @type {WakeSpotter | null} */
let spotter = null
/** @type {UtteranceRecognizer | null} */
let recognizer = null
/** @type {VoicePipeline | null} */
let pipeline = null

/**
 * Send one frame to the parent.
 * @param {object} frame - JSON/structured-clone-safe payload.
 */
function post(frame) {
  if (typeof process.send === 'function') process.send(frame)
}

/**
 * Build the engines and the pipeline for a session.
 * @param {Record<string, unknown>} config - resolved plugin configuration.
 */
function start(config) {
  dispose()
  const status = modelStatus(config)
  if (!status.ok) {
    post({ t: 'fatal', message: `models missing: kws=${status.kws.missing} asr=${status.asr.missing}` })
    return
  }
  spotter = new WakeSpotter({
    dir: config.kwsDir,
    files: status.kws.files,
    wakeWords: config.wakeWords,
    keywordsFile: config.keywordsFile,
    keywordsScore: Number(config.keywordsScore),
    keywordsThreshold: Number(config.keywordsThreshold),
    numTrailingBlanks: Number(config.numTrailingBlanks),
    numThreads: Number(config.numThreads),
  })
  recognizer = new UtteranceRecognizer({
    files: status.asr.files,
    numThreads: Number(config.numThreads),
  })
  pipeline = new VoicePipeline({
    kws: spotter,
    asr: recognizer,
    config,
    emit: (event) => post({ t: 'event', event }),
  })
  post({ t: 'ready', accepted: spotter.accepted, rejected: spotter.rejected })
}

/** Release native resources. */
function dispose() {
  pipeline = null
  spotter?.dispose()
  recognizer?.dispose()
  spotter = null
  recognizer = null
}

process.on('message', (frame) => {
  if (frame === null || typeof frame !== 'object') return
  try {
    if (frame.t === 'start') start(frame.config)
    else if (frame.t === 'audio') pipeline?.push(frame.pcm)
    else if (frame.t === 'cancel') pipeline?.cancel()
    else if (frame.t === 'reset') pipeline?.reset()
    else if (frame.t === 'stop') {
      dispose()
      process.exit(0)
    }
  } catch (error) {
    post({ t: 'fatal', message: error instanceof Error ? error.message : String(error) })
  }
})

process.on('disconnect', () => {
  dispose()
  process.exit(0)
})

// A native abort cannot be caught, but a clean SIGTERM should still release.
process.on('SIGTERM', () => {
  dispose()
  process.exit(0)
})
