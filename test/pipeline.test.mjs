/**
 * End-to-end host pipeline: real WAV in, wake event and transcript out.
 *
 * This exercises every host-side moving part — KWS decode, the wake transition,
 * ASR streaming, endpointing, and event emission — with no browser involved.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { DEFAULT_ASR_MODEL, DEFAULT_KWS_MODEL } from '../src/config.js'
import { WakeSpotter } from '../src/kws.js'
import { UtteranceRecognizer } from '../src/asr.js'
import { VoicePipeline } from '../src/pipeline.js'
import { modelStatus } from '../src/models.js'
import { modelRoot } from './model-dir.mjs'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const root = modelRoot
const kwsDir = path.join(root, DEFAULT_KWS_MODEL)
const asrDir = path.join(root, DEFAULT_ASR_MODEL)

const status = modelStatus({ kwsDir, asrDir })
if (!status.ok) {
  console.log(`SKIP: models missing (kws=${status.kws.missing} asr=${status.asr.missing})`)
  console.log('      run: node tools/download-models.mjs')
  process.exit(0)
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Convert float32 samples to the little-endian Int16 PCM the socket carries. */
function toPcm(samples) {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return new Uint8Array(pcm.buffer)
}

/** Build the engines once; both tests share them. */
const spotter = new WakeSpotter({
  dir: kwsDir,
  files: status.kws.files,
  wakeWords: ['法国'],
  keywordsFile: '',
  keywordsScore: 1.0,
  keywordsThreshold: 0.25,
  numTrailingBlanks: 1,
  numThreads: 2,
})
const recognizer = new UtteranceRecognizer({ files: status.asr.files, numThreads: 2 })
console.log(`wake words accepted: ${JSON.stringify(spotter.accepted)}\n`)

/* --------------------------------------------------------- 1. ASR correctness */

{
  // 0.wav is ordinary Chinese speech; a correct recognizer returns non-empty text.
  const wave = sherpa.readWave(path.join(asrDir, 'test_wavs', '0.wav'))
  recognizer.begin()
  const chunk = 1600
  let partial = ''
  for (let i = 0; i < wave.samples.length; i += chunk) {
    partial = recognizer.push(wave.samples.subarray(i, i + chunk)) || partial
  }
  const text = recognizer.finish()
  console.log(`asr 0.wav -> ${JSON.stringify(text)}`)
  check('ASR returns text for real speech', text.length > 0)
  check('ASR emits partials while streaming', partial.length > 0, JSON.stringify(partial))
}

/* ------------------------------------------------- 2. wake → utterance → final */

{
  const wave = sherpa.readWave(path.join(kwsDir, 'test_wavs', '3.wav'))
  const events = []
  const pipeline = new VoicePipeline({
    kws: spotter,
    asr: recognizer,
    config: {
      energyThreshold: 0.012,
      silenceMs: 800,
      onsetTimeoutMs: 4000,
      maxUtteranceMs: 20000,
      minUtteranceMs: 300,
      stayAwakeMs: 0,
    },
    emit: (event) => events.push(event),
  })

  const chunk = 1600
  for (let i = 0; i < wave.samples.length; i += chunk) {
    pipeline.push(toPcm(wave.samples.subarray(i, i + chunk)))
  }
  // The browser keeps the stream open after you stop talking; the endpoint only
  // fires on trailing silence, so the test must supply it too.
  const silence = new Float32Array(16000 * 2)
  for (let i = 0; i < silence.length; i += chunk) {
    pipeline.push(toPcm(silence.subarray(i, i + chunk)))
  }

  const wake = events.find((event) => event.type === 'wake')
  const states = events.filter((event) => event.type === 'state').map((event) => event.state)
  const finals = events.filter((event) => event.type === 'final')

  console.log(`events: ${events.map((event) => event.type).join(', ')}`)
  check('wake phrase fires', wake !== undefined, wake ? `keyword=${wake.keyword}` : 'no wake event')
  check('state machine enters awake', states.includes('awake'), states.join(' -> '))
  check('pipeline settles an utterance', finals.length > 0)
  if (finals.length > 0) console.log(`final -> ${JSON.stringify(finals[0].text)} (reason=${finals[0].reason})`)
}

/* ------------------------------------------------------ 3. silence never wakes */

{
  const silence = new Float32Array(16000 * 2)
  const events = []
  const pipeline = new VoicePipeline({
    kws: spotter,
    asr: recognizer,
    config: {
      energyThreshold: 0.012,
      silenceMs: 800,
      onsetTimeoutMs: 1000,
      maxUtteranceMs: 20000,
      minUtteranceMs: 300,
      stayAwakeMs: 0,
    },
    emit: (event) => events.push(event),
  })
  for (let i = 0; i < silence.length; i += 1600) {
    pipeline.push(toPcm(silence.subarray(i, i + 1600)))
  }
  check('two seconds of silence never wake', !events.some((event) => event.type === 'wake'))
}

console.log(failures === 0 ? '\npipeline: all checks passed' : `\npipeline: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
