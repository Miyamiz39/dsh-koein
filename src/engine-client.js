/**
 * Host-side supervisor for the speech engine child process.
 *
 * The harness process only ever talks to this class; it never loads a native
 * speech addon itself. If the child dies — a native fault, an OOM, a model
 * error — the harness survives and the next microphone connection starts a
 * fresh child.
 * @module dsh-koein/engine-client
 */
import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** How long to wait for model loading before giving up. */
const READY_TIMEOUT_MS = 120000

/**
 * Owns one engine child process and relays audio and events.
 */
export class EngineSupervisor {
  /**
   * @param {object} options - wiring.
   * @param {Record<string, unknown>} options.config - resolved plugin configuration.
   * @param {(event: object) => void} options.onEvent - pipeline event sink.
   * @param {(message: string) => void} options.onError - fatal child failure.
   */
  constructor(options) {
    this.config = options.config
    this.onEvent = options.onEvent
    this.onError = options.onError
    this.child = null
    this.ready = false
    this.disposed = false
    this.accepted = []
    this.rejected = []
    /** @type {Promise<void> | null} */
    this.starting = null
  }

  /** @returns {boolean} whether audio can be accepted right now. */
  get alive() {
    return this.child !== null && this.ready && !this.disposed
  }

  /**
   * Fork the child and wait until its models are loaded.
   * @returns {Promise<void>} resolves once the child is ready.
   */
  start() {
    if (this.disposed) return Promise.reject(new Error('speech engine supervisor is disposed'))
    if (this.ready) return Promise.resolve()
    if (this.starting !== null) return this.starting
    this.starting = new Promise((resolve, reject) => {
      const child = fork(path.join(HERE, 'engine-host.js'), [], {
        // Structured clone keeps PCM typed arrays cheap across the channel.
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.child = child

      const timer = setTimeout(() => {
        this.#fail('speech engine did not become ready in time')
        reject(new Error('speech engine did not become ready in time'))
      }, READY_TIMEOUT_MS)

      const settle = (error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }

      child.on('message', (frame) => {
        if (frame === null || typeof frame !== 'object') return
        if (frame.t === 'ready') {
          this.ready = true
          this.starting = null
          this.accepted = frame.accepted ?? []
          this.rejected = frame.rejected ?? []
          settle(null)
          return
        }
        if (frame.t === 'event') {
          this.onEvent(frame.event)
          return
        }
        if (frame.t === 'fatal') {
          this.#fail(frame.message)
          settle(new Error(frame.message))
        }
      })

      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) this.onError(`speech engine stderr: ${text.slice(0, 400)}`)
      })

      child.on('error', (error) => {
        this.#fail(error.message)
        settle(error)
      })

      child.on('exit', (code, signal) => {
        const wasReady = this.ready
        this.child = null
        this.ready = false
        this.starting = null
        if (this.disposed) return
        settle(new Error(`speech engine exited (code=${code}, signal=${signal})`))
        if (wasReady) {
          this.onError(
            `speech engine stopped (code=${code}${signal ? `, signal=${signal}` : ''}); ` +
              'click the microphone again to restart it',
          )
        }
      })

      child.send({ t: 'start', config: this.config })
    })
    return this.starting
  }

  /**
   * Forward one block of PCM.
   * @param {Uint8Array | Buffer} pcm - little-endian Int16 audio.
   */
  push(pcm) {
    if (!this.alive) return
    this.child.send({ t: 'audio', pcm })
  }

  /** Abandon the utterance in flight. */
  cancel() {
    if (this.alive) this.child.send({ t: 'cancel' })
  }

  /**
   * Start listening for a wake word or for direct speech.
   * @param {'wake' | 'dictate'} mode - what to arm.
   */
  arm(mode) {
    if (this.alive) this.child.send({ t: 'arm', mode })
  }

  /** Stop listening and release the engines' streams. */
  disarm() {
    if (this.alive) this.child.send({ t: 'disarm' })
  }

  /** Return the pipeline to wake-word-only listening. */
  reset() {
    if (this.alive) this.child.send({ t: 'reset' })
  }

  /**
   * Report a fatal child failure once and mark the supervisor dead.
   * @param {string} message - what went wrong.
   */
  #fail(message) {
    this.ready = false
    this.onError(message)
  }

  /** Stop the child and release the supervisor. */
  dispose() {
    this.disposed = true
    const child = this.child
    this.child = null
    this.ready = false
    this.starting = null
    if (child === null) return
    try {
      child.send({ t: 'stop' })
    } catch {
      /* the channel is already closed */
    }
    // Give the child a moment to free native resources, then make sure.
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500)
    timer.unref?.()
    child.once('exit', () => clearTimeout(timer))
  }
}
