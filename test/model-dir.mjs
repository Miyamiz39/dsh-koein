/**
 * Resolve where the tests should look for models.
 *
 * Preference order: an explicit `KOEIN_MODELS`, the repo-local `models/`
 * directory (what `tools/download-models.mjs` creates during development), then
 * the plugin's real default under `$DSH_HOME`.
 */
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_KWS_MODEL } from '../src/config.js'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** Root directory holding both model directories. */
export const modelRoot =
  process.env.KOEIN_MODELS ||
  (existsSync(path.join(repo, 'models', DEFAULT_KWS_MODEL)) ? path.join(repo, 'models') : path.join(home, 'koein-models'))

/** Repository root, for tests that need a stable absolute anchor. */
export const repoRoot = repo
