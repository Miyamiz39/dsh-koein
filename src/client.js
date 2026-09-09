/**
 * dsh-koein, browser half.
 *
 * Hand-written in the exact shape a bundler would emit for a DSH client plugin
 * (`window.__ModuleLoader__.load({ id, factory })`), so this package needs no
 * build step: the host serves these bytes as-is.
 *
 * Responsibilities: capture the microphone at the model's sample rate, stream
 * PCM to the host, and render the wake-word controls. All speech understanding
 * happens on the host; this half never sees a model.
 */
window.__ModuleLoader__.load({
  id: 'dsh-koein',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Service dependencies: the slot registry is all this half needs. */
    const inject = ['slots']

    const SOCKET_PATH = '/dsh-koein/ws'
    const STATUS_PATH = '/dsh-koein/status'
    const TARGET_RATE = 16000
    const BLOCK_SAMPLES = 1024

    const STYLE_ID = 'dsh-koein/styles'
    const CSS = `
.koe-mic{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:color .12s}
.koe-mic:hover,.koe-mic:focus-visible{background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary)}
.koe-mic[data-status="armed"]{color:#3b82f6}
.koe-mic[data-status="armed"]:hover{color:#60a5fa}
.koe-mic[data-status="capturing"]{color:#22c55e;animation:koe-breathe 1.4s ease-in-out infinite}
.koe-mic[data-status="connecting"]{color:#9ca3af;opacity:.7}
.koe-mic[data-status="error"]{color:#d9534f}
@keyframes koe-breathe{0%,100%{opacity:1}50%{opacity:.45}}
.koe-page{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.koe-page h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.koe-page code{font-family:var(--dsw-font-mono);font-size:12px;background:var(--dsw-alias-fill-l2);padding:1px 5px;border-radius:5px;color:var(--dsw-alias-label-primary)}
.koe-row{display:flex;gap:10px;align-items:baseline}
.koe-row .koe-k{min-width:96px;color:var(--dsw-alias-label-tertiary)}
.koe-bad{color:#d9534f}
`

    /* ------------------------------------------------------------------ audio */

    /**
     * Streaming linear resampler, used only when the browser refuses a 16 kHz
     * AudioContext. Speech-grade quality; the alternative would be no audio.
     */
    class Resampler {
      constructor(inputRate, outputRate) {
        this.ratio = inputRate / outputRate
        this.pos = 0
        this.tail = new Float32Array(0)
      }

      /**
       * @param {Float32Array} chunk - input samples.
       * @returns {Float32Array} resampled samples.
       */
      push(chunk) {
        const src = new Float32Array(this.tail.length + chunk.length)
        src.set(this.tail, 0)
        src.set(chunk, this.tail.length)
        const outLen = Math.max(0, Math.floor((src.length - this.pos) / this.ratio))
        const out = new Float32Array(outLen)
        let pos = this.pos
        for (let i = 0; i < outLen; i += 1) {
          const idx = Math.floor(pos)
          const frac = pos - idx
          const a = src[idx] ?? 0
          const b = src[idx + 1] ?? a
          out[i] = a + (b - a) * frac
          pos += this.ratio
        }
        const consumed = Math.floor(pos)
        this.tail = src.slice(consumed)
        this.pos = pos - consumed
        return out
      }
    }

    /**
     * The AudioWorklet that frames microphone audio into fixed blocks.
     * @returns {string} worklet module source.
     */
    function workletSource() {
      return `
class DshKoeinCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(${BLOCK_SAMPLES})
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i += 1) {
      this.block[this.filled] = channel[i]
      this.filled += 1
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice(0))
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('dsh-koein-capture', DshKoeinCapture)
`
    }

    /* -------------------------------------------------------------- controller */

    /**
     * Page-wide microphone + socket singleton. One instance serves every
     * mounted slot, and it keeps running across session switches.
     */
    class KoeinController {
      constructor() {
        this.status = 'off'
        this.wakeEnabled = false
        this.dictateEnabled = false
        this.keyword = ''
        this.partial = ''
        this.lastFinal = ''
        this.error = ''
        this.ready = null
        this.autoSend = false
        this.sessionId = ''
        this.listeners = new Set()
        this.finalListeners = new Set()
        this.socket = null
        this.stream = null
        this.context = null
        this.node = null
        this.resampler = null
      }

      /** @param {() => void} listener - state subscriber. @returns {() => void} unsubscribe. */
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      /** @param {(text: string, injected: string | null) => void} listener - transcript subscriber. */
      onFinal(listener) {
        this.finalListeners.add(listener)
        return () => this.finalListeners.delete(listener)
      }

      /** @param {object} patch - state change. */
      #patch(patch) {
        Object.assign(this, patch)
        for (const listener of this.listeners) listener()
      }

      /**
       * Remember which session a transcript belongs to.
       * @param {string} sessionId - the visible session.
       */
      setSession(sessionId) {
        if (sessionId === this.sessionId) return
        this.sessionId = sessionId
        if (this.socket !== null && this.socket.readyState === 1) {
          this.socket.send(JSON.stringify({ type: 'hello', sessionId }))
        }
      }

      /**
       * Enable or disable one of the two input modes and reconcile the hardware.
       * @param {{ wakeEnabled?: boolean, dictateEnabled?: boolean }} patch - mode change.
       */
      async setMode(patch) {
        this.#patch(patch)
        if (!this.wakeEnabled && !this.dictateEnabled) {
          this.#patch({ error: '' })
          await this.stop()
          return
        }
        if (this.socket === null) await this.start()
        else this.#sendMode()
      }

      /** Left click: toggle direct speech input, no wake word needed. */
      toggleDictate() {
        void this.setMode({ dictateEnabled: !this.dictateEnabled })
      }

      /** Right click: toggle wake-word listening. */
      toggleWake() {
        void this.setMode({ wakeEnabled: !this.wakeEnabled })
      }

      /** Open the microphone and the socket. */
      async start() {
        if (this.status === 'connecting') return
        this.#patch({ status: 'connecting', error: '', keyword: '', partial: '', lastFinal: '' })
        try {
          await this.#openMic()
          await this.#openSocket()
          this.#sendMode()
        } catch (error) {
          this.#patch({ status: 'error', error: String((error && error.message) || error) })
          await this.stop()
        }
      }

      /** Tell the host which input modes this page wants. */
      #sendMode() {
        if (this.socket === null || this.socket.readyState !== 1) return
        this.socket.send(JSON.stringify({ type: 'mode', wake: this.wakeEnabled, dictate: this.dictateEnabled }))
      }

      /** Release the microphone and the socket. */
      async stop() {
        if (this.node !== null) {
          try {
            this.node.disconnect()
          } catch {
            /* already detached */
          }
          this.node = null
        }
        if (this.stream !== null) {
          for (const track of this.stream.getTracks()) track.stop()
          this.stream = null
        }
        if (this.context !== null) {
          try {
            await this.context.close()
          } catch {
            /* already closed */
          }
          this.context = null
        }
        if (this.socket !== null) {
          try {
            this.socket.close()
          } catch {
            /* already closed */
          }
          this.socket = null
        }
        this.resampler = null
        // A failed start keeps its error visible; a clean teardown is just "off".
        this.#patch({ status: this.error ? 'error' : 'off', partial: '', keyword: '' })
      }

      /** Abandon the utterance in flight. */
      cancel() {
        if (this.socket !== null && this.socket.readyState === 1) {
          this.socket.send(JSON.stringify({ type: 'cancel' }))
        }
      }

      /** Open the microphone and wire it to a sink. */
      async #openMic() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('this browser exposes no microphone API')
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        this.stream = stream

        const context = new AudioContext({ sampleRate: TARGET_RATE })
        this.context = context
        if (context.sampleRate !== TARGET_RATE) this.resampler = new Resampler(context.sampleRate, TARGET_RATE)

        const url = URL.createObjectURL(new Blob([workletSource()], { type: 'application/javascript' }))
        try {
          await context.audioWorklet.addModule(url)
        } finally {
          URL.revokeObjectURL(url)
        }

        const source = context.createMediaStreamSource(stream)
        const node = new AudioWorkletNode(context, 'dsh-koein-capture')
        const silent = context.createGain()
        silent.gain.value = 0
        node.port.onmessage = (event) => this.#onBlock(event.data)
        source.connect(node)
        node.connect(silent)
        silent.connect(context.destination)
        this.node = node
      }

      /** Open the host socket. */
      async #openSocket() {
        const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const socket = new WebSocket(`${scheme}://${window.location.host}${SOCKET_PATH}`)
        socket.binaryType = 'arraybuffer'
        this.socket = socket
        socket.onmessage = (event) => this.#onFrame(JSON.parse(String(event.data)))
        socket.onclose = () => {
          if (this.status !== 'off') this.#patch({ status: 'error', error: 'host socket closed' })
        }
        await new Promise((resolve, reject) => {
          socket.onopen = () => {
            if (this.sessionId) socket.send(JSON.stringify({ type: 'hello', sessionId: this.sessionId }))
            resolve()
          }
          socket.onerror = () => reject(new Error('cannot reach the host voice socket'))
        })
      }

      /**
       * Forward one captured block as little-endian Int16 PCM.
       * @param {Float32Array} block - microphone samples.
       */
      #onBlock(block) {
        const samples = this.resampler === null ? block : this.resampler.push(block)
        if (samples.length === 0) return
        const socket = this.socket
        if (socket === null || socket.readyState !== 1) return
        const pcm = new Int16Array(samples.length)
        for (let i = 0; i < samples.length; i += 1) {
          const value = Math.max(-1, Math.min(1, samples[i]))
          pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff
        }
        socket.send(pcm.buffer)
      }

      /**
       * Handle one host frame.
       * @param {object} frame - decoded JSON.
       */
      #onFrame(frame) {
        if (frame.type === 'ready') {
          this.#patch({ ready: frame, autoSend: frame.autoSend !== false })
          return
        }
        if (frame.type === 'state') {
          const status =
            frame.phase === 'capturing'
              ? 'capturing'
              : frame.phase === 'starting'
                ? 'connecting'
                : frame.phase === 'armed'
                  ? 'armed'
                  : 'off'
          this.#patch({ status, partial: '' })
          return
        }
        if (frame.type === 'wake') {
          this.#patch({ keyword: frame.keyword, partial: '' })
          return
        }
        if (frame.type === 'partial') {
          this.#patch({ partial: frame.text })
          return
        }
        if (frame.type === 'error') {
          this.#patch({ error: frame.message, status: 'error' })
          return
        }
        if (frame.type === 'final') {
          this.#patch({ partial: '', lastFinal: frame.text || '', error: frame.error || '' })
          for (const listener of this.finalListeners) listener(frame.text || '', frame.injected || null)
        }
      }
    }

    const controller = new KoeinController()

    /* -------------------------------------------------------------- components */

    /** Inline microphone glyph. */
    function MicIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z' }),
        h('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }),
        h('line', { x1: 12, y1: 19, x2: 12, y2: 22 }),
      )
    }

    /**
     * The single voice control, sitting left of the send button.
     *
     *   left click   toggle direct speech input (no wake word needed)
     *   right click  toggle wake-word listening
     *
     * Colour is the state: gray = off, blue = waiting for you, green = capturing.
     * @param {object} props - runtime slot props.
     * @returns {import('react').ReactElement} the control.
     */
    function KoeinMic(props) {
      const [, force] = React.useState(0)
      const [pending, setPending] = React.useState(null)
      React.useEffect(() => controller.subscribe(() => force((n) => n + 1)), [])
      React.useEffect(() => {
        if (props.sessionId) controller.setSession(String(props.sessionId))
      }, [props.sessionId])
      React.useEffect(
        () =>
          controller.onFinal((text, injected) => {
            if (injected === 'composer' && text) setPending({ text, submit: controller.autoSend })
          }),
        [],
      )

      React.useEffect(() => {
        if (pending === null) return undefined
        props.inputActions.setDraft(pending.text)
        if (!pending.submit) {
          setPending(null)
          return undefined
        }
        // Let the draft commit before submitting; the composer reads the store.
        const id = requestAnimationFrame(() => {
          props.inputActions.submit()
          setPending(null)
        })
        return () => cancelAnimationFrame(id)
      }, [pending])

      const status = controller.status
      const title =
        status === 'error'
          ? `语音出错：${controller.error}`
          : status === 'connecting'
            ? '语音：正在加载模型…'
            : status === 'capturing'
              ? '正在识别…'
              : status === 'armed'
                ? controller.dictateEnabled
                  ? '语音输入待命：直接说话（右键切换唤醒词模式）'
                  : '唤醒词监听中：说唤醒词即可（单击切换为直接语音输入）'
                : '语音已关闭（单击开始语音输入，右键开启唤醒词监听）'

      return h(
        'button',
        {
          type: 'button',
          className: 'koe-mic',
          'data-status': status,
          'aria-label': title,
          title,
          onClick: () => controller.toggleDictate(),
          onContextMenu: (event) => {
            event.preventDefault()
            controller.toggleWake()
          },
        },
        h(MicIcon, null),
      )
    }

    /**
     * Settings page: live status, wake words, and the exact model fetch command.
     * @returns {import('react').ReactElement} the page.
     */
    function KoeinSettings() {
      const [, force] = React.useState(0)
      const [state, setState] = React.useState(null)
      React.useEffect(() => controller.subscribe(() => force((n) => n + 1)), [])
      React.useEffect(() => {
        let alive = true
        const load = () =>
          fetch(STATUS_PATH, { cache: 'no-store' })
            .then((response) => response.json())
            .then((json) => {
              if (alive) setState(json)
            })
            .catch(() => {})
        load()
        const timer = setInterval(load, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const rows = []
      const ready = state !== null && state.ok === true
      rows.push(
        h(
          'div',
          { className: 'koe-row', key: 'models' },
          h('span', { className: 'koe-k' }, '模型'),
          ready
            ? h('span', null, '已就绪')
            : h(
                'span',
                { className: 'koe-bad' },
                state === null
                  ? '读取中…'
                  : `缺失：${[...(state.models?.kws || []), ...(state.models?.asr || [])].join('、')}`,
              ),
        ),
      )
      if (state) {
        rows.push(
          h(
            'div',
            { className: 'koe-row', key: 'dir' },
            h('span', { className: 'koe-k' }, '模型目录'),
            h('code', null, state.models?.dir || ''),
          ),
        )
        rows.push(
          h(
            'div',
            { className: 'koe-row', key: 'wake' },
            h('span', { className: 'koe-k' }, '唤醒词'),
            h('span', null, (state.wakeWords || []).join(' / ') || '（无）'),
          ),
        )
        if (state.rejectedWakeWords && state.rejectedWakeWords.length > 0) {
          rows.push(
            h(
              'div',
              { className: 'koe-row', key: 'rej' },
              h('span', { className: 'koe-k' }, '不可用'),
              h('span', { className: 'koe-bad' }, state.rejectedWakeWords.join(' / ')),
            ),
          )
        }
        rows.push(
          h(
            'div',
            { className: 'koe-row', key: 'inject' },
            h('span', { className: 'koe-k' }, '注入方式'),
            h('span', null, state.injectMode === 'agent' ? '宿主直接注入会话' : '输入框提交'),
          ),
        )
      }
      rows.push(
        h(
          'div',
          { className: 'koe-row', key: 'live' },
          h('span', { className: 'koe-k' }, '监听状态'),
          h('span', null, controller.status === 'off' ? '已关闭' : controller.status),
        ),
      )

      return h(
        'div',
        { className: 'koe-page' },
        h('h3', null, '语音唤醒'),
        h(
          'div',
          null,
          '唤醒词常驻本地监听，命中后自动收音、本地识别并发送。音频不出本机；识别与唤醒均由本机 sherpa-onnx 推理，无需 API Key。',
        ),
        ...rows,
        ready
          ? null
          : h(
              'div',
              null,
              '在插件目录执行：',
              h('code', null, 'node tools/download-models.mjs'),
              '（KWS 约 32 MB + ASR 约 71 MB）',
            ),
      )
    }

    /* -------------------------------------------------------------- registration */

    /**
     * Inject the plugin stylesheet once.
     * @returns {() => void} disposer.
     */
    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-koein'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    /**
     * Client plugin body.
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(installStyles, 'dsh-koein: styles')

      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          { name: 'conversation.input.right', id: 'koein-mic', order: 8 },
          KoeinMic,
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'koein', order: 62, label: '语音唤醒' },
          KoeinSettings,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
