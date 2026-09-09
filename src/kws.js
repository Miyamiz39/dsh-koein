/**
 * The always-on wake-word spotter: a sherpa-onnx open-vocabulary KWS engine.
 *
 * It is deliberately cheap — the int8 wenetspeech model decodes roughly 50x
 * faster than real time on one core, so keeping it fed continuously is the
 * whole point of this plugin. It never runs ASR; it only answers "was a wake
 * phrase just spoken, and where did it end".
 * @module dsh-koein/kws
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildKeywords, readTokenSet } from './keywords.js'
import { SAMPLE_RATE } from './constants.js'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

/** Sample rate every sherpa-onnx model here expects. */
export { SAMPLE_RATE }

/**
 * The wake-word engine.
 */
export class WakeSpotter {
  /**
   * @param {object} options - engine options.
   * @param {string} options.dir - KWS model directory.
   * @param {Record<string, string>} options.files - resolved model files.
   * @param {string[]} options.wakeWords - configured wake phrases.
   * @param {string} options.keywordsFile - explicit keywords file (wins over wakeWords).
   * @param {number} options.keywordsScore - boosting score.
   * @param {number} options.keywordsThreshold - trigger threshold.
   * @param {number} options.numTrailingBlanks - trailing blank frames.
   * @param {number} options.numThreads - inference threads.
   */
  constructor(options) {
    this.accepted = []
    this.rejected = []
    const tokens = readTokenSet(options.dir)
    const keywordsFile = options.keywordsFile || this.#writeKeywords(options, tokens)

    this.spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: options.files.encoder,
          decoder: options.files.decoder,
          joiner: options.files.joiner,
        },
        tokens: options.files.tokens,
        numThreads: options.numThreads,
        provider: 'cpu',
      },
      keywordsFile,
      keywordsScore: options.keywordsScore,
      keywordsThreshold: options.keywordsThreshold,
      numTrailingBlanks: options.numTrailingBlanks,
    })
    this.stream = this.spotter.createStream()
  }

  /**
   * Materialize a keywords file for the configured wake phrases.
   * @param {object} options - engine options.
   * @param {Set<string>} tokens - model vocabulary.
   * @returns {string} path of the written keywords file.
   */
  #writeKeywords(options, tokens) {
    const { body, accepted, rejected } = buildKeywords(options.wakeWords, tokens)
    this.accepted = accepted
    this.rejected = rejected
    if (accepted.length === 0) {
      throw new Error(
        `no usable wake word: the KWS model cannot represent ${JSON.stringify(rejected)}; ` +
          'pick a different phrase or supply keywordsFile',
      )
    }
    mkdirSync(options.dir, { recursive: true })
    const file = path.join(options.dir, 'koein-keywords.txt')
    writeFileSync(file, `${body}\n`, 'utf8')
    return file
  }

  /**
   * Feed one block of mono float32 audio and report a wake hit.
   * @param {Float32Array} samples - audio at {@link SAMPLE_RATE}.
   * @returns {string | null} the matched wake phrase, or null.
   */
  push(samples) {
    this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    let hit = null
    while (this.spotter.isReady(this.stream)) {
      this.spotter.decode(this.stream)
      const result = this.spotter.getResult(this.stream)
      if (result && result.keyword) {
        hit = result.keyword
        // Reset immediately: the spotter must not re-fire on the same audio,
        // and the command that follows belongs to the ASR engine, not to KWS.
        this.spotter.reset(this.stream)
        break
      }
    }
    return hit
  }

  /** Drop any partially matched keyword. */
  reset() {
    this.spotter.reset(this.stream)
  }

  /** Release native resources. */
  dispose() {
    this.spotter = undefined
    this.stream = undefined
  }
}
