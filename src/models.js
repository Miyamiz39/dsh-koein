/**
 * Locate the sherpa-onnx model files this plugin needs, and report what is missing.
 * @module dsh-koein/models
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** Every file a KWS model directory must contain, in preference order. */
const KWS_ROLES = ['encoder', 'decoder', 'joiner']
/** Every file a streaming ASR model directory must contain. */
const ASR_ROLES = ['encoder', 'decoder', 'joiner']

/**
 * Pick the best existing file for one role, preferring int8 over fp32.
 * @param {string} dir - model directory.
 * @param {string} role - `encoder`, `decoder`, or `joiner`.
 * @returns {string | null} absolute path, or null when absent.
 */
function pickFile(dir, role) {
  if (!existsSync(dir)) return null
  const names = readdirSync(dir).filter((name) => name.endsWith('.onnx') && name.startsWith(role))
  if (names.length === 0) return null
  const int8 = names.filter((name) => name.includes('int8')).sort()
  const rest = names.filter((name) => !name.includes('int8')).sort()
  const chosen = int8[0] ?? rest[0]
  return chosen ? path.join(dir, chosen) : null
}

/**
 * Resolve one model directory's files.
 * @param {string} dir - model directory.
 * @param {string[]} roles - required roles.
 * @returns {{ files: Record<string, string>, missing: string[] }} resolved files
 *   and the roles whose `.onnx` file is absent.
 */
function resolveRoles(dir, roles) {
  const files = {}
  const missing = []
  for (const role of roles) {
    const file = pickFile(dir, role)
    if (file === null) missing.push(role)
    else files[role] = file
  }
  const tokens = path.join(dir, 'tokens.txt')
  if (existsSync(tokens)) files.tokens = tokens
  else missing.push('tokens.txt')
  return { files, missing }
}

/**
 * Report the on-disk status of both models.
 * @param {{ kwsDir: string, asrDir: string }} config - resolved configuration.
 * @returns {{ kws: object, asr: object, ok: boolean }} per-model status.
 */
export function modelStatus(config) {
  const kws = { dir: config.kwsDir, ...resolveRoles(config.kwsDir, KWS_ROLES) }
  const asr = { dir: config.asrDir, ...resolveRoles(config.asrDir, ASR_ROLES) }
  return { kws, asr, ok: kws.missing.length === 0 && asr.missing.length === 0 }
}

/**
 * Render a human-readable status line for logs and error messages.
 * @param {ReturnType<typeof modelStatus>} status - model status.
 * @returns {string} one-line summary.
 */
export function describeStatus(status) {
  const part = (label, entry) =>
    entry.missing.length === 0
      ? `${label}=ok`
      : `${label}=missing(${entry.missing.join(',')})`
  return `${part('kws', status.kws)} ${part('asr', status.asr)}`
}
