/**
 * Measure what loading the speech models actually costs in memory.
 *
 * Archive sizes are meaningless here: what matters is the resident cost of the
 * loaded ONNX weights plus the runtime. Loading in-process keeps the measurement
 * simple and honest — the engine child pays the same cost, minus Node's own
 * baseline which we subtract.
 */
import path from 'node:path'
import { statSync } from 'node:fs'
import { DEFAULT_ASR_MODEL, DEFAULT_KWS_MODEL, resolveConfig } from '../src/config.js'
import { modelStatus } from '../src/models.js'
import { WakeSpotter } from '../src/kws.js'
import { UtteranceRecognizer } from '../src/asr.js'
import { modelRoot } from './model-dir.mjs'

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`
const rss = () => process.memoryUsage().rss

const config = resolveConfig({ wakeWords: ['你好小鲸'], modelDir: modelRoot })
const status = modelStatus(config)
if (!status.ok) {
  console.log(`SKIP: models missing (kws=${status.kws.missing} asr=${status.asr.missing})`)
  process.exit(0)
}

const baseline = rss()
console.log(`node baseline rss      : ${mb(baseline)}`)

const spotter = new WakeSpotter({
  dir: config.kwsDir,
  files: status.kws.files,
  wakeWords: config.wakeWords,
  keywordsFile: '',
  keywordsScore: 1,
  keywordsThreshold: 0.25,
  numTrailingBlanks: 1,
  numThreads: 2,
})
const afterKws = rss()
console.log(`+ kws (${path.basename(DEFAULT_KWS_MODEL)})  : ${mb(afterKws - baseline)}`)

const recognizer = new UtteranceRecognizer({ files: status.asr.files, numThreads: 2 })
const afterAsr = rss()
console.log(`+ asr (${path.basename(DEFAULT_ASR_MODEL)})  : ${mb(afterAsr - afterKws)}`)
console.log(`= engine total         : ${mb(afterAsr - baseline)}`)

const weights =
  Object.values(status.kws.files).concat(Object.values(status.asr.files))
    .filter((file) => file.endsWith('.onnx'))
    .reduce((sum, file) => sum + statSync(file).size, 0)
console.log(`  (onnx weights on disk: ${mb(weights)})`)

spotter.dispose()
recognizer.dispose()
