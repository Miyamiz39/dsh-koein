/**
 * The utterance recognizer: a streaming sherpa-onnx transducer that turns the
 * speech *after* a wake hit into text, emitting partials as it goes.
 * @module dsh-koein/asr
 */
import { createRequire } from 'node:module'
import { SAMPLE_RATE } from './kws.js'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

/**
 * One streaming recognition stream.
 */
export class UtteranceRecognizer {
  /**
   * @param {object} options - engine options.
   * @param {Record<string, string>} options.files - resolved model files.
   * @param {number} options.numThreads - inference threads.
   */
  constructor(options) {
    this.recognizer = new sherpa.OnlineRecognizer({
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
      // Endpointing is ours: the segmenter decides when an utterance ended, so
      // the recognizer must not cut it short on its own silence rules.
      enableEndpoint: false,
      decodingMethod: 'greedy_search',
    })
  }

  /** Open a fresh stream for one utterance. */
  begin() {
    this.stream = this.recognizer.createStream()
    this.text = ''
  }

  /**
   * Feed audio and return the text so far.
   * @param {Float32Array} samples - audio at {@link SAMPLE_RATE}.
   * @returns {string} the current transcript (may be unchanged).
   */
  push(samples) {
    if (!this.stream) return ''
    this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    const result = this.recognizer.getResult(this.stream)
    const text = String(result?.text ?? '').trim()
    if (text) this.text = text
    return this.text
  }

  /**
   * Flush the tail and return the final transcript.
   * @returns {string} the final transcript.
   */
  finish() {
    if (!this.stream) return this.text ?? ''
    // The trailing chunk needs padding to be emitted; 0.5s is what sherpa's own
    // examples use for this model family.
    this.stream.acceptWaveform({
      sampleRate: SAMPLE_RATE,
      samples: new Float32Array(Math.floor(0.5 * SAMPLE_RATE)),
    })
    this.stream.inputFinished()
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    const result = this.recognizer.getResult(this.stream)
    const text = String(result?.text ?? '').trim()
    this.stream = undefined
    return text || this.text || ''
  }

  /** Release native resources. */
  dispose() {
    this.stream = undefined
    this.recognizer = undefined
  }
}
