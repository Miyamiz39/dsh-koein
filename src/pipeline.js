/**
 * The per-connection voice state machine.
 *
 * Two ways in, one audio stream:
 *
 *   wake mode     listening --KWS hit--> awake --endpoint--> final --> listening
 *   dictate mode  awake --endpoint--> final --> awake (continuous)
 *
 * Only the KWS engine runs while waiting for a wake word, so the expensive ASR
 * model stays idle until it is actually needed. In dictate mode the wake
 * spotter is not fed at all — the user already said they want to talk.
 * @module dsh-koein/pipeline
 */
import { SAMPLE_RATE } from './constants.js'
import { Endpointer } from './segmenter.js'

/** Milliseconds of audio kept before a wake hit, so the first phoneme survives. */
const PRE_ROLL_MS = 150

/** How much of the tail to keep feeding ASR after the endpoint fires. */
const TAIL_PAD_MS = 300

/**
 * Convert little-endian Int16 PCM bytes to float32.
 * @param {Buffer | Uint8Array} bytes - raw PCM.
 * @returns {Float32Array} samples in [-1, 1].
 */
export function pcmToFloat32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = Math.floor(bytes.byteLength / 2)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

/**
 * Drives one browser audio connection through wake → utterance → transcript,
 * or through continuous dictation when no wake word is wanted.
 */
export class VoicePipeline {
  /**
   * @param {object} options - engine and tuning.
   * @param {import('./kws.js').WakeSpotter} options.kws - wake spotter.
   * @param {import('./asr.js').UtteranceRecognizer} options.asr - recognizer.
   * @param {Record<string, unknown>} options.config - resolved configuration.
   * @param {(event: object) => void} options.emit - event sink.
   */
  constructor(options) {
    this.kws = options.kws
    this.asr = options.asr
    this.config = options.config
    this.emit = options.emit
    /** `idle`, `wake` (KWS armed), or `dictate` (ASR always armed). */
    this.mode = 'idle'
    /** `idle`, `listening` (KWS), or `awake` (ASR). */
    this.state = 'idle'
    this.endpointer = new Endpointer({
      sampleRate: SAMPLE_RATE,
      energyThreshold: Number(this.config.energyThreshold),
      silenceMs: Number(this.config.silenceMs),
      onsetTimeoutMs: Number(this.config.onsetTimeoutMs),
      maxUtteranceMs: Number(this.config.maxUtteranceMs),
      minUtteranceMs: Number(this.config.minUtteranceMs),
    })
    this.preRoll = []
    this.preRollMs = 0
    this.partial = ''
    this.#emitPhase()
  }

  /**
   * Feed one block of Int16 PCM.
   * @param {Buffer | Uint8Array} bytes - raw little-endian PCM at {@link SAMPLE_RATE}.
   */
  push(bytes) {
    if (this.mode === 'idle') return
    const samples = pcmToFloat32(bytes)
    if (samples.length === 0) return
    if (this.state === 'listening') this.#listen(samples)
    else if (this.state === 'awake') this.#capture(samples)
  }

  /**
   * Start listening, either for a wake word or for direct speech.
   * @param {'wake' | 'dictate'} mode - what to arm.
   */
  arm(mode) {
    if (mode === 'dictate') {
      this.mode = 'dictate'
      // No onset deadline: the user may think for a while before talking.
      this.#beginUtterance(Number.POSITIVE_INFINITY)
      return
    }
    this.mode = 'wake'
    this.#beginWakeListening()
  }

  /** Stop listening entirely and release the engines' streams. */
  disarm() {
    if (this.state === 'awake') this.asr.finish()
    this.mode = 'idle'
    this.state = 'idle'
    this.partial = ''
    this.preRoll = []
    this.preRollMs = 0
    this.kws.reset()
    this.#emitPhase()
  }

  /**
   * KWS phase.
   * @param {Float32Array} samples - audio block.
   */
  #listen(samples) {
    this.#rememberPreRoll(samples)
    const hit = this.kws.push(samples)
    if (hit === null) return
    this.#wake(hit)
  }

  /**
   * Transition into the ASR phase after a wake hit.
   * @param {string} keyword - the phrase that fired.
   */
  #wake(keyword) {
    this.#beginUtterance(Number(this.config.onsetTimeoutMs))
    // Seed the recognizer with the pre-roll so the command's first phoneme is
    // not clipped. It is far shorter than the wake phrase, so ASR does not
    // transcribe the wake word itself.
    for (const block of this.preRoll) this.asr.push(block)
    this.preRoll = []
    this.preRollMs = 0
    this.emit({ type: 'wake', keyword })
  }

  /**
   * Open a fresh recognition stream and wait for speech.
   * @param {number} onsetTimeoutMs - how long to wait before giving up.
   */
  #beginUtterance(onsetTimeoutMs) {
    this.state = 'awake'
    this.partial = ''
    this.asr.begin()
    this.endpointer.reset(onsetTimeoutMs)
    this.#emitPhase()
  }

  /** Return to wake-word-only listening. */
  #beginWakeListening() {
    this.state = 'listening'
    this.partial = ''
    this.preRoll = []
    this.preRollMs = 0
    this.kws.reset()
    this.#emitPhase()
  }

  /**
   * ASR phase: feed the recognizer, watch the endpoint, publish partials.
   * @param {Float32Array} samples - audio block.
   */
  #capture(samples) {
    const decision = this.endpointer.push(samples)
    const text = this.asr.push(samples)
    if (text && text !== this.partial) {
      this.partial = text
      this.emit({ type: 'partial', text })
    }
    // The first voiced block flips the indicator from "armed" to "capturing".
    if (decision.started) this.#emitPhase()
    if (decision.outcome === 'timeout') {
      this.#settle('timeout')
      return
    }
    if (decision.outcome === 'too-short') {
      this.#settle('too-short')
      return
    }
    if (decision.outcome === 'silence' || decision.outcome === 'max') {
      this.#settle(decision.outcome)
    }
  }

  /**
   * End the utterance, flush the recognizer, and publish the transcript.
   * @param {string} reason - why the utterance ended.
   */
  #settle(reason) {
    const text = this.asr.finish().trim()
    this.emit({ type: 'final', text, reason })
    if (this.mode === 'dictate') {
      // Continuous dictation: keep the stream open for the next sentence.
      this.#beginUtterance(Number.POSITIVE_INFINITY)
      return
    }
    const stayAwakeMs = Number(this.config.stayAwakeMs)
    if (text && stayAwakeMs > 0) {
      // Keep the same engine hot for a follow-up; a second wake word would be
      // pointless within the same breath.
      this.#beginUtterance(stayAwakeMs)
      return
    }
    this.#beginWakeListening()
  }

  /**
   * Keep the most recent audio around for the next wake hit.
   * @param {Float32Array} samples - audio block.
   */
  #rememberPreRoll(samples) {
    const blockMs = (samples.length / SAMPLE_RATE) * 1000
    this.preRoll.push(samples)
    this.preRollMs += blockMs
    while (this.preRollMs > PRE_ROLL_MS && this.preRoll.length > 1) {
      const dropped = this.preRoll.shift()
      this.preRollMs -= (dropped.length / SAMPLE_RATE) * 1000
    }
  }

  /** Publish the current indicator phase: idle, armed, or capturing. */
  #emitPhase() {
    const phase =
      this.mode === 'idle' ? 'idle' : this.state === 'awake' && this.endpointer.started ? 'capturing' : 'armed'
    this.emit({ type: 'state', phase, mode: this.mode })
  }

  /** Abort the current utterance without publishing a transcript. */
  cancel() {
    if (this.state !== 'awake') return
    this.asr.finish()
    if (this.mode === 'dictate') this.#beginUtterance(Number.POSITIVE_INFINITY)
    else this.#beginWakeListening()
  }

  /**
   * Drop any in-flight utterance. Called when another browser takes over the
   * microphone; the new connection arms the mode it wants.
   */
  reset() {
    this.disarm()
  }
}

export { PRE_ROLL_MS, TAIL_PAD_MS }
