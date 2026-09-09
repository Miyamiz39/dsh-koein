/**
 * Deliver a transcript to a live agent as a user message.
 *
 * `followup` is the right verb: `inject` only queues context and never opens a
 * turn, so an idle agent would stay silent. `followup` wakes it.
 * @module dsh-koein/inject
 */
import { randomUUID } from 'node:crypto'

/** Source tag carried by every message this plugin injects. */
export const PLUGIN_ID = 'dsh-koein'

/** Cached `createUserMessage` implementation from the harness. */
let factoryPromise

/**
 * Resolve the harness message factory, tolerating a host that does not expose it.
 * @returns {Promise<((input: object) => object) | null>} the factory or null.
 */
function loadFactory() {
  factoryPromise ??= import('@deepseek-ai/dsh-llm')
    .then((mod) => (typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null))
    .catch(() => null)
  return factoryPromise
}

/**
 * Build a user message the way the harness builds its own.
 * @param {string} text - the transcript.
 * @returns {Promise<object>} a frozen user message.
 */
/**
 * Recursively freeze a plain JSON value.
 * @param {unknown} value - value to freeze.
 * @returns {unknown} the same value, frozen in place.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * Build a user message the way the harness builds its own.
 *
 * The harness factory is preferred when it resolves. It usually does not: a
 * plugin installed into a profile is linked from outside that profile, so the
 * harness packages are not on this module's resolution path. The fallback is
 * the same shape the factory produces (`brandString(randomUUID())` is a plain
 * string at runtime), frozen the same way, so both paths behave identically.
 * @param {string} text - the transcript.
 * @returns {Promise<object>} a frozen user message.
 */
async function buildMessage(text) {
  const create = await loadFactory()
  if (create !== null) {
    return create({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: PLUGIN_ID } })
  }
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_ID },
  })
}

/**
 * Inject a transcript into one session's agent.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} sessionId - target session.
 * @param {string} text - the transcript.
 * @returns {Promise<{ ok: boolean, error?: string }>} the outcome.
 */
export async function injectIntoAgent(ctx, sessionId, text) {
  const agents = ctx.get('agents')
  if (agents === undefined) return { ok: false, error: 'agents service is unavailable' }
  const agent = agents.get(sessionId)
  if (agent === undefined) return { ok: false, error: `no live agent for session ${sessionId}` }
  try {
    agent.followup(await buildMessage(text))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
