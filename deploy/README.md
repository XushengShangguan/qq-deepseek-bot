# 部署到云服务器

把程序和 NapCat 一起跑在服务器上，关掉电脑也能聊。

## 1. 买服务器

- 推荐阿里云 99 计划（2 核 2G，99 元/年，续费同价）。
- 地区选华东（杭州/上海），镜像选 **Ubuntu 22.04 或 24.04**，设置 root 密码。
- 不需要备案（不开网站），也不用开放任何额外端口，只要能 SSH（22 端口）。

## 2. 准备服务器（只做一次）

在 Mac 上：

```bash
cd ~/Desktop/女朋友/companion-app
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@服务器IP     # 输一次 root 密码，之后用钥匙登录
ssh root@服务器IP 'bash -s' < deploy/setup-server.sh
```

会装好 Docker、加 2G 虚拟内存（swap）、配置 DaoCloud 镜像源，并**关掉 SSH 密码登录**（只能用钥匙登录）。

Docker 镜像在国内经常拉不下来（2026-10 时阿里云个人加速器对这两个镜像都返回 not found）。如果 `docker compose up` 拉镜像失败，在服务器上手动拉再改名：

```bash
docker pull dockerproxy.net/mlikiowa/napcat-docker:latest
docker tag dockerproxy.net/mlikiowa/napcat-docker:latest mlikiowa/napcat-docker:latest
```

## 3. 迁移（只做一次）

```bash
deploy/migrate.sh root@服务器IP
```

它会：

1. 停掉 Mac 上的 NapCat 和程序（同一个 QQ 号不能两边同时登录）
2. 把代码、聊天记录和记忆、`.env.local`、NapCat 登录数据复制到服务器 `/opt/companion`
3. 在服务器上构建并启动（第一次构建要几分钟）

## 4. 登录小号

```bash
ssh -L 6099:127.0.0.1:6099 -L 3000:127.0.0.1:3000 root@服务器IP
```

这个终端开着的时候，在 Mac 浏览器打开：

- http://127.0.0.1:6099/webui —— NapCat 后台（密码是 `napcat/.env` 里的 `WEBUI_TOKEN`）。没自动登录就用小号扫码。
- http://127.0.0.1:3000/api/memory?companion=小周&user=qq:你的QQ号 —— 看她记住了什么

然后用 QQ 给小号发消息试试。

## 5. 小黑盒（可选）

她用自己的小黑盒号逛帖子、偶尔评论（每天最多 `HEYBOX_COMMENTS_PER_DAY` 条）。先注册一个小号，**简介里写明是 AI**。然后在 Mac 上：

```bash
npm i --no-save playwright && npx playwright install chromium
node deploy/heybox-login.mjs data/heybox.json      # 弹出二维码，用她的号扫
scp data/heybox.json root@服务器IP:/opt/companion/data/heybox.json
rm data/heybox.json
```

不用重启，下次自由时间就会用上。一天内碰到 5 次人机验证或登录过期（`HEYBOX_ERRORS_BEFORE_PAUSE`），她会停一天并推送提醒；过期了就重新扫一次。

## 以后改代码 / 改人设

- **只改人设或风格文件**（`companions/` 里的 `.txt`）：
  ```bash
  deploy/update.sh root@服务器IP
  ```
- **改了代码**：同样运行 `deploy/update.sh`，会自动重新构建。
- **改 `.env.local`**：在服务器上改 `/opt/companion/.env.local`，然后
  `ssh root@服务器IP 'cd /opt/companion/deploy && docker compose up -d app'`

`update.sh` 不会覆盖服务器上的聊天记录、设置和登录状态。

## 常用命令（在服务器上）

```bash
cd /opt/companion/deploy
docker compose ps                 # 状态
docker compose logs -f app        # 程序日志（回复耗时、报错）
docker compose logs -f napcat     # NapCat 日志（登录、收发）
docker compose restart napcat     # 重启 NapCat
cp ../data/companion.db ~/companion-backup-$(date +%F).db   # 备份聊天记录
```
