/**
 * Energy-based endpointing for one spoken utterance.
 *
 * The wake word already told us the user is talking to us, so a plain RMS gate
 * with a silence hangover is enough and costs nothing — no extra VAD model to
 * download, no second inference pass. It answers three questions the pipeline
 * needs: has speech started, has it stopped, and did it run too long.
 * @module dsh-koein/segmenter
 */

/**
 * Root-mean-square amplitude of a block.
 * @param {Float32Array} samples - audio block.
 * @returns {number} RMS in [0, 1].
 */
export function rms(samples) {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/**
 * Tracks one utterance boundary.
 */
export class Endpointer {
  /**
   * @param {object} options - tuning.
   * @param {number} options.sampleRate - audio sample rate.
   * @param {number} options.energyThreshold - RMS above which a block counts as speech.
   * @param {number} options.silenceMs - trailing silence that ends the utterance.
   * @param {number} options.onsetTimeoutMs - how long to wait for speech to start.
   * @param {number} options.maxUtteranceMs - hard cap on utterance length.
   * @param {number} options.minUtteranceMs - utterances shorter than this are dropped.
   */
  constructor(options) {
    this.options = options
    this.reset()
  }

  /**
   * Reset for a new utterance.
   * @param {number} [onsetTimeoutMs] - override the wait-for-speech window.
   */
  reset(onsetTimeoutMs) {
    this.elapsedMs = 0
    this.speechMs = 0
    this.silenceRunMs = 0
    this.started = false
    this.onsetTimeoutMs = onsetTimeoutMs ?? this.options.onsetTimeoutMs
  }

  /**
   * Consume one block.
   * @param {Float32Array} samples - audio block.
   * @returns {{ started: boolean, level: number, outcome: 'none'|'silence'|'timeout'|'max'|'too-short' }}
   *   the boundary decision after this block.
   */
  push(samples) {
    const blockMs = (samples.length / this.options.sampleRate) * 1000
    const level = rms(samples)
    const voiced = level >= this.options.energyThreshold
    const justStarted = voiced && !this.started

    this.elapsedMs += blockMs
    if (voiced) {
      this.started = true
      this.speechMs += blockMs
      this.silenceRunMs = 0
    } else if (this.started) {
      this.silenceRunMs += blockMs
    }

    let outcome = 'none'
    if (!this.started) {
      if (this.elapsedMs >= this.onsetTimeoutMs) outcome = 'timeout'
    } else if (this.silenceRunMs >= this.options.silenceMs) {
      outcome = this.speechMs >= this.options.minUtteranceMs ? 'silence' : 'too-short'
    } else if (this.elapsedMs >= this.options.maxUtteranceMs) {
      outcome = this.speechMs >= this.options.minUtteranceMs ? 'max' : 'too-short'
    }

    return { started: justStarted, level, outcome }
  }
}
