/**
 * Turn Chinese wake phrases into sherpa-onnx KWS keyword lines.
 *
 * The wenetspeech KWS model is a pinyin model: its vocabulary holds initials
 * (`zh`, `x`, `n`, …) and tone-marked finals (`ǐ`, `ǎo`, `uǒ`, …), so a keyword
 * line is that token sequence followed by `@<the original phrase>`:
 *
 *   n ǐ h ǎo x iǎo j īng @你好小鲸
 *
 * We never guess the split. Every candidate token is validated against the
 * model's own `tokens.txt`, so a phrase this model cannot represent fails loudly
 * at startup instead of silently never firing.
 * @module dsh-koein/keywords
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pinyin } from 'pinyin-pro'

/** Longest-first so `zh` wins over `z`, and `sh` over `s`. */
const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w']

/**
 * Read the token vocabulary of a KWS model.
 * @param {string} modelDir - directory holding `tokens.txt`.
 * @returns {Set<string>} every usable token.
 */
export function readTokenSet(modelDir) {
  const file = path.join(modelDir, 'tokens.txt')
  const text = readFileSync(file, 'utf8')
  const set = new Set()
  for (const line of text.split('\n')) {
    const token = line.split(' ')[0]
    if (!token || token.startsWith('#') || token.startsWith('<')) continue
    set.add(token)
  }
  return set
}

/**
 * Split one pinyin syllable into model tokens.
 * @param {string} syllable - tone-marked pinyin, e.g. `xiǎo`.
 * @param {Set<string>} tokens - the model vocabulary.
 * @returns {string[] | null} the tokens, or null when unrepresentable.
 */
export function syllableToTokens(syllable, tokens) {
  if (!syllable) return null
  if (tokens.has(syllable)) return [syllable]
  for (const initial of INITIALS) {
    if (!syllable.startsWith(initial)) continue
    const final = syllable.slice(initial.length)
    if (final && tokens.has(final)) return [initial, final]
  }
  return null
}

/**
 * Convert one wake phrase into a keyword line.
 * @param {string} phrase - the wake phrase, e.g. `你好小鲸`.
 * @param {Set<string>} tokens - the model vocabulary.
 * @returns {string | null} the keyword line, or null when unrepresentable.
 */
export function keywordLine(phrase, tokens) {
  const clean = String(phrase).trim().replace(/\s+/gu, '_')
  if (!clean) return null
  const syllables = pinyin(clean, { toneType: 'symbol', type: 'array', nonZh: 'consecutive' })
  const out = []
  for (const syllable of syllables) {
    if (/^[\x20-\x7e]+$/u.test(syllable)) {
      // Latin text: the vocabulary carries single upper-case letters.
      for (const char of syllable.toUpperCase()) {
        if (!tokens.has(char)) return null
        out.push(char)
      }
      continue
    }
    const split = syllableToTokens(syllable, tokens)
    if (split === null) return null
    out.push(...split)
  }
  if (out.length === 0) return null
  return `${out.join(' ')} @${clean.replace(/_/gu, '')}`
}

/**
 * Build a keywords file body for a set of wake phrases.
 * @param {string[]} phrases - configured wake phrases.
 * @param {Set<string>} tokens - the model vocabulary.
 * @returns {{ body: string, accepted: string[], rejected: string[] }} the file
 *   body plus which phrases were accepted and which the model cannot represent.
 */
export function buildKeywords(phrases, tokens) {
  const lines = []
  const accepted = []
  const rejected = []
  for (const phrase of phrases) {
    const line = keywordLine(phrase, tokens)
    if (line === null) {
      rejected.push(phrase)
      continue
    }
    lines.push(line)
    accepted.push(phrase)
  }
  return { body: lines.join('\n'), accepted, rejected }
}
