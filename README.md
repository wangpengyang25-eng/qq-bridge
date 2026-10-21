# QQ 群 AI 助手桥（大肥鱼）

把 AI 助手接到 QQ：**群里被 @ 才回答**，管理员私聊可随时**接入 / 断开**。

纯 Node 内置模块，**零第三方依赖** —— 不用 `npm install`，填个 Key 就能跑。
自带 **125 项自测**：`node selftest.mjs` 直接跑，不用装任何东西。

> **环境要求：Node 22+。** 生产链路用的是 Node 内置的全局 `WebSocket`（`src/onebot.mjs`），
> 它从 Node 22 起才默认可用；更早的版本会在启动时直接被拦下并提示。

[![selftest](https://github.com/wangpengyang25-eng/qq-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/wangpengyang25-eng/qq-bridge/actions/workflows/test.yml)

> ### 来源与署名
>
> 本项目的初始版本由群友开发，于 2026-09-30 以交付包形式分享给我（已脱敏：不含密钥与真实 QQ 号），
> 此后由我维护。原始贡献者没有留下署名信息 —— **如果你是作者之一，欢迎开 Issue，我会立刻补上。**
>
> 本仓库以 MIT 协议开源；原始版本的贡献者应享有的权利，不因本许可证声明而改变。

### 本仓库与初始版本的差异

初始版本之后的改动集中在**换机器部署**这件事上。这些改动发生在建立版本库（2026-10-21）之前，
所以没有逐条提交记录可查，下面按文件列出：

- **`src/logger.mjs`** —— 修掉一个能把磁盘写满的递归：stdout 被管道关闭时 `console.log` 抛 EPIPE，
  触发 `uncaughtException` → 处理器再调 `log()` → 再抛，无限递归。实测 2 分半写出
  **98MB / 131,953 次同一条堆栈**。加了 `console.log` 的 try/catch 与 `inLog` 重入锁，并补了回归用例。
- **`watch-login.mjs`** —— 给"NapCat 注入失败"这种**静默故障**加提前诊断：
  注入成功时 WebUI 端口会先于 QQ 登录监听，用它当判据，25 秒没出现就直接提示原因。
- **`start.bat` / `一键启动.bat`** —— 去掉写死的 node 绝对路径，改为探测 `node` 与 `C:\Program Files\nodejs`。
- 另有人设、表情映射与路由细节的若干调整。

---

## 现状（2026-09-30）

**只有一条通道：NapCat（OneBot v11）。** QQ 官方机器人通道已从代码里移除。

原因：QQ 开放平台**不给个人开发者群聊场景权限**（四个"服务范围"开关打不开，群聊需企业认证），
腾讯官方也明确不建议 AI 机器人进群。而本项目从一开始的诉求就是"群里 @ 即答"，
所以官方通道留着只会让代码里有两条永远只用得上一条的路。官方侧的协议细节与排查结论
仍保留在 `HANDOFF.md`，需要时再翻。

---

## 一、它是什么

```
群友 ──@机器人──▶ QQ 服务器 ⇄ 本机 QQ 客户端 + NapCat（注入）
                                      │
                                OneBot WS :3001
                                      ▼
                                 bridge.mjs ──HTTPS──▶ 模型 API
                                      │
                                 回答原路返回
```

四件事说清楚：

1. **只看 @ 消息才回答**（`mode.requireAt`）。群里发什么都不理。
2. **但会"偷偷听"** —— 群里的非 @ 消息会被记进内存缓冲（**不花 token**），
   被 @ 时取最近几句当背景。这样你问"那个方案靠谱吗"，它知道"那个"指什么。
3. **只做问答**。群消息不会流进本机 agent，不读文件、不跑命令。
4. **开关在私聊**。只有管理员私聊的 `/on`、`/off` 生效。
5. **会发表情包**（可选）—— 情绪明显时甩一张，一次对话最多一张。
6. **会连着发几条** —— 模型写的每个自然段单独成一条消息；只有第一条 @ 你，
   后面几条不带 @ 也不带引用，就像人打字分几次发完。
7. **偶尔会主动接一句**（`proactive`，**默认关**）—— 群里提到它的名字但没 @ 时，
   像个群友那样搭一句。闸门都在规则侧，不会每条消息都去问模型。

---

## 二、启动（双击一次就够）

双击 **`qq-bridge\一键启动.bat`**，它会按顺序做完三件事：

1. 拉起 NapCat（QQ 机器人）
2. **需要扫码时自动弹出登录二维码**（`napcat\NapCat.Shell\cache\qrcode.png`）
3. 检测到登录成功（OneBot 的 3001 端口开始监听）后，自动把 `bridge.mjs` 拉起来

看到这行就说明桥活了：

```
[onebot] WebSocket 已连接
[onebot] 登录身份：1000000001 (蓝色大肥鱼)
[boot] 就绪：蓝色大肥鱼
```

窗口是运行日志，**别关**；`Ctrl+C` 停止。

> 判据说明：NapCat 是注入本机 QQ 进程的，没法"连上就算登录好"。
> 实测确认 **QQ 登录成功前 3001 端口不会监听**，所以等待器就用"3001 能连上"当唯一判据。
>
> 若快速登录成功，就不会出现二维码，等待器会直接跳到第 3 步。

---

## 三、填配置

编辑 `config.json`，至少填模型 Key：

```jsonc
{
  "transport": "onebot",
  "onebot": { "wsUrl": "ws://127.0.0.1:3001" },
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "你的模型 API Key",
    "model": "deepseek-flash"
  }
}
```

模型接口是 **OpenAI 兼容协议**，换服务商只改这三个字段：

| 服务商 | baseUrl | model 示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-flash`（快，支持图片）/ `deepseek-v4-pro`（纯文本，更强） |
| 阿里通义 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` |

> ⚠️ 模型名**必须在请求里指定**，不是服务端后台设置。
> DeepSeek 2026-09 线上只有 `deepseek-flash` 与 `deepseek-v4-pro`，老的 `deepseek-chat` 已失效。

---

## 四、绑定管理员

NapCat 通道拿到的是真实 **QQ 号**，所以比官方通道简单：

**方式 A：自动绑定（省事）**
`bot.admins` 留空，然后**由你本人第一个私聊机器人**。程序会把这个 QQ 号绑定为管理员并写入 `state.json`，同时回你一条确认。

> ⚠️ 前提是机器人还没被别人私聊过。建议拉起来就立刻绑定。

**方式 B：手动指定（稳妥）**
先私聊发 `/id`，把返回的 QQ 号填进 `config.json`：

```jsonc
"bot": { "admins": ["1000000002"] }
```

填了 `admins` 之后，自动绑定立即失效，只有列表里的号是管理员。

---

## 五、管理指令（只在私聊里有效）

| 指令 | 作用 |
|---|---|
| `/on` | 接入。群里 @ 机器人正常回答 |
| `/off` | 断开。群里 @ 机器人**完全静默**（消息仍会收到，只是不出声） |
| `/status` | 查看开关、模型、限流、群聊背景、模型档位等状态 |
| `/id` | 查看自己的 QQ 号与当前会话标识 |
| `/clear` | 清空本私聊的对话上下文 |
| `/ctx` | 查看"群聊背景"记录了什么；`/ctx clear` 清空 |
| `/sticker` | 看表情包情绪表；`/sticker 卖萌` 立刻试发一张 |
| `/chime` | 主动插话开关：`on` / `off` / `auto`（跟随配置）/ `status` |
| `/help` | 指令列表 |

开关状态存在 `state.json`，**重启后保持上次状态**。

---

## 六、参数速查（`config.json`）

| 路径 | 默认 | 说明 |
|---|---|---|
| `transport` | `onebot` | 目前只支持 `onebot` |
| `onebot.wsUrl` | `ws://127.0.0.1:3001` | NapCat 的 OneBot WS 服务端地址 |
| `bot.admins` | `[]` | 管理员 QQ 号，留空则自动绑定首个私聊者 |
| `bot.allowedGroups` | `[]` | 允许响应的群号，留空 = 全部群（可用 `/id` 查） |
| `bot.replyWithQuote` | `true` | 群聊回复时引用原消息 |
| `mode.enabledOnStart` | `true` | 启动时是否默认接入 |
| `mode.requireAt` | `true` | 仅回答模式：群里必须 @ 才响应 |
| `mode.groupShareContext` | `true` | 同群共享一段对话上下文 |
| **`llm.adaptive`** | `true` | **按难度自动切换推理强度与输出上限** |
| `llm.effort` / `llm.effortHard` | `low` / `high` | 简单题 / 难题的推理强度 `low`/`high`/`max` |
| `llm.maxTokens` / `llm.maxTokensHard` | `400` / `1200` | 简单题 / 难题的输出上限 |
| `llm.systemPromptFile` | `persona.txt` | 人设文件，存在时覆盖 `llm.systemPrompt` |
| **`llm.fewShotFile`** | `fewshot/A-萌系卖萌.txt` | **示范问答文件，用来换说话风格**（见第七节） |
| `llm.historyLimit` | `12` | 每次携带的最近历史条数 |
| `llm.historyCompactAt` | `24` | 历史超过这个条数就压缩一次（折叠进摘要） |
| `llm.summaryMaxChars` | `400` | 早前对话摘要的字数上限 |
| `search.enabled` | `true` | 联网搜索（抓 cn.bing.com，**不需要第三方 Key**） |
| `search.maxResults` / `cooldownMs` | `5` / `15000` | 每次取几条 / 同会话两次搜索的最小间隔 |
| **`search.rules.enabled`** | `true` | **规则前置**：时效性问题在本轮消息里加一句定向提示，提高"该搜就搜"的命中率 |
| `search.maxRoundsPerReply` | `2` | 单次回答最多几轮工具调用，防死循环 |
| **`calc.enabled`** | `true` | **本地计算器** `calc`：零 API 成本，避免心算出错 |
| **`tools.datetime`** | `true` | **日期计算** `time_diff`：相差几天 / 离某天还有几天，纯本地 |
| **`tools.random`** | `true` | **随机** `random`：掷骰、从候选抽一个、随机整数 |
| **`tools.fetchUrl`** | `true` | **读网页** `fetch_url`：把链接正文读回来（**已屏蔽本机与内网地址**） |
| `tools.fetchMaxChars` | `3000` | 读网页时最多取多少字喂给模型 |
| `tools.maxRoundsPerReply` | `2` | 单次回答最多几轮工具调用（优先于 `search.maxRoundsPerReply`） |
| **`stickers.enabled`** | `true` | **表情包**：模型可按「情绪名」发本地表情（见第七节） |
| **`stickers.activeSet`** | `04-线条狗` | 用哪一套表情，值是 `stickers/` 下的**目录名** |
| `stickers.position` | `after` | `after` = 先文字后表情；`before` = 先表情后文字 |
| `vision.enabled` | `true` | 是否识别图片 |
| `vision.maxBytes` / `maxImages` | `2097152` / `2` | 单张图上限 2MB（超了不发，省 token）/ 一条消息最多几张 |
| **`ambient.enabled`** | `true` | **群聊被动上下文**：记录群里非 @ 消息，被 @ 时当背景 |
| **`ambient.smartInject`** | `true` | **按需注入**：只有出现指代/承接信号才带背景（省 token）。`false` = 每次都带 |
| `ambient.maxKeep` | `30` | 每群最多记多少条（环形缓冲） |
| `ambient.injectItems` / `injectMaxChars` | `8` / `500` | 注入几条 / 注入文本总字数上限 |
| **`proactive.enabled`** | `false` | **主动插话**：不被 @ 时偶尔接一句（默认关，见第八节） |
| `proactive.names` | `[]` | 触发词，提到这些名字但没 @ 时考虑插话。留空 = 机器人昵称 + 大肥鱼 |
| `proactive.onQuestion` | `false` | 放宽到"有人征求意见"也触发（这种才要求群里够热闹） |
| `proactive.onImage` | `false` | 放宽到"有人发了图/表情包"也触发 |
| `proactive.minIntervalMs` | `600000` | 同一个群两次插话的最小间隔 |
| `proactive.dailyLimit` | `20` | 每天最多插几次 |
| `proactive.windowMs` / `minActivity` | `180000` / `3` | 判断"群里够不够热闹"的窗口与条数门槛 |
| **`proactive.initiative.enabled`** | `false` | **主动发起谈话**：没人说话也会开口（默认关，见第十三节） |
| `proactive.initiative.chime.enabled` | `true` | 冷场接话（跟总开关一起打开即可用） |
| `proactive.initiative.callout.enabled` | `false` | 按人点名（**@ 人有社交压力，单独开关**） |
| `proactive.initiative.dailyLimit` | `12` | 全局每天最多主动说几次（两档共用） |
| `proactive.initiative.quietHours` | `{"start":1,"end":8}` | 免打扰时段（本地时间，跨零点自动处理） |
| `members.enabled` | `true` | 成员档案：记录群友互动与亲密度（见第十二节） |
| `members.flushMs` / `maxMembers` | `60000` / `500` | 多久落盘 / 最多记多少人 |
| `limits.enabled` | `true` | 频率限制总开关 |
| `limits.userCooldownMs` | `10000` | 同一人在同一会话两次提问的最小间隔（**静默**丢弃） |
| `limits.sessionCooldownMs` | `3000` | 同一会话两次回复的最小间隔（**静默**丢弃） |
| `limits.maxConcurrent` | `3` | 全局同时处理请求数上限 |
| `limits.hourlyLimitPerSession` | `300` | 每会话每小时最多回答次数（超了回一句提示） |
| `output.maxCharsPerMessage` | `900` | 单条消息最大字数，超出自动分片 |
| `output.maxPartsGroup` / `maxPartsPrivate` | `5` / `4` | 群聊 / 私聊最多分几条，超出截断（防刷屏） |

---

## 七、人设、示范与表情包

**人设**：`persona.txt`，纯文本，整段作为 system prompt 的开头。
启动日志会打印实际用的是哪个文件：`[boot] 人设来源：persona.txt`

**示范问答（few-shot）**：`fewshot/` 目录，见 `fewshot/说明.md`。
换风格只改一行：

```jsonc
"llm.fewShotFile": "fewshot/C-技术顾问.txt"
```

现有六套性格：`A-萌系卖萌`（默认）/ `B-幽默风趣` / `C-害羞腼腆` / `D-大方爽朗` / `E-腹黑毒舌` / `F-元气活力`。
每套都是「性格 + 说话习惯 + 3~5 条示范问答」，对照表见 `fewshot/说明.md`。

### 表情包

机器人可以按「情绪名」发表情。当前一套：**`04-线条狗`**（43 张动态 GIF / 43 个情绪）。

- 看全套图与情绪名：浏览器打开 **`stickers/预览.html`**
- 换套装：把 `stickers/` 下的目录名填进 `config.json` 的 `stickers.activeSet`，重启
- 立刻试一张：管理员私聊发 `/sticker 加油`；看情绪表发 `/sticker list`

**频率只在提示词里控制，代码层不做节流。** 人设写的是
「情绪明显时才发表情，一次对话最多一张」；同一次回答里也天然只会发一张
（模型若在一轮里多次索要，后一次会覆盖前一次）。

之所以把冷却和每小时上限去掉：加了之后它在该发的时候反而发不出来，
表现就是"气氛到了却干巴巴只回字"，比多发几张更别扭。想调松紧就改人设那两行。

表情是**单独一条消息**发出去的（不带 @、不带引用），看起来才像群友随手甩的图。
目录约定与版权说明见 `stickers/说明.md`。
留空 `""` 则不加载任何示范。启动日志会打印 `[boot] 示范来源：...`。

---

## 八、为什么这样设计（省 token 的三处关键）

1. **注入当前日期** —— 模型自带"今天几号"，所以"还有几天放假"这类问题**直接算，不用联网**。
   实测：改前需要搜一轮，改后 **0 次搜索**。
2. **稳定前缀 + 追加式历史** —— DeepSeek 会把「从第 0 个 token 起完全一致的前缀」按
   约 1/10 的价格计费（自动生效）。所以消息数组固定排成：
   `[人设 + 今天日期 + 早前摘要] → [历史（只追加，不改写）] → [群聊背景 + 时间 + 本题]`。
   变化的内容一律往后放。历史超过 `historyCompactAt` 才压缩一次（把最老的一批折叠成本地摘要，
   **不额外调用模型**）。
3. **本地计算器** —— 算术交给 `src/calc.mjs`，结果确定、零 API 成本，也免了为算个数去联网。

4. **搜索规则分三层，避免"该搜不搜"和"乱搜一通"两种毛病**：
   - **工具描述保持精简**（能力 + 边界），详细的搜/不搜清单写进 `persona.txt`。
     人设是稳定前缀、缓存后几乎不计费，把规则放这里比塞进工具描述更划算。
   - **规则前置**：明显带时效性的问题（时效词 + 话题词同时出现，或用户明说"查一下"），
     在本轮消息**尾部**补一句"先联网查证"的提示。放尾部是为了不动 system、不破坏前缀缓存。
   - **代码层硬限制**：`search.cooldownMs` 防刷、`tools.maxRoundsPerReply` 防死循环。
   - 刻意**不做"收回搜索工具"**：工具定义属于稳定前缀，时给时不给会让整段前缀变化，
     把前缀缓存打掉——省下的那点工具描述 token，远不够赔缓存失效的损失。

另有两处"省"是间接的：**选择性背景过滤**（"哈哈/收到/666"这类水聊不进缓冲，
不占注入额度）、**按难度自适应用力**（闲聊用最省的模式，难问题才全力）。

5. **群聊背景按需注入** —— 出现指代/承接信号（那个、刚才、然后呢…）才带背景，
   自足的问题（"1+1 等于几"）不带。`/status` 里能看到"已跳过多少次"。
6. **token 用量可观测** —— 每次请求都把 `usage`（含 `prompt_cache_hit_tokens`）记进日志与 `/status`。
   实测同一人设连续两次调用：**冷启动缓存命中 5%，第二次 90%**（2304/2549 token 按约 1/10 计价）。
   从此"省没省"是能查的数，不是感觉。
7. **主动插话的闸门全在规则侧** —— 每插一次就是一次模型调用，
   所以"要不要插"用零成本规则判定（名字命中 / 群活跃度 / 冷却 / 日限），
   绝不"每条消息都去问一次模型要不要插话"。

---

## 九、踩坑清单

1. **群里 @ 了没反应** → 先发 `/status` 看是不是 `/off` 状态；再看 `bot.allowedGroups` 是否把该群排除了。
2. **扫码提示"当前账号已登录，无法重复登录"** → 该号正在别处的日常 QQ 上在线。
   QQ 客户端**同时只能登一个号**，先退掉再启 NapCat。
3. **3001 端口没监听** → 就是登录没成功。别去查桥的配置，先看 NapCat 窗口。
4. **一条消息收到两条回复** → 同时跑了两个桥实例。一键启动器有 `.bridge.lock` 防重复，别绕过它。
5. **NapCat 终端日志是 GBK**，用 UTF-8 看会乱码但内容正常。
6. **改完人设/示范/配置不生效** → 都要重启桥。
7. **回答太长** → 超过 `output.maxCharsPerMessage` 会自动分片，超过条数上限会截断并附提示。
8. **表情发不出去** → 先在私聊发 `/sticker 加油` 单独试一张，再发 `/sticker list` 看情绪表；
   然后看 `/status` 里"表情包"那行的套装名和张数对不对。
   套装名写错时会自动回退到第一套，并在启动日志里打印提示，不会整个功能失灵。
9. **表情发得太频繁/太安静** → 频率只由人设控制，改 `persona.txt` 的「## 表情包」那两行；
   嫌它压根不该发就设 `"stickers": { "enabled": false }`。
10. **主动插话太频繁 / 老不吭声** → 私聊发 `/chime` 看状态；`/chime off` 直接关。
    嫌频繁就调大 `proactive.minIntervalMs`、调小 `proactive.dailyLimit`。
    注意 `proactive.enabled` 默认就是关的；`/chime on` 的设定会写进 `state.json`，
    **优先于 config.json**，想交回配置管就发 `/chime auto`。
11. **一次回复发了四五条消息** → 那是模型自己分的段（人设要求"最多三小段"）。
    嫌多就调小 `output.maxPartsGroup`，或改 `persona.txt` 里那条分段规则。
    续发的消息不带 @ 和引用，只有第一条带。

---

## 十、自测与诊断工具

**自测（不连 QQ 也能验，125 项断言）**

```bash
node selftest.mjs
```

用假的 NapCat(OneBot) 服务端 + 假的模型接口把整条链路跑一遍，覆盖：
连接与就绪、@ 触发、Markdown 清洗、@ 与引用段、日期注入、自动绑定管理员、
`/status` `/off` `/on` `/ctx`（含清空）`/sticker`、断开静默、非管理员拦截、
群聊背景按需注入与相对时间、**主动插话**（提到名字就接一句 / 不带 @ 引用 / 冷却 / 闲聊不插）、
**token 用量统计**、
六个工具的完整闭环（`calc` / `time_diff` / `random` / `fetch_url`（内网必须被拦）/ `send_sticker`（含"没有冷却"这条））、
分片（空行分段各自成条、续发不带 @、超长单段退化、超上限合并尾部）、
断线自动重连、首次连接失败的重连回归、频率限制，
以及一批纯函数回归（会话隔离 / 图片提取 / 搜索解析 / 计算器 / 日期 / 随机 /
读网页安全门禁与正文提取 / 搜索谓词 / 背景按需判定 / 相对时间 / 分段规则 /
表情库匹配与取图 / 难度判定 / 摘要压缩 / 背景过滤 / few-shot 加载）。

**真机诊断**

| 脚本 | 用途 |
|---|---|
| `node probe_onebot.mjs` | 连 `ws://127.0.0.1:3001`，查登录身份、版本、好友、群列表 |
| `node probe_llm.mjs "你的问题"` | 只验模型链路（不经过 QQ），用来快速试人设 |
| `node probe_stickers.mjs` | 列出各套表情的**情绪名**，并重新生成 `stickers/预览.html` |
| `node probe_fetch.mjs` | 验读网页：公网页面能读回、本机与内网地址被拦 |
| `node probe_search.mjs` | 验联网搜索（抓 cn.bing.com） |
| `node probe_vision.mjs` | 验图片识别链路 |

---

## 十一、安全说明

- **群聊零本机权限**：群消息只用于调模型 API，不涉及文件系统、命令执行。
- **读网页有内网门禁**：`fetch_url` 抓取前会解析域名、逐个校验真实 IP，
  挡掉本机（127.x）、内网（10.x / 172.16-31.x / 192.168.x）、云元数据（169.254.169.254）等地址。
  否则群友只要 @ 一句「帮我读一下 `http://127.0.0.1:6099/webui/`」，就能让机器人把本机服务的页面念出来。
  （只做域名字符串匹配不够——随便一个域名都能解析到 127.0.0.1，所以必须看真实 IP。）
- **管理员唯一**：开关只有管理员私聊能改，群里的 `/off` 会被忽略。
- **非管理员私聊静默**：不回复、不提示，避免被探测出机器人存在。
- **群聊背景只存内存**，不落盘，重启即清空；`/ctx clear` 可随时清。
- 需要保护的敏感数据：`config.json` 里的模型 `apiKey`。

---

## 十二、本地控制台（`webui/`）

一个能看清楚「谁熟、谁冷、下次该找谁说话」的本地面板。零依赖、零构建。

```bash
cd webui
node scripts/seed.mjs     # 可选：造一批演示数据
node server.mjs           # http://127.0.0.1:5173
```

它承载的是 `webui/src/profile.mjs` 里的**成员档案 + 亲密度**规则：

- 被 @ 一次 +2；普通发言 +1，每天最多计 6 分（防刷分）
- 超过 7 天没说话，之后每天 −1，最低 0
- 等级：陌生 0 / 眼熟 10 / 熟络 30 / 好友 55 / 挚友 80

这层数据是为后续三个功能铺的路：读取并回复群友的表情包（`stats.stickersSeen`）、
主动发起谈话（`stats.proactives` + `muted` + 候选排序）、以及"喜欢和谁聊"本身就是这张表。

### bridge 已经把数据写出来了

`src/members.mjs` 在 `src/router.mjs` 里挂着：**白名单群内的每条消息**（不只是被 @ 的）
都会记一笔，定时（默认 60 秒）落盘到 `data/members.json`，退出时强制写一次。
纯内存计数，不调任何 API。

```jsonc
// config.json —— 都可以不写，下面是默认值
"members": {
  "enabled": true,
  "file": "data/members.json",
  "flushMs": 60000,     // 多久落盘一次（有改动才写）
  "maxMembers": 500     // 上限，防止文件无限长
}
```

**写文件的分工**（这是关键，两边不会互相覆盖）：

| 文件 | 谁写 | 内容 |
|---|---|---|
| `data/members.json` | **只有 bridge** | 计数器、亲密度、时间戳 |
| `webui/data/overrides.json` | **只有面板** | 备注、静音、手动改的亲密度 |

面板显示时把 overrides 盖在 members 上面，所以你在界面上改的备注不会被下一轮计数冲掉。

> `data/` 已进 `.gitignore` —— 里面是真实群友的 QQ 号和互动数据。

## 十三、主动发起谈话（`proactive.initiative`）

和第八节的"插话"不是一回事：插话是**有消息进来时**顺便判断要不要接一句；这里是**没有任何人说话也会开口**，
所以是定时器驱动的。

两档，共用一套闸门：

| | 触发条件 | 发在哪 | 烦人风险 |
|---|---|---|---|
| **chime 冷场接话** | 群刚才热闹，然后安静满 20 分钟 | 群里，**不 @ 人** | 低 |
| **callout 按人点名** | 定时扫描成员档案，挑"该联系的人" | 群里，**@ 他** | 高 |

**默认全关。** 这是整个项目里社交风险最高的功能——一个真人被机器人 @ 是明确的社交压力，
所以宁可让人手动打开，也不默认生效。

```jsonc
// config.json
"proactive": {
  "initiative": {
    "enabled": true,          // 总开关
    "chime":   { "enabled": true },   // 冷场接话（低风险，建议先只开这个）
    "callout": { "enabled": false }   // 点名（先别开，跑几天看看再说）
  }
}
```

闸门清单（任何一条不过就不开口，**不产生模型调用**）：

| 闸门 | 默认 | 说明 |
|---|---|---|
| 免打扰时段 | 1:00–8:00 | 本地时间，跨零点自动处理 |
| 全局日限 | 12 次/天 | 两档共用 |
| 群冷却 | 接话 30 分钟 / 点名 1 小时 | 同一个群 |
| 每人冷却 | 3 天 | 同一个人最多被点名一次 |
| 亲密度门槛 | ≥30（熟络） | 只看聊过几句的人，不拿一两条数据下判断 |
| 发言数门槛 | ≥5 条 | 同上 |
| 面板静音 | — | 在控制台上点了"不要主动找这个人"，bridge 会读 `data/overrides.json` 遵守 |
| 群正在回答中 | — | 跳过，别和正常回答打架 |
| 话题新鲜度 | ≤2 小时 | 凉太久就不接了 |

两个刻意的设计决定：

1. **配额在返回动作时就扣掉**（fail closed）——宁可少说一句，也不要在发送出错时每 60 秒重试一次、把群刷屏。
2. **决策与执行分离**：`src/initiative.mjs` 只负责"该不该说、跟谁说"，不碰网络也不碰模型；
   真正开口是 `router.runInitiative()`。所以引擎的 `tick(now)` 时间参数是**从外面传进去的**——
   "等 20 分钟看会不会冷场"这种判断，在测试里是瞬间完成的。

## 目录结构

```
qq-bridge/
├── bridge.mjs          入口：装配通道 + 路由
├── watch-login.mjs     等 NapCat 登录完成，然后自动拉起 bridge（一键启动用）
├── 一键启动.bat        ★ 双击这个（GBK + CRLF）
├── config.json         配置
├── persona.txt         ★ 人设，改这个文件即可
├── fewshot/            ★ 示范问答集，换风格改 config 一行
│   ├── 说明.md
│   └── A~F 六套性格（萌系/幽默/害羞/大方/腹黑/元气）
├── stickers/           ★ 表情包（04-线条狗，43 张动态）
│   ├── 预览.html       全套图 + 情绪名，用来挑情绪
│   ├── 说明.md         目录约定 / 版权 / 频率控制
│   └── 04-线条狗/
├── state.json          运行状态：开关 + 已绑定管理员（自动生成）
├── start.bat           只启桥（不启 NapCat），手工排查时用
├── selftest.mjs        端到端自测（166 项断言）
├── probe_llm.mjs       模型链路直连测试
├── probe_onebot.mjs    NapCat / OneBot 连通性与账号查询
├── probe_stickers.mjs  列出各套情绪名 + 重新生成 预览.html
├── probe_fetch.mjs     读网页测试（公网可读 / 内网被拦）
├── probe_search.mjs    联网搜索测试
├── probe_vision.mjs    图片识别测试
├── src/
│   ├── config.mjs      配置默认值 / 加载 / 体检 / 人设与示范加载
│   ├── logger.mjs      日志（控制台 + 文件，同步写）
│   ├── onebot.mjs      OneBot v11 适配器（当前唯一通道）
│   ├── ws.mjs          WebSocket 实现（**仅自测用作 mock 服务端**）
│   ├── router.mjs      路由：权限、开关、指令、限流、群聊背景、表情、回复
│   ├── llm.mjs         模型调用 + 上下文管理 + 工具定义与分发 + 搜索谓词
│   ├── ambient.mjs     群聊被动上下文（环形缓冲 + 水聊过滤）
│   ├── stickers.mjs    表情包库（情绪索引 + 容错匹配）
│   ├── calc.mjs        本地计算器（自己写的小解析器，不 eval）
│   ├── datetime.mjs    日期计算（相差几天 / 还有几天）
│   ├── random.mjs      骰子 / 抽签 / 随机整数（crypto 随机源）
│   ├── fetchpage.mjs   读网页正文（含本机与内网地址门禁）
│   ├── search.mjs      联网搜索（抓 Bing 结果页）
│   ├── vision.mjs      图片下载转 base64
│   ├── text.mjs        Markdown 转纯文本、分片
│   ├── profile.mjs     ★ 成员档案与亲密度规则（**bridge 与面板共用这一份**）
│   ├── members.mjs     成员档案存储：定时落盘 data/members.json
│   ├── initiative.mjs  ★ 主动发起的决策引擎（只判断，不说话；时钟可注入）
│   └── overrides.mjs   读面板写的人工编辑（只取 muted / note）
├── data/
│   ├── members.json    ★ 群友档案（bridge 独占写入，已 gitignore）
│   └── overrides.json  面板的人工编辑（面板独占写入，bridge 只读）
├── webui/              ★ 本地控制台：群友档案 / 亲密度（见下节）
│   ├── server.mjs      本地 HTTP 服务，只监听 127.0.0.1
│   ├── src/profile.mjs 转发引用（真正的规则在 ../src/profile.mjs）
│   ├── src/paths.mjs   路径解析：成员档案 / 人工编辑文件
│   ├── scripts/        seed.mjs 造演示数据 / gen-avatars.mjs 生头像
│   └── public/         单页界面，零构建零依赖
└── logs/bridge.log     运行日志

napcat/NapCat.Shell/    NapCat 本体
├── start-napcat.bat    启动 NapCat（GBK + CRLF）
├── cache/qrcode.png    登录二维码（一键启动会把它弹出来）
└── config/onebot11.json  已预置：WS 服务端 127.0.0.1:3001
```

依赖：**仅 Node.js 内置模块**（`fetch` / `net` / `tls` / `http` / `crypto`），无需 `npm install`。
