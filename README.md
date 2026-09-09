# dsh-koein 🎙️

> **こえインプット** — 用说的，别用敲的。

**语音输入插件**，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 而做：说唤醒词唤醒，或者点一下麦克风直接开口。收音、识别全在本机完成，识别结果填进输入框，你确认后再发。

关键词：`语音唤醒` · `wake word` · `keyword spotting` · `本地 ASR` · `offline speech-to-text` · `无 API Key`

音频不出本机，不需要 API Key，不需要联网，也不占用输入法——唤醒之后直接说，说完自动出字。

```
你说：小鲸小鲸    →  提示音  →  你说：帮我把 build 脚本里的端口改成 8080  →  自动发送
      ↑ KWS 常驻监听            ↑ ASR 只在这一段工作
```

## 它和别的语音插件有什么不同

这个插件**本身就是完整的语音输入**——本地流式 ASR、边说边出字幕、说完自动发送，不依赖输入法，也不需要再装别的语音插件。区别在于**入口**：常见的语音插件要你先点按钮或按热键进入麦克风，它则用一个唤醒词把整条链路点着。

| | 常见语音输入插件 | dsh-koein |
|---|---|---|
| 进入方式 | 点麦克风按钮 / 按热键 | 说唤醒词，或点一下麦克风直接说 |
| 常驻成本 | 不常驻（进入才开 ASR） | 常驻 KWS，实测解码速度约 **50 倍实时**（8 秒音频约 150ms） |
| 唤醒判定 | 整段 ASR 后匹配文本 | 真正的关键词检测（open-vocabulary KWS），ASR 全程不参与 |
| 唤醒词 | 固定或需改代码 | 任意中文短语，按模型词表自动切分 token |
| 识别 | 视插件而定 | 本地流式 ASR，边说边出字幕 |

一句话：**它把语音输入从"要点一下"变成"说一句"**。唤醒之后不用再碰键鼠，也不用去找输入法。

## 工作原理

一条音频流，两个引擎，用唤醒事件切换：

```
浏览器麦克风 ──16kHz PCM──▶ 宿主进程（不含原生代码）
                              │  WebSocket ↔ IPC 转发
                              ▼
                          语音引擎子进程（fork）
                              ├── listening: KWS（3.3M 中文模型，常驻）
                              │        命中唤醒词 ──▶ 提示音 + 状态切换
                              └── awake:     ASR（14M 中文流式模型）
                                       端点检测（能量 RMS + 静音挂起）
                                       识别完成 ──▶ 注入会话
```

- **KWS**（`sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`，int8 编码器 4.8 MB）：开放式词表，不重训模型就能换唤醒词。
- **ASR**（`sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`，int8 约 24 MB）：流式输出，界面上能看到实时字幕。
- **端点检测**：唤醒词已经告诉你用户在说话了，所以不需要再挂一个 VAD 模型——用 RMS 能量 + 静音挂起就够，少一次推理。

唤醒词之后**紧跟着**说指令也可以（"小鲸小鲸，打开配置文件"）：唤醒时会把 150ms 预滚音频喂给 ASR，避免吃掉第一个音素。

### 为什么语音引擎跑在独立子进程里

这不是洁癖，是必需的。`sherpa-onnx-node` 自带 `onnxruntime.dll` **1.27**（ORT API 27），而同一 profile 里的记忆插件 `dsh-mihaji` 通过 `@huggingface/transformers` 自带 `onnxruntime.dll` **1.21**（API ≤ 21）。Windows 在**进程内按 DLL 名**解析依赖，谁先加载谁生效：

```
The requested API version [27] is not available, only API versions [1, 21] are supported.
exit code -1073741819   ← 0xC0000005 访问违例，整个宿主进程崩溃
```

把引擎放进 `fork()` 出来的子进程，同时解决两件事：

1. **DLL 命名空间隔离**——子进程只加载 sherpa 自己的 ORT，冲突不存在。
2. **崩溃隔离**——原生 addon 再怎么崩，也只是子进程退出；宿主照常运行，界面收到报错，下一次点麦克风自动重启子进程。

`test/isolation.test.mjs` 静态遍历 `src/index.js` 的 import 图，断言宿主半**永远不导入** `sherpa-onnx-node`，并真的 `SIGKILL` 掉子进程验证宿主存活与自动重启。

代价：首次点麦克风要等约 2 秒加载模型（按钮显示"连接中…"），这期间说的唤醒词会被丢弃。

## 安装

### 1. 下载模型（约 103 MB，一次性）

```bash
cd <插件目录>
node tools/download-models.mjs
```

默认落到 `$DSH_HOME/koein-models`。也可以指定目录：

```bash
node tools/download-models.mjs D:/models
# 然后配置 modelDir: D:/models
```

### 2. 装进 profile

```bash
dsh plugin --profile web add <本目录或 npm/git 包名>
```

`dsh plugin add` 会自动把包加进该 profile 的 `dsh.profile.bundles`，并套用它自带的 `cordis.patch.yml`。

### 3. 重启

```bash
dsh web
```

插件是 bundle 行，**必须重启**才生效。

装好后：**发送按钮左边**会出现一个麦克风图标，它就是全部的语音控制。

## 一个按钮，两种说话方式

| 手势 | 作用 |
|---|---|
| **单击** | 开/关「直接说话」——不用唤醒词，点开就直接说 |
| **右键单击** | 开/关「唤醒词监听」——说唤醒词即可开口 |

颜色就是状态，不需要额外的指示条：

| 颜色 | 含义 |
|---|---|
| 灰 | 停止 |
| 绿 | **现在说话就会进输入框**（左键单击直接听写，或唤醒词已命中） |
| 蓝 | 正在等唤醒词（右键单击后） |
| 红 | 出错，鼠标悬停看原因 |

识别中时绿色会轻微呼吸，表示确实听到了。

两种模式共用一条音频流，所以听写开着时唤醒词监听自动让位。识别出来的文字**默认只填进输入框**，不直接发送——你看一眼再按回车。想让它说完就发，把 `autoSend` 改成 `true`。

"设置 → 语音唤醒"里能看到模型状态和当前生效的唤醒词。

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里覆盖（patch 是 **whole-replace** 语义，要写全字段）：

```yaml
- id: koein
  config:
    wakeWords:
      - 你好小鲸
      - 小鲸小鲸
    autoSend: false
    injectMode: composer
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `wakeWords` | `['你好小鲸','小鲸小鲸']` | 唤醒词，可任意中文短语 |
| `keywordsFile` | `''` | 已有的 sherpa-onnx `keywords.txt`；非空则忽略 `wakeWords` |
| `keywordsScore` | `1.0` | 关键词增强分数，漏检多就调大 |
| `keywordsThreshold` | `0.25` | 触发阈值，**误唤醒多就调大** |
| `numTrailingBlanks` | `1` | 关键词后空白帧数，唤醒词含重叠 token 时调大（如 8） |
| `modelDir` | `$DSH_HOME/koein-models` | 模型根目录 |
| `numThreads` | `2` | 两个引擎各自的推理线程数 |
| `autoSend` | `false` | 识别完直接发送；默认 `false` 只填进输入框，由你确认后发送 |
| `injectMode` | `composer` | `composer` = 走输入框正常提交；`agent` = 宿主直接以用户消息注入会话（后台标签页也能用） |
| `silenceMs` | `800` | 说完静音多久判定句子结束 |
| `onsetTimeoutMs` | `4000` | 唤醒后等开口的最长时间 |
| `maxUtteranceMs` | `20000` | 单句最长时长 |
| `minUtteranceMs` | `300` | 更短的语音丢弃（多半是噪声） |
| `energyThreshold` | `0.012` | 语音起始能量阈值（RMS），环境噪声大就调大 |
| `stayAwakeMs` | `0` | 一句话结束后继续聆听的时长，便于连续追问；`0` = 每次都要说唤醒词 |

## 调唤醒词

唤醒词质量取决于你的声音、麦克风和房间——这是唯一无法用官方测试音频验证的东西。录一段自己念唤醒词的 16kHz 单声道 WAV，然后：

```bash
node tools/probe-wake-word.mjs "你好小鲸" 我的录音.wav
# 调参重试
node tools/probe-wake-word.mjs "你好小鲸" 我的录音.wav 2.0 0.15
```

它会告诉你是否命中、在第几秒命中，方便对着调 `keywordsScore` / `keywordsThreshold`。

**选词建议**：3–4 个音节、声母区分度高、日常对话里不容易顺口说出来。`你好小鲸`、`小鲸小鲸` 都不错；单音节词（如"鲸"）误唤醒率会高很多。

## 排错

| 现象 | 处理 |
|---|---|
| 设置页显示"模型缺失" | 跑 `node tools/download-models.mjs`，或检查 `modelDir` |
| 唤醒词在设置页显示"不可用" | 该短语无法用模型词表表示（如含 emoji），换一个说法 |
| 一直误唤醒 | 调大 `keywordsThreshold`（如 0.4），或换更长的唤醒词 |
| 喊了没反应 | 用 `tools/probe-wake-word.mjs` 确认能命中；调低 `keywordsThreshold` |
| 唤醒后不出字 | 调大 `silenceMs`（说话停顿多）或调低 `energyThreshold` |
| 切到别的会话后发错地方 | `injectMode: composer` 跟随当前会话；跨会话请用 `agent` 模式 |
| 浏览器不给麦克风 | 页面必须走 `https://` 或 `localhost`，且需要麦克风权限 |

## 隐私

- 音频只在**本机进程内**从浏览器流到 DSH 宿主，不经过任何网络服务。
- 唤醒和识别都是本机 sherpa-onnx 推理，无 API Key、无云调用。
- KWS 全程运行；ASR **只在唤醒之后**的那一段音频上运行。
- 录音不落盘。

## 开发

```bash
npm test        # 4 个测试文件
```

| 测试 | 覆盖 |
|---|---|
| `test/isolation.test.mjs` | 宿主 import 图不含原生 addon；`SIGKILL` 引擎子进程后宿主存活并自动重启 |
| `test/keywords.test.mjs` | 中文→token 切分与官方 `test_keywords.txt` **逐行完全一致** |
| `test/pipeline.test.mjs` | 真实 WAV 走完 KWS→唤醒→ASR→出稿，并验证静音不误唤醒 |
| `test/socket.test.mjs` | 真起 HTTP+WebSocket 服务器，灌真实 PCM，验证帧协议与两种注入模式 |
| `test/client.test.mjs` | 用假 `window.__ModuleLoader__` 执行 client bundle，注册三个 Slot 并真实渲染 |
| `test/profile-resolve.mjs` | 以 profile 为 cwd 验证包解析、挂载与原生引擎加载 |

设计上刻意**不做打包**：宿主半是普通 ESM，浏览器半是手写的 `window.__ModuleLoader__.load({id, factory})` 包装（正是打包器会产出的形态）。改完源码重启即可，没有构建步骤。

## 许可

MIT
