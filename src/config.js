/**
 * Plugin configuration schema and its resolution into a runtime config.
 * @module dsh-koein/config
 */
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Default KWS model directory name (Chinese, 3.3M params, open vocabulary). */
export const DEFAULT_KWS_MODEL = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
/**
 * Default ASR model directory name: X-ASR 480ms streaming zipformer transducer,
 * Chinese + English with automatic punctuation, int8 (~128 MB download).
 */
export const DEFAULT_ASR_MODEL = 'sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'

/** Cordis config schema for the plugin row. */
export const Config = z.object({
  wakeWords: z
    .array(z.string())
    .default(['你好小鲸', '小鲸小鲸'])
    .description('唤醒词。命中其一即唤醒；中文可任意自定义（按模型词表切分声母/韵母）。'),
  keywordsFile: z
    .string()
    .default('')
    .description('已有的 sherpa-onnx keywords.txt 路径；非空时忽略 wakeWords。'),
  keywordsScore: z
    .number()
    .default(1.0)
    .description('关键词增强分数。漏检多就调大，误唤醒多就调小。'),
  keywordsThreshold: z
    .number()
    .default(0.25)
    .description('触发阈值。越大越难触发（越不容易误唤醒）。'),
  numTrailingBlanks: z
    .number()
    .default(1)
    .description('关键词后的空白帧数；唤醒词含重叠 token 时调大（如 8）。'),

  modelDir: z
    .string()
    .default('')
    .description('模型根目录。留空 = $DSH_HOME/koein-models。'),
  kwsModel: z.string().default(DEFAULT_KWS_MODEL).description('唤醒词模型目录名。'),
  asrModel: z.string().default(DEFAULT_ASR_MODEL).description('语音识别模型目录名。'),
  numThreads: z.number().default(2).description('每个引擎的推理线程数。'),

  autoSend: z
    .boolean()
    .default(false)
    .description('识别完成即发送。默认 false = 只把文字放进输入框，由你确认后发送。'),
  injectMode: z
    .union(['composer', 'agent'])
    .default('composer')
    .description(
      'composer = 走输入框正常提交（默认）；agent = 由宿主直接以用户消息注入会话（后台标签页也可用）。',
    ),
  beep: z.boolean().default(true).description('唤醒时播放提示音（由浏览器合成，无需音频文件）。'),

  silenceMs: z.number().default(800).description('说完后静音多久判定一句话结束。'),
  onsetTimeoutMs: z
    .number()
    .default(4000)
    .description('唤醒后等待开口的最长时间；超时则回到休眠。'),
  maxUtteranceMs: z.number().default(20000).description('单句最长时长，超过即强制结束并识别。'),
  minUtteranceMs: z.number().default(300).description('短于此时长的语音丢弃（多半是噪声）。'),
  energyThreshold: z
    .number()
    .default(0.012)
    .description('语音起始能量阈值（RMS）。环境噪声大就调大。'),
  stayAwakeMs: z
    .number()
    .default(0)
    .description('一句话结束后继续聆听的时长，便于连续追问；0 = 每次都要说唤醒词。'),
})

/**
 * Resolve the runtime configuration, filling in derived paths and defaults.
 *
 * The schema is applied here even though cordis already validated the row: a
 * caller that mounts the plugin directly (tests, another plugin) may pass a
 * partial object, and a missing numeric field would otherwise reach the native
 * engines as `NaN` and silently stop decoding.
 * @param {Record<string, unknown>} config - row config, possibly partial.
 * @returns {Record<string, unknown>} resolved configuration.
 */
export function resolveConfig(config) {
  const input = Config(config ?? {})
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const modelDir = String(input.modelDir || '').trim() || path.join(home, 'koein-models')
  return {
    ...input,
    modelDir,
    kwsDir: path.join(modelDir, input.kwsModel || DEFAULT_KWS_MODEL),
    asrDir: path.join(modelDir, input.asrModel || DEFAULT_ASR_MODEL),
    keywordsFile: String(input.keywordsFile || '').trim(),
    wakeWords: (input.wakeWords || []).map((word) => String(word).trim()).filter(Boolean),
  }
}
