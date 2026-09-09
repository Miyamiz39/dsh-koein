#!/usr/bin/env node
/**
 * Fetch the two sherpa-onnx models this plugin runs.
 *
 * Deliberately a one-shot script rather than a hidden runtime download: model
 * acquisition is a ~103 MB network operation the user should see and control.
 * @module dsh-koein/tools/download-models
 */
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline as streamPipeline } from 'node:stream/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'
const MODELS = [
  {
    dir: 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01',
    url: `${RELEASE}/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2`,
    label: '唤醒词模型 (KWS, 中文, 3.3M)',
  },
  {
    dir: 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
    url: `${RELEASE}/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2`,
    label: '识别模型 (ASR, 中文流式, 14M)',
  },
]

const target = process.argv[2] || process.env.DSH_KOEIN_MODELS || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'koein-models')

/**
 * Download one URL to a file, reporting progress.
 * @param {string} url - source.
 * @param {string} file - destination.
 */
async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const total = Number(response.headers.get('content-length') || 0)
  let seen = 0
  let lastTick = 0
  const body = Readable.fromWeb(response.body)
  body.on('data', (chunk) => {
    seen += chunk.length
    const now = Date.now()
    if (now - lastTick < 400) return
    lastTick = now
    const mb = (seen / 1048576).toFixed(1)
    const pct = total ? ` ${((seen / total) * 100).toFixed(0)}%` : ''
    process.stdout.write(`\r    ${mb} MB${pct}   `)
  })
  await streamPipeline(body, createWriteStream(file))
  process.stdout.write('\r')
}

mkdirSync(target, { recursive: true })
console.log(`模型目录: ${target}\n`)

for (const model of MODELS) {
  const destination = path.join(target, model.dir)
  if (existsSync(destination)) {
    console.log(`✓ ${model.label} 已存在，跳过`)
    continue
  }
  const archive = path.join(target, `${model.dir}.tar.bz2`)
  console.log(`↓ ${model.label}`)
  await download(model.url, archive)
  console.log('    解压…')
  try {
    await execFileAsync('tar', ['-xjf', archive, '-C', target])
  } catch (error) {
    console.error(
      `\n解压失败：${error.message}\n` +
        `本机缺少可用的 tar。请手动解压 ${archive} 到 ${target} 后重试。`,
    )
    process.exitCode = 1
    break
  }
  rmSync(archive, { force: true })
  console.log('✓ 完成')
}

console.log('\n如果 dsh 正在运行，重启 dsh web 让插件重新加载模型状态。')
