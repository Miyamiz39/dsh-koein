/**
 * Post-install check: can the profile actually load this plugin?
 *
 * Run with the profile directory as cwd, so module resolution is exactly what
 * the harness will use at boot. Verifies the package resolves, exports the
 * cordis shape, applies against a stand-in context, and that its native speech
 * engine loads from here.
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const require = createRequire(path.join(process.cwd(), 'package.json'))
const entry = require.resolve('dsh-koein')
console.log(`resolved: ${entry}`)
check('package resolves from the profile', typeof entry === 'string')

const mod = await import(pathToFileURL(entry).href)
check('exports apply', typeof mod.apply === 'function')
check('exports inject', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('injects the web server', mod.inject?.includes('webServer'))
check('exports a config schema', typeof mod.Config === 'function')
check('exports a stable name', mod.name === 'koein', mod.name)

const routes = []
const ctx = {
  logger: { info() {}, warn() {} },
  get: (name) =>
    name === 'webServer'
      ? {
          registerUpgrade: (route) => {
            routes.push(route.path)
            return () => {}
          },
          register: (route) => {
            routes.push(route.path)
            return () => {}
          },
        }
      : undefined,
  effect: (fn) => {
    fn()
  },
}

mod.apply(ctx, {})
check('mounts against the live service shape', routes.length === 2, routes.join(', '))
check('registers the audio socket', routes.includes('/dsh-koein/ws'))
check('registers the status route', routes.includes('/dsh-koein/status'))

// The native addon is the one dependency that can fail per-platform, and it
// must load in the forked child — never here. Assert the harness context stays
// clean, then start the real child and let it load the addon.
const loadedNative = process.moduleLoadList.filter((entry) => /sherpa|onnx/iu.test(entry))
check('mounting loaded no native addon in this process', loadedNative.length === 0, loadedNative.join(', ') || 'none')

try {
  const { EngineSupervisor } = await import(
    pathToFileURL(path.join(path.dirname(entry), 'engine-client.js')).href
  )
  const { resolveConfig } = await import(pathToFileURL(path.join(path.dirname(entry), 'config.js')).href)
  const errors = []
  const supervisor = new EngineSupervisor({
    config: resolveConfig({ wakeWords: ['你好小鲸'], modelDir: process.env.DSH_KOEIN_MODELS || '' }),
    onEvent: () => {},
    onError: (message) => errors.push(message),
  })
  await supervisor.start()
  check('engine child starts from the installed location', supervisor.alive, supervisor.accepted.join('/'))
  check('no engine errors on start', errors.length === 0, errors.join('; '))
  supervisor.dispose()
  await new Promise((resolve) => setTimeout(resolve, 400))
  check('engine child stops cleanly', !supervisor.alive)
} catch (error) {
  check('engine child starts from the installed location', false, error.message)
}

console.log(failures === 0 ? '\nprofile-resolve: all checks passed' : `\nprofile-resolve: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
