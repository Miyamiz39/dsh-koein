/**
 * The browser transport: one WebSocket carrying PCM up and events down, plus a
 * status route the settings page reads.
 * @module dsh-koein/server
 */
import { WebSocketServer } from 'ws'
import { describeStatus, modelStatus } from './models.js'
import { injectIntoAgent } from './inject.js'

/** Path of the audio socket. */
export const SOCKET_PATH = '/dsh-koein/ws'
/** Path of the status document. */
export const STATUS_PATH = '/dsh-koein/status'

/**
 * Send one JSON frame, ignoring a socket that already closed.
 * @param {import('ws').WebSocket} socket - the client.
 * @param {object} payload - JSON-serializable frame.
 */
function send(socket, payload) {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(payload))
}

/**
 * Register the socket and status routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} options - plugin runtime.
 * @param {() => object} options.getState - current runtime state provider.
 * @param {(socket: import('ws').WebSocket) => object} options.attach - attach a connection.
 * @param {(connection: object) => void} options.detach - release a connection.
 * @returns {() => void} disposer removing both routes.
 */
export function registerRoutes(ctx, options) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return () => {}

  const wss = new WebSocketServer({ noServer: true })
  const offUpgrade = webServer.registerUpgrade({
    path: SOCKET_PATH,
    handler: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const connection = options.attach(ws)
        send(ws, { type: 'ready', ...options.getState() })
        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            connection.feed(data)
            return
          }
          let frame
          try {
            frame = JSON.parse(String(data))
          } catch {
            return
          }
          if (frame && frame.type === 'hello') connection.setSession(String(frame.sessionId || ''))
          else if (frame && frame.type === 'cancel') connection.cancel()
        })
        ws.on('close', () => options.detach(connection))
        ws.on('error', () => options.detach(connection))
      })
    },
  })

  const offStatus = webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (req, res) => {
      const body = JSON.stringify(options.getState())
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    },
  })

  return () => {
    offUpgrade()
    offStatus()
    for (const client of wss.clients) client.terminate()
    wss.close()
  }
}

export { describeStatus, modelStatus, injectIntoAgent, send }
