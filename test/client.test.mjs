/**
 * Client-half load test.
 *
 * The browser bundle is hand-written in the module-loader format, so nothing
 * type-checks it. This test executes it for real: a stand-in
 * `window.__ModuleLoader__` captures the factory, the factory is invoked with a
 * `require` that resolves React, and the resulting plugin is applied to a
 * stand-in slot registry. A typo or a wrong slot name fails here rather than in
 * the browser console.
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Capture the bundle definition instead of letting a page register it. */
let definition = null
globalThis.window = {
  location: { protocol: 'http:', host: '127.0.0.1:3080' },
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
}

/** The bundle injects a <style> tag; a stub element is enough. */
const created = []
globalThis.document = {
  createElement(tag) {
    const element = { tag, dataset: {}, textContent: '', removed: false, remove: () => {} }
    created.push(element)
    return element
  },
  head: { appendChild() {} },
  querySelector: () => null,
}

await import(pathToFileURL(path.join(here, '..', 'src', 'client.js')).href)

check('bundle calls the module loader', definition !== null)
check('bundle id is the package name', definition?.id === 'dsh-koein', definition?.id)
check('bundle exposes a factory', typeof definition?.factory === 'function')

// React lives in the harness install at runtime; locally we use the pinned
// devDependency so the renderer and the elements below share one copy.
const react = require('react')

const plugin = definition.factory((request) => {
  if (request === 'react') return react
  throw new Error(`unexpected require: ${request}`)
})

check('plugin exports inject', Array.isArray(plugin.inject), JSON.stringify(plugin.inject))
check('plugin injects the slots service', plugin.inject?.includes('slots'))
check('plugin exports apply', typeof plugin.apply === 'function')

/* ---------------------------------------------------- the colour contract */

const { __statusFor } = plugin
check('gray when stopped', __statusFor('idle', 'idle') === 'off')
check('green after a left click (direct dictation)', __statusFor('armed', 'dictate') === 'listen')
check('blue after a right click (waiting for the wake word)', __statusFor('armed', 'wake') === 'wake')
check('green once the wake word is heard', __statusFor('capturing', 'wake') === 'hearing')
check('green while a dictated utterance is recognised', __statusFor('capturing', 'dictate') === 'hearing')

/* ------------------------------------------------------- the draft merge */

const { __joinDraft } = plugin
check('appends after CJK without a space', __joinDraft('你好', '世界') === '你好世界')
check('appends after Latin with a space', __joinDraft('hello', 'world') === 'hello world')
check('keeps CJK punctuation tight', __joinDraft('你好', '，然后呢') === '你好，然后呢')
check('empty draft takes the transcript verbatim', __joinDraft('', '你好') === '你好')
check('does not double an existing trailing space', __joinDraft('hello ', 'world') === 'hello world')

/* --------------------------------------------------------- apply the plugin */

const registered = []
const injected = []
const effects = []
const ctx = {
  slots: {
    inject(name, callback) {
      injected.push(name)
      callback()
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    return () => dispose?.()
  },
}

plugin.apply(ctx)

check('styles effect is owned', effects.includes('dsh-koein: styles'), effects.join(', '))
check('stylesheet element was created', created.length === 1)

const targets = registered.map((entry) => entry.options.name)
check('registers the microphone beside the send button', targets.includes('conversation.input.right'), targets.join(', '))
check('no separate status indicator is registered', !targets.includes('conversation.input.left') && !targets.includes('conversation.input.dock'))
check('registers the settings page', targets.includes('settings.section'))
check('every registration has an id', registered.every((entry) => typeof entry.options.id === 'string'))
check('every registration has a component', registered.every((entry) => typeof entry.component === 'function'))
check(
  'slot injections wait for the same slots it registers into',
  injected.length === 2 && injected.every((name) => targets.includes(name)),
  injected.join(', '),
)

const settings = registered.find((entry) => entry.options.name === 'settings.section')
check('settings page carries a label', typeof settings?.options.label === 'string', String(settings?.options.label))

/* ------------------------------------------- components render under real React */

const { renderToStaticMarkup } = require('react-dom/server')
const mic = registered.find((entry) => entry.options.name === 'conversation.input.right')
const settingsPage = registered.find((entry) => entry.options.name === 'settings.section')

try {
  // A slot hands `useInput` to the component as a hook; the stub behaves as one.
  const useInput = (selector) => {
    const [state] = react.useState({ draft: '' })
    return selector(state)
  }
  const html = renderToStaticMarkup(
    react.createElement(mic.component, {
      sessionId: 'session-1',
      useInput,
      inputActions: { setDraft() {}, submit() {} },
    }),
  )
  check(
    'microphone renders in the off state',
    html.includes('koe-mic') && html.includes('data-status="off"') && html.includes('<svg'),
    html.slice(0, 110),
  )
} catch (error) {
  check('microphone renders in the off state', false, error.message)
}

try {
  const html = renderToStaticMarkup(react.createElement(settingsPage.component, {}))
  check('settings page renders its heading', html.includes('语音唤醒'), html.slice(0, 90))
} catch (error) {
  check('settings page renders its heading', false, error.message)
}

console.log(failures === 0 ? '\nclient: all checks passed' : `\nclient: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
