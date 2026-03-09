# new-api-auto-register

一个用于批量注册、定时签到、定时刷新状态（包含余额与签到状态），并通过本地 Web API 提供账号与余额查询的工具。

项目当前采用单文件存储，所有运行数据统一保存在 `data/store.json` 中。

## 功能说明

- 批量注册账号并保存到本地数据文件
- 定时执行签到任务
- 每 10 分钟刷新一次账号状态（包含真实余额与签到状态）并写入本地缓存
- 提供本地 Web API 查询缓存账号状态与余额，不直接请求上游接口
- 支持把本地全部 token 去重后上传到管理端
- 支持将旧版 CSV 数据导入新的 `store.json`

## 数据存储

项目所有核心数据统一保存在以下文件中：

```text
data/store.json
```

其中主要包含：

- `accounts`：账号、密码、token、session、最近余额、最近签到状态
- `checkins`：签到历史
- `balanceSnapshot`：余额缓存快照
- `metadata`：元信息

### store.json 示例结构

```json
{
  "accounts": [
    {
      "username": "user001",
      "password": "pass001",
      "token": "sk-xxx",
      "session": "session=xxx",
      "newApiUser": "1",
      "createdAt": "2026-03-07T00:00:00.000Z",
      "updatedAt": "2026-03-07T00:00:00.000Z",
      "lastLoginAt": "2026-03-07T00:00:00.000Z",
      "lastCheckinAt": "2026-03-07T00:00:00.000Z",
      "lastCheckin": {
        "status": 200,
        "success": true,
        "message": "签到成功",
        "checkinDate": "2026-03-07",
        "quotaAwarded": 100000,
        "time": "2026-03-07T00:00:00.000Z"
      },
      "lastBalanceAt": "2026-03-07T00:10:00.000Z",
      "lastBalanceQuota": 500000,
      "lastBalance": "$1.00",
      "lastBalanceStatus": 200,
      "notes": []
    }
  ],
  "checkins": [
    {
      "time": "2026-03-07T00:00:00.000Z",
      "username": "user001",
      "newApiUser": "1",
      "status": 200,
      "success": true,
      "message": "签到成功",
      "checkinDate": "2026-03-07",
      "quotaAwarded": 100000
    }
  ],
  "balanceSnapshot": {
    "updatedAt": "2026-03-07T00:10:00.000Z",
    "totalQuota": 500000,
    "totalBalance": "$1.00",
    "accounts": [
      {
        "username": "user001",
        "quota": 500000,
        "balance": "$1.00",
        "updatedAt": "2026-03-07T00:10:00.000Z",
        "status": 200,
        "newApiUser": "1"
      }
    ]
  },
  "metadata": {
    "version": 1,
    "createdAt": "2026-03-07T00:00:00.000Z",
    "updatedAt": "2026-03-07T00:10:00.000Z"
  }
}
```

如果你要手工维护数据，通常只建议修改：

- `accounts[].username`
- `accounts[].password`
- `accounts[].token`
- `accounts[].session`
- `accounts[].newApiUser`

其余像 `lastCheckin`、`lastBalance`、`balanceSnapshot`、`metadata` 一般都由程序自动更新，不建议手工改动。

### 手动新增账号最小示例

如果你想直接手工往 `store.json` 里加一个账号，最小可以只写成这样：

```json
{
  "accounts": [
    {
      "username": "user001",
      "password": "pass001",
      "token": "",
      "session": "",
      "newApiUser": ""
    }
  ],
  "checkins": [],
  "balanceSnapshot": {
    "updatedAt": null,
    "totalQuota": 0,
    "totalBalance": "$0.00",
    "accounts": []
  },
  "metadata": {
    "version": 1,
    "createdAt": null,
    "updatedAt": null
  }
}
```

说明：

- 只要 `username` 和 `password` 正确，程序后续就可以自行登录并补全其他字段
- 如果你已经有现成的 `token`、`session` 或 `newApiUser`，也可以提前填进去
- 新增后重启服务，或等待下一次定时任务执行即可

## Web API

服务启动后默认监听 `3000` 端口。

可用接口：

- `GET /healthz`
- `GET /api/balances`
- `GET /api/accounts`
- `POST /api/registers`
- `POST /api/accounts/:username/retry`
- `POST /api/accounts/:username/checkin-status`
- `POST /api/accounts/:username/checkin`
- `GET /management.html`

说明：

- `GET /api/balances` 返回的是本地缓存余额
- 不会在请求 API 时实时请求上游
- 真实余额由后台定时任务每 10 分钟刷新一次
- `POST /api/registers` 会真实执行批量注册，必须携带管理员密钥
- `POST /api/accounts/:username/retry` 可重试失败步骤，必须携带管理员密钥
- `POST /api/accounts/:username/checkin-status` 可查询某账号当月签到状态，必须携带管理员密钥
- `POST /api/accounts/:username/checkin` 可手动为某账号执行签到，必须携带管理员密钥
- `GET /management.html` 提供账号状态管理页面，可查看失败状态并触发重试

## 环境变量

最小配置见 `.env.example`。

当前推荐只配置以下字段：

```env
STORE_PATH=./data/store.json
BASE_URL=https://open.lxcloud.dev
API_PORT=3000
ADMIN_API_KEY=请改成你自己的复杂密钥
CHECKIN_CRON_EXPR=0 0 * * *
CHECKIN_CRON_TZ=Asia/Shanghai
BALANCE_REFRESH_CRON_EXPR=*/10 * * * *
BALANCE_REFRESH_CRON_TZ=Asia/Shanghai
EXTRA_COOKIES=
NEW_API_USER=
```

说明：

- `BASE_URL` 只需要填写站点根地址
- 其他接口地址会在代码中自动拼接
- 如果目标站点不需要额外身份头，`EXTRA_COOKIES` 和 `NEW_API_USER` 可以留空
- `ADMIN_API_KEY` 用于保护管理接口，尤其是批量注册 API

### 受保护的批量注册 API

接口地址：

```text
POST /api/registers
```

请求头可任选一种：

```text
Authorization: Bearer <ADMIN_API_KEY>
```

或：

```text
X-Admin-Key: <ADMIN_API_KEY>
```

请求体示例：

```json
{
  "count": 5
}
```

返回值会包含本次批量注册的汇总结果。

### 失败步骤重试 API

接口地址：

```text
POST /api/accounts/:username/retry
```

请求头同样使用管理员密钥。

请求体示例：

```json
{
  "step": "login"
}
```

`step` 可选值：

- `register`
- `login`
- `tokenCreate`
- `tokenList`

### 管理页面

访问地址：

```text
http://<服务器IP>:3000/management.html
```

页面支持：

- 查看全部账号当前流程状态
- 区分注册、登录、创建 token、查询 token 的成功/失败
- 录入管理员密钥后直接触发批量注册
- 对失败步骤逐个重试
- 支持搜索账号、按步骤筛选、仅看失败项
- 支持对当前筛选结果中的失败项批量重试
- 支持勾选多个账号，并仅重试所选账号里的失败步骤
- 支持查看账号今天是否已签到
- 支持签到状态统计卡片，快速查看已签到、未签到、未知数量
- 支持批量刷新当前筛选账号的签到状态
- 支持一键为当前筛选结果中的未签到账号执行签到
- 支持为所选未签到账号执行签到
- 所有状态统一写入本地 `store.json`

## 本地运行

先安装依赖：

```bash
npm install
```

启动主服务：

```bash
npm run service
```

这会同时启动：

- 定时签到任务
- 定时状态刷新任务（包含余额与签到状态）
- 本地 Web API 服务

## 常用命令

启动主服务：

```bash
npm run service
```

批量注册：

```bash
npm run register
```

手动执行一次签到：

```bash
npm run checkin
```

手动执行一次余额刷新脚本：

```bash
npm run query:balance
```

导入旧版 CSV 数据到 `store.json`：

```bash
npm run import:legacy
```

上传全部 token 到管理端：

```bash
MANAGEMENT_OPENAI_COMPAT_URL=... MANAGEMENT_BEARER=... npm run upload:tokens
```

## 旧数据导入

如果你之前使用的是旧版文件：

- `tokens.csv`
- `sessions.csv`
- `user-ids.csv`

可以执行：

```bash
npm run import:legacy
```

导入后数据会统一写入：

```text
data/store.json
```

## Docker 部署

项目已提供：

- `Dockerfile`
- `compose.yaml`
- `install.sh`

### 一键安装

在服务器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/Fearless743/new-api-auto-register/main/install.sh | sh
```

默认安装目录：

```text
/opt/new-api-auto-register
```

安装完成后需要编辑：

```bash
vim /opt/new-api-auto-register/.env
```

然后重启：

```bash
docker compose -f /opt/new-api-auto-register/compose.yaml --env-file /opt/new-api-auto-register/.env restart
```

查看日志：

```bash
docker compose -f /opt/new-api-auto-register/compose.yaml --env-file /opt/new-api-auto-register/.env logs -f
```

默认余额接口：

```text
http://<服务器IP>:3000/api/balances
```

## GHCR 镜像

推送到 `main` 后，GitHub Actions 会自动构建并发布镜像到：

```text
ghcr.io/fearless743/new-api-auto-register:latest
```
