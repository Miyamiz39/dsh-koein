/**
 * Isolation guarantees.
 *
 * The bug this file exists for: `sherpa-onnx-node` ships `onnxruntime.dll` 1.27
 * (ORT API 27) while `@huggingface/transformers` — pulled in by a memory plugin
 * in the same profile — ships `onnxruntime.dll` 1.21 (API ≤ 21). Windows
 * resolves DLLs by name per process, so whichever loads first wins, and the
 * other addon aborts the process. Loading the speech addon in the harness
 * therefore killed the harness.
 *
 * Two properties are enforced here: the harness module graph must never reach
 * the native addon, and a dead engine child must not take anything else with it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EngineSupervisor } from '../src/engine-client.js'
import { resolveConfig } from '../src/config.js'
import { modelRoot } from './model-dir.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/* --------------------------------------- 1. static import graph of the host half */

/** Collect the local imports reachable from an entry file. */
function importGraph(entry) {
  const seen = new Set()
  const queue = [entry]
  const bare = new Set()
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // Static `from '...'`, side-effect `import '...'`, and `require('...')`.
    const specifiers = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
      ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/gu),
      ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ].map((match) => match[1])
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        queue.push(path.resolve(path.dirname(file), specifier))
      } else if (!specifier.startsWith('node:')) {
        bare.add(specifier)
      }
    }
  }
  return { files: [...seen], bare: [...bare] }
}

const srcDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src')
const hostGraph = importGraph(path.join(srcDir, 'index.js'))

check(
  'host half never imports the native speech addon',
  !hostGraph.bare.includes('sherpa-onnx-node'),
  hostGraph.bare.join(', '),
)
check(
  'host half never imports the engine modules',
  !hostGraph.files.some((file) => /[\\/](kws|asr|pipeline)\.js$/u.test(file)),
  hostGraph.files.map((file) => path.basename(file)).join(', '),
)
check(
  'the engine child is forked, not imported',
  hostGraph.files.some((file) => file.endsWith('engine-client.js')),
)
const childGraph = importGraph(path.join(srcDir, 'engine-host.js'))
check(
  'the child is the only place the addon is loaded',
  childGraph.bare.includes('sherpa-onnx-node'),
  childGraph.bare.join(', '),
)

/* ---------------------------- 2. importing the host half loads no native addon */

await import(pathToFileURL(path.join(srcDir, 'index.js')).href)
const loadedNative = process.moduleLoadList.filter((entry) => /sherpa|onnx/iu.test(entry))
check(
  'importing the host half loads no native addon',
  loadedNative.length === 0,
  loadedNative.join(', ') || 'none',
)

/* ------------------------------------- 3. a dead child does not kill the host */

const config = resolveConfig({ wakeWords: ['法国'], modelDir: modelRoot })
const events = []
const errors = []
const supervisor = new EngineSupervisor({
  config,
  onEvent: (event) => events.push(event),
  onError: (message) => errors.push(message),
})

try {
  await supervisor.start()
  check('engine child starts and loads its models', supervisor.alive, supervisor.accepted.join('/'))
} catch (error) {
  check('engine child starts and loads its models', false, error.message)
}

const firstChild = supervisor.child
firstChild?.kill('SIGKILL')
await new Promise((resolve) => setTimeout(resolve, 1500))

check('the harness process survived the child being killed', true)
check('the supervisor reports the loss', errors.length > 0, errors[0] ?? 'no error reported')
check('the supervisor is no longer alive', !supervisor.alive)

try {
  await supervisor.start()
  check('the supervisor restarts a fresh child', supervisor.alive, supervisor.accepted.join('/'))
} catch (error) {
  check('the supervisor restarts a fresh child', false, error.message)
}

supervisor.dispose()
await new Promise((resolve) => setTimeout(resolve, 500))
check('dispose stops the child', supervisor.child === null && !supervisor.alive)

console.log(failures === 0 ? '\nisolation: all checks passed' : `\nisolation: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
