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
.koe-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer}
.koe-btn:hover,.koe-btn:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l1)}
.koe-btn[data-on="true"]{color:var(--dsw-alias-label-primary)}
.koe-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.koe-btn[data-state="listening"] .koe-dot{background:#3ba55d;box-shadow:0 0 0 0 rgba(59,165,93,.55);animation:koe-pulse 2s infinite}
.koe-btn[data-state="awake"] .koe-dot{background:#e8a33d}
.koe-btn[data-state="error"] .koe-dot{background:#d9534f}
.koe-btn[data-state="connecting"] .koe-dot{background:#7a7a7a}
@keyframes koe-pulse{0%{box-shadow:0 0 0 0 rgba(59,165,93,.5)}70%{box-shadow:0 0 0 7px rgba(59,165,93,0)}100%{box-shadow:0 0 0 0 rgba(59,165,93,0)}}
.koe-strip{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 10px;border-radius:10px;background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.koe-strip b{color:var(--dsw-alias-label-primary);font-weight:500}
.koe-strip .koe-partial{opacity:.75}
.koe-strip .koe-err{color:#d9534f}
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
        this.keyword = ''
        this.partial = ''
        this.lastFinal = ''
        this.error = ''
        this.ready = null
        this.autoSend = true
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

      /** Connect the socket and open the microphone. */
      async start() {
        if (this.status === 'connecting' || this.status === 'listening' || this.status === 'awake') return
        this.#patch({ status: 'connecting', error: '', keyword: '', partial: '', lastFinal: '' })
        try {
          await this.#openMic()
          await this.#openSocket()
          // The engine runs in a separate process and loads its models on first
          // use; the host sends `state: listening` once it is actually ready.
          this.#patch({ status: 'connecting' })
        } catch (error) {
          this.#patch({ status: 'error', error: String((error && error.message) || error) })
          await this.stop()
        }
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
        this.#patch({ status: 'off', partial: '', keyword: '' })
      }

      /** Toggle between running and stopped. */
      toggle() {
        if (this.status === 'off' || this.status === 'error') void this.start()
        else void this.stop()
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
          const status = frame.state === 'awake' ? 'awake' : frame.state === 'starting' ? 'connecting' : 'listening'
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
          this.#patch({ error: frame.message })
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

    /**
     * Composer-left microphone toggle: the plugin's primary control.
     * @param {object} props - runtime slot props.
     * @returns {import('react').ReactElement} the control.
     */
    function KoeinButton(props) {
      const [, force] = React.useState(0)
      React.useEffect(() => controller.subscribe(() => force((n) => n + 1)), [])
      React.useEffect(() => {
        if (props.sessionId) controller.setSession(String(props.sessionId))
      }, [props.sessionId])

      const on = controller.status === 'listening' || controller.status === 'awake'
      const label =
        controller.status === 'off'
          ? '语音唤醒'
          : controller.status === 'connecting'
            ? '连接中…'
            : controller.status === 'awake'
              ? '聆听中…'
              : controller.status === 'error'
                ? '语音出错'
                : '语音监听中'

      return h(
        'button',
        {
          type: 'button',
          className: 'koe-btn',
          'data-on': String(on),
          'data-state': controller.status,
          title: on ? '点击停止语音唤醒' : '点击开启语音唤醒（常驻本地监听，不上传音频）',
          onClick: () => controller.toggle(),
        },
        h('span', { className: 'koe-dot' }),
        h('span', null, label),
      )
    }

    /**
     * Composer-dock status strip: shows what the engines heard and performs the
     * composer injection when the host asks this half to.
     * @param {object} props - runtime slot props.
     * @returns {import('react').ReactElement | null} the strip, or null when idle.
     */
    function KoeinStatus(props) {
      const [, force] = React.useState(0)
      const [pending, setPending] = React.useState(null)
      React.useEffect(() => controller.subscribe(() => force((n) => n + 1)), [])
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

      if (controller.status === 'off') return null

      const parts = []
      if (controller.status === 'error' || controller.error) {
        parts.push(h('span', { className: 'koe-err', key: 'e' }, `语音唤醒：${controller.error}`))
      } else if (controller.status === 'connecting') {
        parts.push(h('span', { key: 'c' }, '语音唤醒：正在打开麦克风…'))
      } else if (controller.status === 'awake') {
        parts.push(h('b', { key: 'a' }, `已唤醒（${controller.keyword}）`), h('span', { key: 'a2' }, '我在听…'))
      } else {
        parts.push(h('span', { key: 'l' }, '语音监听中，说唤醒词即可开口'))
      }
      if (controller.partial) parts.push(h('span', { className: 'koe-partial', key: 'p' }, controller.partial))
      else if (controller.lastFinal) parts.push(h('span', { className: 'koe-partial', key: 'f' }, controller.lastFinal))

      return h('div', { className: 'koe-strip' }, parts)
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

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          { name: 'conversation.input.left', id: 'koein', order: 12 },
          KoeinButton,
        ),
      )
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          { name: 'conversation.input.dock', id: 'koein-status', order: 12 },
          KoeinStatus,
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
