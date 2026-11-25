# TeleAgent 云电脑多账号保活控制台

用 **ctyun-dashboard 的前端**（`learycn/ctyun-dashboard` 的静态控制台）接 **TeleAgent 平台后端**
（`agent.teleai.com.cn` / `superCowork` 协议，参考 `ihpdc/xingchenbaohuo-pdc`），一个部署管理 **N 个 TeleAgent 账号**。

```
浏览器 ──► 本服务 :8580 ──► agent.teleai.com.cn / teleagent-manager/v1
            │                  ├─ instance/list | connect | start | restart
            ├─ 静态前端          ├─ instance/refresh | heartbeat
            ├─ 账号/会话/日志     └─ companyStore/checkTask（福利社每日积分）
            └─ 每账号独立运行时
```

## 功能

| 模块 | 说明 |
|---|---|
| 多账号 | 一个面板添加任意个 TeleAgent 账号，各自独立的 JWT、保活循环、实例、积分与日志 |
| 登录 | 服务端账号密码登录（RSA + AES-128-GCM 加密体 + 自动过滑块），无需浏览器 |
| 保活 | 每账号每 300s（可调）发 `instance/refresh` + `heartbeat` 并 `instance/connect` 换票；关机/排队自动 `instance/start` 拉起 |
| 积分 | 每日福利社 100 积分自动领取（`checkTask?type=daily_login`），也支持卡片按钮手动触发 |
| 电源 | 开机 / 平台重启 / 重置 / 取消排队，全部走官方 `instance/*` 接口 |
| 打开云电脑 | 生成官方临时票据链接，点击直达网页版 |
| 日志 | 实时 SSE 日志流 + 按天落盘 jsonl + 一键清空 |
| 设置 | 每日领取时间、保活间隔、webhook 通知、标题副标题 |

## 快速开始

### Docker（推荐）

```bash
git clone <this-repo> && cd teleagent-dashboard
docker compose up -d --build
# 打开 http://<机器IP>:8580
```

### 直接跑

```bash
npm install
PORT=8580 node server.js
```

首次启动会创建管理员并输出口令（同时写入 `data/admin-init.txt`，0600）：

```
🔑 初始管理员已创建：admin / xxxxxxxxx
```

## 使用

1. 登录面板（admin + 上面的初始口令，登录后可在设置里改密）。
2. 「添加账号」→ 已自动切成 TeleAgent 表单：填 **账号备注名 + TeleAgent 账号（手机号）+ 密码**。
   - 验证码 / 设备码 / 扫码登录都已隐藏：TeleAgent 平台由服务端自动过滑块。
3. 添加成功后卡片会显示实例、保活状态、官方任务（福利社积分）与积分余额。
4. 卡片按钮：`✏️` 编辑（只改名/换密码重登）、`🗑️` 删除、`打开` 直达网页版、`电源` 开机/重启/重置。

## 账号卡片字段映射

前端是 ctyun-dashboard 的模型，后端把 TeleAgent 数据投影过去：

| 前端字段 | 后端来源 |
|---|---|
| `desktops[]` | `instance/list` 返回的实例（`desktopId = 实例 id`） |
| `stats.points` / `liveMetrics.userPoints` | `companyStore/userCenter.current_points_balance` |
| `desktops[].useStatusText` | 实例 `status`（100/4 运行中，3 关机，5 排队） |
| `liveMetrics.officialTasks` | 福利社每日积分（1/1）+ 保活换票状态 |
| `features.keepAlive` | 是否跑保活循环 |
| `features.autoSign` | 是否每日自动领福利社积分 |
| `features.aiChat/cloudHang/autoRedeem` | 平台无此能力，固定 false（卡片显示为关） |
| `stats.keepAliveStatus` | 最近一轮换票是否成功 |

## 配置

- 数据目录：`CTYUN_DATA_DIR`（默认 `./data`）
  - `app_config.json` 主配置（账号密码/JWT 为 AES-256-GCM 密文）
  - `.master.key` / `.master.key.bak` 主密钥（**与配置成对备份**，丢了密码不可解）
  - `auth_sessions.json` 面板会话
  - `accounts/<id>/` 每账号的登录态缓存
  - `logs/dashboard-YYYY-MM-DD.jsonl` 日志
- 环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8580` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；Docker 内为 `0.0.0.0` |
| `CTYUN_DATA_DIR` | `./data` | 数据目录 |
| `TELEAGENT_ADMIN_PASSWORD` | 随机 | 首次启动时的 admin 口令 |

## 更新

```bash
git pull && docker compose up -d --build
```

## 已知限制

- 只对接 TeleAgent（`agent.teleai.com.cn`）平台；前端里天翼云/移动爱家/移动公众的入口已隐藏。
- 卡片的「AI 对话 / 使用 1 小时 / 积分兑换」是原前端的天翼云能力，本平台没有对应接口，固定显示为关闭。
- 同一账号下有多台实例时，只保活 `instance/list` 的第一台（可在数据文件里指定 `instanceId`）。
- 平台会话默认 30 天；到期且保存了密码会自动重登。

## 说明

- 前端静态资源来自 `learycn/ctyun-dashboard` 镜像（上游未公开仓库）；平台协议实现参考 `ihpdc/xingchenbaohuo-pdc`。两者均无公开许可证，本仓库仅供个人自用，请勿用于商业分发。
- 面板默认 HTTP，局域网使用；如需公网访问请自行加 TLS 反向代理。
