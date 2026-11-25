# 在云电脑里接入模型网关（节点）

面板侧已经就绪：`/v1/models`、`/v1/chat/completions`（支持流式）、节点管理、池 Key、用量统计。
下面是把**一台云电脑**变成模型节点的步骤。

## 原理

```
你的 IDE / SDK ──► 面板 :8580/v1 ──WebSocket──► 云电脑里的节点 ──► 本机 4397（官方客户端）
```

节点主动连面板，所以云电脑不需要公网 IP、不需要端口映射。

## 一、面板侧：建节点

1. 打开 `http://<面板IP>:8580`，右下角 **🔌 模型网关**；
2. 点「+ 添加云电脑节点」，填个名字（如 `云电脑-7713`）；
3. **立刻记下弹出的 node-id 和 token**（token 只显示一次）；
4. 点「+ 创建池 Key」，同样记下 `sk-pool-...`（客户端用它调 `/v1`）。

## 二、云电脑里：装官方客户端 + 节点程序

### 1. 装 TeleAgent Windows 客户端

从官网下载安装，登录**这个云电脑所属的账号**，保持客户端运行。
它会监听本机 `127.0.0.1:4397`（模型网关）。

> 建议在客户端设置里勾选「开机自启 / 记住登录」，否则云电脑重启后节点会掉线。

### 2. 装 Python 3.10+

云电脑里打开 PowerShell：

```powershell
winget install -e --id Python.Python.3.12
```

### 3. 放两个脚本

从 `shixiangkuangmo/teleagent` 仓库取这两个文件放到 `C:\teleagent-node\`：

- `TeleAgent-OpenAI/teleagent_gateway.py` —— 把 4397 包装成 OpenAI 兼容的 `127.0.0.1:8899/v1`
- `TeleAgent-OpenAI/pool_agent.py` —— 连回面板

### 4. 启动

```powershell
cd C:\teleagent-node

# 1) 本地网关（保持窗口开着）
python teleagent_gateway.py --port 8899

# 2) 节点（新开一个窗口）
python pool_agent.py --server ws://<面板IP>:8580/api/pool/agent `
    --node-id <node-id> --token <token> `
    --gateway-url http://127.0.0.1:8899 --max-inflight 4
```

面板「模型网关」里节点变 🟢 就成功了。

### 5. 开机自启（可选）

任务计划程序 → 创建两个任务，触发器「登录时」，操作分别指向上面两条命令，起始位置填 `C:\teleagent-node`。

## 三、客户端调用

```bash
curl http://<面板IP>:8580/v1/models \
  -H "Authorization: Bearer sk-pool-..."

curl http://<面板IP>:8580/v1/chat/completions \
  -H "Authorization: Bearer sk-pool-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"chat-pro","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

| 配置项 | 值 |
|---|---|
| Base URL | `http://<面板IP>:8580/v1` |
| API Key | 面板里创建的池 Key |
| Model | 节点上报的模型名（`/v1/models` 可查） |

## 四、注意事项

- **一台云电脑只能登录一个账号**，所以一个节点对应一个号；多号就多台云电脑。
- 云电脑关机 / 排队 / `instance/rebuild` 后，节点会掉线；面板会显示 ⚪，需要重新进桌面把客户端和节点拉起来。
- `/v1` 目前是 HTTP。对外暴露前请套 HTTPS 反代（Caddy/Nginx），并确保反代关闭流式缓冲（`proxy_buffering off`）。
- 池 Key 只存在面板数据目录，删除即失效；节点 token 可在面板里「🔄」轮换（轮换后要重启节点）。
