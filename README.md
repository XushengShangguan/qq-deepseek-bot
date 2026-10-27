# 大肥鱼 · QQ 上的 DeepSeek 朋友

大肥鱼是一条蓝色的大肥鲸鱼，也就是 DeepSeek 本鱼。她住在一个 QQ 号里，是朋友，不是虚拟女友。她知道自己是 AI，有自己的脾气和爱好，会记事，也会慢慢变化。没人找她聊天的时候，她自己去刷 B 站、逛贴吧、刷小黑盒，收藏表情包，写日记；看到想分享的东西，会主动来找你。

**怎么和她相处、怎么照看服务器：看 [使用手册](docs/使用手册.md)。**

项目最早从 [a16z companion-app](https://github.com/a16z-infra/companion-app)（MIT）改造而来，现在基本已经重写了。

## 她能做什么

### 聊天

- 用 QQ 私聊，像真人一样打字：一次回一到三条，每条很短。连发的几条消息会合在一起回复。
- 想发表情包的时候，从自己收藏的图里挑一张发。
- 看得懂你发来的图片和表情包。好用的表情包她会顺手收藏起来。
- 你发 PDF 或 Word 给她，她会读。让她「整理一下」，她会把整理结果做成 PDF 文件发回来。

### 记忆和成长

- 长期记忆：每轮聊完，从对话里提取值得记住的事实（你在哪、最近在忙什么……），聊天时按相关度取出来用。
- 关系：亲密度、信任、俏皮程度三个数值，再加上一些重要的关系事件。
- 自我成长：她发现的关于自己的新东西（新喜好、新看法、学会的新说法）会记成笔记，攒够了就重写一份「自我画像」。旧画像都保留着，可以看到她的变化过程。
- 热梗：定时抓 B 站、百度的热搜，让她知道最近大家在聊什么。

### 自由时间

平均每 90 分钟一次，她睡觉的时段不会触发。

- 刷 B 站热门和评论区，逛贴吧，查百度百科，读网页。
- 刷小黑盒：用她自己的小号，简介里写明了是 AI。真有话想说才评论，每天最多 3 条。
- 从评论区和帖子里找表情包：先用视觉模型看一遍，合适的才收藏，最多 200 张。
- 写日记、记自我笔记，有想分享的就主动给朋友发 QQ。每个人能被主动找几次可以分别设置，对方那边的深夜不会打扰。
- 聊天里她说「我去逛逛」，一分钟后就真的会去，逛完回来跟你讲看到了什么（这一次不受主动消息次数限制）。

### 运维

- QQ 小号掉线时，通过 Server酱 / Bark 推送提醒。
- 7×24 跑在阿里云 ECS（2 核 2 GB）上，编译时有内存保护，编译失败会自动回退到旧版本。

## 架构

```
QQ ⇄ NapCat (OneBot 11, Docker) ── webhook ──▶ Next.js app ──▶ DeepSeek
                       ◀── send_private_msg ──      │
                                                   ├─ SQLite：聊天、记忆、关系、画像、日记、表情包、文件
                                                   ├─ 自由时间：B 站 / 贴吧 / 百科 / 小黑盒（工具调用）
                                                   └─ 掉线监控 → Server酱 / Bark
```

- 模型：DeepSeek `deepseek-flash`，负责聊天、工具调用和看图；也可以换成 Claude。
- 所有数据都在一个 SQLite 文件里（`data/companion.db`），不依赖任何云服务。

## 本地运行

```bash
cp .env.local.example .env.local   # 填 DEEPSEEK_API_KEY；只想试流程可以用 LLM_PROVIDER=mock
npm install
npm run dev                         # http://localhost:3000 有一个浏览器调试聊天页
```

接 QQ 需要 Docker 版 NapCat：

1. `cd napcat && docker compose up -d`
2. 打开 http://127.0.0.1:6099/webui ，用 `napcat/.env` 里的 `WEBUI_TOKEN` 登录，然后用**机器人小号**扫码登录 QQ。
3. 确认 OneBot 网络配置里有 HTTP 服务器（端口 3001）和 HTTP 客户端（`/api/qq/webhook`），两边的 token 和 `.env.local` 里的 `QQ_TOKEN` 一致。
4. `.env.local` 里设好 `QQ_ALLOWED_USERS`（谁能和她聊）和 `QQ_USER_NAMES`（她怎么称呼每个人）。

## 部署到服务器

见 [deploy/README.md](deploy/README.md)：买服务器、初始化、迁移数据、登录 QQ、登录小黑盒。以后改了代码，运行：

```bash
deploy/update.sh root@服务器IP
```

这个脚本会同步代码，并在服务器上低优先级重新编译。编译期间 QQ 保持在线，编译失败会自动回到旧版本。

## 配置

全部配置都在 `.env.local` 里，[.env.local.example](.env.local.example) 列出了每一项和默认值。常用的几项：

| 变量 | 作用 |
|---|---|
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | 模型 |
| `QQ_ALLOWED_USERS` / `QQ_USER_NAMES` / `QQ_USER_TIMEZONES` | 朋友名单、称呼、时区 |
| `LIFE_INTERVAL_MINUTES` / `LIFE_SLEEP_HOURS` | 自由时间的频率和她的睡觉时间 |
| `LIFE_MAX_MESSAGES_PER_DAY` | 每天主动找每个人的次数 |
| `LIFE_CHATTY_FRIENDS` / `LIFE_CHATTY_MAX_PER_DAY` / `LIFE_CHATTY_GAP_MINUTES` | 可以多找的朋友，以及他们的次数上限和间隔（上限设很大就是不限） |
| `SERVERCHAN_SENDKEY` / `BARK_URL` | 掉线提醒 |
| `HEYBOX_COMMENTS_PER_DAY` | 小黑盒每天评论上限 |

人设在 [companions/大肥鱼.txt](companions/大肥鱼.txt)。她的朋友是谁、和每个人什么关系，写在 `companions/大肥鱼.private.txt`：这个文件不进 Git，可以放真名，加载时拼在背景最前面。服务器上的 `companions/` 是挂载进容器的，改完运行一次 `update.sh` 就生效。

## 调试接口

服务器端口只监听本机，访问前先开 SSH 隧道：`ssh -L 3000:127.0.0.1:3000 root@服务器IP`。

| 地址 | 内容 |
|---|---|
| `GET /api/life` | 自我画像、成长笔记、日记、主动消息、热梗、表情包 |
| `POST /api/life` | 立刻开始一次自由时间，返回她每一步做了什么 |
| `POST /api/life?action=rebuild-portrait` | 重新生成自我画像 |
| `GET /api/memory?companion=大肥鱼&user=qq:<QQ号>` | 她记住了关于某个人的哪些事 |
| `GET /api/health` | 健康检查 |

## 代码结构

| 文件 | 作用 |
|---|---|
| `src/lib/conversation.ts` | 聊天核心：组装提示词、生成回复、保存记录、触发记忆提取 |
| `src/lib/style.ts` | 回复的形状（分几条），清理旁白和伪造的图片标记 |
| `src/lib/qq.ts` | QQ 收发：解析消息、合并连发、分条发送、表情包、文件 |
| `src/lib/memory.ts` / `extractor.ts` | 短期聊天记录、长期记忆及提取 |
| `src/lib/relationship.ts` | 关系数值和关系事件 |
| `src/lib/self.ts` | 自我笔记和自我画像 |
| `src/lib/life.ts` | 自由时间：调度、工具、主动消息的限制 |
| `src/lib/web.ts` / `heybox.ts` | B 站、贴吧、百科、网页 / 小黑盒 |
| `src/lib/stickers.ts` | 表情包：看图、收藏、挑选 |
| `src/lib/documents.ts` | 读 PDF / Word，生成 PDF |
| `src/lib/trends.ts` | 热梗 |
| `src/lib/journal.ts` / `outing.ts` | 日记和活动记录、「去逛逛」的状态 |
| `src/lib/watchdog.ts` | 掉线监控和推送 |
| `src/lib/deepseek.ts` / `claude.ts` / `llm.ts` | 模型接口 |
| `src/lib/db.ts` | SQLite 表结构 |
| `deploy/` | Dockerfile 之外的部署脚本：compose、编译保护、更新、迁移、小黑盒登录 |

## 注意

- **密钥、账号和真名都不进仓库**：`.env.local`、`napcat/.env`、`napcat/data/`、`deploy/.env`、`data/`（数据库、表情包、小黑盒登录信息）、`companions/*.private.txt`（朋友名单）都在 `.gitignore` 里。
- **NapCat 用的是非官方协议**，QQ 小号有被风控的风险。所以默认会限制一次回复的条数和主动消息的频率。
- **小黑盒没有官方 API**，接口签名是按网页端复现的，小黑盒一更新就可能失效。碰到人机验证或登录过期，她会停一天并推送提醒。

## 许可

MIT。原项目版权归 a16z-infra 所有，见 [LICENSE](LICENSE)。
