/**
 * The per-connection voice state machine.
 *
 * One audio stream, two engines, and a wake hit as the switch between them:
 *
 *   listening  --KWS hit-->  awake  --endpoint-->  final  --stayAwake?-->  awake
 *       ^                                                       |
 *       +--------------------- idle / timeout -----------------+
 *
 * Only the KWS engine runs while listening; ASR only ever sees the speech that
 * follows a wake hit, so the expensive model stays idle the vast majority of
 * the time.
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
 * Drives one browser audio connection through wake → utterance → transcript.
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
    this.state = 'listening'
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
    this.tailMs = 0
    this.partial = ''
    this.emit({ type: 'state', state: this.state })
  }

  /**
   * Feed one block of Int16 PCM.
   * @param {Buffer | Uint8Array} bytes - raw little-endian PCM at {@link SAMPLE_RATE}.
   */
  push(bytes) {
    const samples = pcmToFloat32(bytes)
    if (samples.length === 0) return
    if (this.state === 'listening') this.#listen(samples)
    else if (this.state === 'awake') this.#capture(samples)
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
   * Transition into the ASR phase.
   * @param {string} keyword - the phrase that fired.
   */
  #wake(keyword) {
    this.state = 'awake'
    this.partial = ''
    this.tailMs = 0
    this.asr.begin()
    this.endpointer.reset()
    // Seed the recognizer with the pre-roll so the command's first phoneme is
    // not clipped. It is far shorter than the wake phrase, so ASR does not
    // transcribe the wake word itself.
    for (const block of this.preRoll) this.asr.push(block)
    this.preRoll = []
    this.preRollMs = 0
    this.emit({ type: 'wake', keyword })
    this.emit({ type: 'state', state: 'awake' })
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
    const stayAwakeMs = Number(this.config.stayAwakeMs)
    if (text && stayAwakeMs > 0) {
      // Keep the same engine hot for a follow-up; a second wake word would be
      // pointless within the same breath.
      this.state = 'awake'
      this.partial = ''
      this.asr.begin()
      this.endpointer.reset(stayAwakeMs)
      this.emit({ type: 'state', state: 'awake' })
      return
    }
    this.#sleep()
  }

  /** Return to wake-word-only listening. */
  #sleep() {
    this.state = 'listening'
    this.partial = ''
    this.preRoll = []
    this.preRollMs = 0
    this.kws.reset()
    this.emit({ type: 'state', state: 'listening' })
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

  /** Abort the current utterance and go back to listening. */
  cancel() {
    if (this.state === 'awake') {
      this.asr.finish()
      this.#sleep()
    }
  }

  /**
   * Drop any in-flight utterance and return to wake-word-only listening.
   * Called when another browser takes over the microphone.
   */
  reset() {
    if (this.state === 'listening') return
    if (this.state === 'awake') this.asr.finish()
    this.#sleep()
  }
}

export { PRE_ROLL_MS, TAIL_PAD_MS }
