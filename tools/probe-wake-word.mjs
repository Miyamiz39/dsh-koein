#!/usr/bin/env node
/**
 * Calibrate a wake phrase against a real recording of your own voice.
 *
 * Wake-word quality is the one thing that cannot be validated with shipped test
 * audio: it depends on your voice, your microphone, and your room. Record
 * yourself saying the phrase (16 kHz mono WAV), then run this to see whether the
 * spotter fires, and how the score/threshold knobs move it.
 *
 *   node tools/probe-wake-word.mjs "你好小鲸" my-recording.wav
 *   node tools/probe-wake-word.mjs "你好小鲸" my-recording.wav 1.0 0.20
 * @module dsh-koein/tools/probe-wake-word
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_KWS_MODEL } from '../src/config.js'
import { buildKeywords, readTokenSet } from '../src/keywords.js'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const [phrase, wav, scoreArg, thresholdArg] = process.argv.slice(2)
if (!phrase || !wav) {
  console.error('用法: node tools/probe-wake-word.mjs "<唤醒词>" <录音.wav> [score] [threshold]')
  process.exit(2)
}

const modelDir = path.join(
  process.env.DSH_KOEIN_MODELS ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'koein-models'),
  DEFAULT_KWS_MODEL,
)

const tokens = readTokenSet(modelDir)
const { body, accepted, rejected } = buildKeywords([phrase], tokens)
if (accepted.length === 0) {
  console.error(`模型无法表示「${phrase}」（换一个说法，或用 keywordsFile 自行提供 token）。`)
  process.exit(1)
}
console.log(`关键词行: ${body}`)

const { writeFileSync } = await import('node:fs')
const keywordsFile = path.join(os.tmpdir(), `koein-probe-${Date.now()}.txt`)
writeFileSync(keywordsFile, `${body}\n`, 'utf8')

const score = Number(scoreArg ?? 1.0)
const threshold = Number(thresholdArg ?? 0.25)
const spotter = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
      decoder: path.join(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
      joiner: path.join(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
    },
    tokens: path.join(modelDir, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
  },
  keywordsFile,
  keywordsScore: score,
  keywordsThreshold: threshold,
  numTrailingBlanks: 1,
})

const wave = sherpa.readWave(path.resolve(wav))
console.log(`音频: ${wave.samples.length} 采样 @ ${wave.sampleRate} Hz (${(wave.samples.length / wave.sampleRate).toFixed(2)}s)`)

// Stream in real-time-sized chunks: the live path never sees the whole file at
// once, and feeding it whole would let the decoder look ahead unrealistically.
const CHUNK = 1600
const stream = spotter.createStream()
let hits = 0
for (let offset = 0; offset < wave.samples.length; offset += CHUNK) {
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples.subarray(offset, offset + CHUNK) })
  while (spotter.isReady(stream)) {
    spotter.decode(stream)
    const result = spotter.getResult(stream)
    if (result && result.keyword) {
      hits += 1
      console.log(`  命中 @ ${(offset / wave.sampleRate).toFixed(2)}s -> ${result.keyword}`)
      spotter.reset(stream)
    }
  }
}
console.log(hits > 0 ? `\n✓ 命中 ${hits} 次 (score=${score}, threshold=${threshold})` : `\n✗ 未命中 (score=${score}, threshold=${threshold})`)
if (hits === 0) console.log('  提示：threshold 调低（如 0.15）或 score 调高（如 2.0）后重试。')
