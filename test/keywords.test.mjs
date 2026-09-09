/**
 * The keyword tokenizer must reproduce sherpa-onnx's own published examples.
 * The model ships `test_keywords.txt` with the authoritative token lines, so
 * this is an exact-match test, not an approximation.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_KWS_MODEL } from '../src/config.js'
import { buildKeywords, keywordLine, readTokenSet } from '../src/keywords.js'
import { modelRoot } from './model-dir.mjs'

const modelDir = path.join(modelRoot, DEFAULT_KWS_MODEL)

let failures = 0
const check = (label, actual, expected) => {
  // The published file pads with a double space before `@`; token content is
  // what matters, so compare on normalized whitespace.
  const norm = (value) => String(value).replace(/\s+/gu, ' ').trim()
  const ok = norm(actual) === norm(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        expected: ${expected}\n        actual:   ${actual}`)
}

const tokens = readTokenSet(modelDir)
console.log(`vocabulary: ${tokens.size} tokens\n`)

const official = readFileSync(path.join(modelDir, 'test_wavs', 'test_keywords.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

for (const line of official) {
  const phrase = line.slice(line.indexOf('@') + 1)
  check(phrase, keywordLine(phrase, tokens), line)
}

// Custom phrases: the headline feature. Each must produce a token line built
// only from the model's own vocabulary.
const custom = ['你好小鲸', '小鲸小鲸', '嗨小鲸', '你好DeepSeek']
for (const phrase of custom) {
  const line = keywordLine(phrase, tokens)
  const ok = typeof line === 'string' && line.endsWith(`@${phrase}`) && line.length > phrase.length
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  custom ${phrase} -> ${line ?? 'unrepresentable'}`)
}

const { rejected } = buildKeywords(['你好小鲸', '🐳'], tokens)
check('unrepresentable phrase is reported, not silently dropped', rejected.join(','), '🐳')

console.log(failures === 0 ? '\nkeywords: all checks passed' : `\nkeywords: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
