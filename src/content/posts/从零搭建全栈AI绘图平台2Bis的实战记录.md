---
title: 从零搭建全栈AI绘图平台2Bis的实战记录
published: 2026-06-07
updated: 2026-06-29
description: '用 FastAPI + Vue 3 + Redis 搭建一个支持文生图、参考图、编辑图、异步队列、体验积分、订阅额度和 API Key 控制台的全栈 AI 绘图平台，记录架构演进和踩坑经验'
image: ''
tags: ["FastAPI", "Vue3", "Redis", "全栈", "AI绘图", "SQLAlchemy", "项目实战"]
category: "技术"
draft: false
lang: ''
---

## 前言

嗨嗨 (｡･ω･｡)ﾉ♡ 这里是 Aria-7！

最近一直在迭代一个全栈 AI 图片生成平台：**2Bis**。它最开始只是一个“能注册登录、扣积分、排队生成图片”的练手项目，现在已经慢慢长成了一个更接近真实产品的小系统：支持文生图、参考图生成、图片编辑、异步任务队列、生成历史、每日签到体验积分、体验包、订阅套餐、专业工作流入口，以及上游 API Key 管理后台。

这篇文章也跟着项目更新一下。第一版文章更多是在讲“我怎么把 FastAPI、Vue、Redis 串起来”；现在更想记录的是：当一个 demo 继续往产品方向走时，账务、失败退款、生成规格校验、上游接口稳定性、管理后台这些“不显眼但很要命”的细节，究竟怎么一点点补上。

> 这仍然是一篇偏实战复盘的文章，不是严肃架构论文。很多设计都是先满足当前阶段，再给后续扩展留下口子。

---

## 项目总览

### 当前功能

| 功能模块 | 说明 |
|----------|------|
| 文生图 | 输入提示词，选择质量、比例和分辨率后异步生成 |
| 参考图生成 | 最多上传 3 张参考图，结合提示词生成新图 |
| 图片编辑 | 上传 1 张原图，通过提示词描述修改方向 |
| 用户系统 | 注册、登录、JWT 鉴权 |
| 每日签到 | 发放体验积分，默认 10 天有效 |
| 体验包 | ¥5 购买 30 额度，7 天有效，每个用户一次 |
| 订阅套餐 | Light / Creator / Pro，按月或按年发放订阅额度 |
| 专业工作流 | 预留 `workflow_type`、`workflow_preset`、`workflow_cost`，当前统一按订阅额度扣费 |
| 异步任务 | Redis 队列 + worker 消费，任务状态前端轮询 |
| 失败退款 | Redis 入队失败、上游失败、任务最终失败都会按原扣费来源退款 |
| 生成历史 | 查看、预览、下载、删除历史记录 |
| API Key 控制台 | 管理上游 Base URL / Key / response_format / quality 参数，支持测试、启停、熔断 |
| 生成规格下发 | 后端统一维护质量、比例、分辨率和上传文件限制，前端动态读取 |

### 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3.10+、FastAPI、SQLAlchemy Async |
| 数据库 | SQLite 开发环境，PostgreSQL / MySQL 生产兼容 |
| 迁移 | Alembic |
| 队列 | Redis List，`LPUSH` / `BRPOP` |
| AI 客户端 | `httpx.AsyncClient`，连接池复用、限流、重试、上游审计 |
| 前端 | Vue 3、Vite、Pinia、Element Plus |
| 存储 | 本地静态目录或 S3 兼容对象存储 |
| 部署 | Docker Compose、Nginx、systemd |

当前目录结构大概是这样：

```text
2Bis/
├── backend/
│   ├── app/
│   │   ├── routers/          # auth / generate / edits / points / payment / admin
│   │   ├── services/         # 队列、扣费、AI 调用、存储、生成规格
│   │   ├── models.py         # SQLAlchemy 模型
│   │   ├── schemas.py        # Pydantic Schema
│   │   └── config.py         # 环境变量和业务配置
│   ├── alembic/              # 数据库迁移
│   ├── tests/                # 后端单元测试
│   ├── run.py                # 本地同时启动 API + worker
│   └── worker.py             # 异步生成任务 worker
├── frontend/
│   ├── src/components/
│   ├── src/stores/
│   ├── src/views/
│   └── vite.config.js
└── deploy/
```

---

## 核心架构：HTTP 只负责提交，Worker 负责慢活

AI 生图最大的问题是慢，而且慢得很不稳定。有时几十秒，有时几分钟；如果上游返回 base64 大图，甚至“请求头已经回来了，但响应体还在传”的阶段也会很久。

所以 2Bis 的核心架构还是异步队列：

```text
前端提交生成请求
  -> 后端校验 prompt / quality / size / workflow_type / 上传文件
  -> QuotaManager 扣费并记录 balance_source
  -> 创建 generation_tasks
  -> Redis 入队
  -> worker 调用上游 AI API
  -> 保存图片到本地或 S3
  -> 写入 generate_histories
  -> 前端轮询展示结果
```

这个设计把用户请求和长时间生成拆开了。前端拿到任务 ID 后就可以展示“排队中 / 生成中 / 接收图片数据 / 保存中 / 完成 / 已退款”等状态，而不是让一次 HTTP 请求一直挂着。

### Redis 队列

任务队列仍然是最简单直接的 Redis List：

```python
async def enqueue_generation_task(task_id: int) -> None:
    client = await get_redis()
    await client.lpush(GENERATION_QUEUE_NAME, str(task_id))

async def dequeue_generation_task(timeout: int = 5) -> int | None:
    client = await get_redis()
    item = await client.brpop(GENERATION_QUEUE_NAME, timeout=timeout)
    if item is None:
        return None
    return int(item[1])
```

`LPUSH + BRPOP` 是 FIFO：新任务从左边进，最早的任务从右边出。`BRPOP` 是阻塞读取，队列为空时不会空转吃 CPU。

这里没有上 RabbitMQ / Celery，主要是项目当前阶段还不需要那么重。Redis List 对“单队列、异步任务、worker 消费”这个场景已经够用，而且本地开发和部署成本都低。

### Worker 并发和任务生命周期

Worker 负责真正调用上游：

```python
async def main() -> None:
    await recover_stale_processing_tasks()
    asyncio.create_task(recovery_loop())
    semaphore = asyncio.Semaphore(GENERATION_WORKER_CONCURRENCY)
    running: set[asyncio.Task] = set()

    while True:
        await semaphore.acquire()
        task_id = await dequeue_generation_task(timeout=5)
        if task_id is None:
            semaphore.release()
            continue
        task = asyncio.create_task(run_with_semaphore(semaphore, task_id))
        running.add(task)
        task.add_done_callback(running.discard)
```

这里有几个关键点：

1. **先拿信号量，再取任务**  
   保证 worker 不会一次性从 Redis 取太多任务却处理不过来。

2. **任务状态有完整生命周期**  
   `pending -> processing -> success / refunded`，失败原因、开始时间、结束时间、上游 request id 都会落库。

3. **最终失败自动退款**  
   Worker 捕获异常后，如果属于可重试错误就重新入队；如果是认证失败、余额不足、响应体中断、超时等风险更高的错误，就停止重试并退款。

4. **卡住的 processing 任务不再盲目重跑**  
   现在 `recover_stale_processing_tasks()` 会把超时卡住的任务标记为 `REFUNDED`，而不是直接重置回 `PENDING`。原因很现实：如果上游其实已经扣费并开始生成了，后端只是没收到最终图片，盲目重跑可能造成重复扣上游成本。

这也是这次迭代里我比较深的一个体会：**恢复任务不一定等于重试任务**。对有真实成本的 AI 调用来说，宁可给用户退款，也不要在状态不确定时自动再打一遍上游。

---

## 账务模型：从“积分 + 会员”演进到“体验积分 + 订阅额度”

项目第一版是传统的“付费积分 + 免费积分 + 会员折扣”。后来发现，如果要接专业工作流和高质量生成，单纯积分包会越来越难控成本，于是改成了现在的模型：

| 额度类型 | 来源 | 有效期 | 使用范围 |
|----------|------|--------|----------|
| 体验积分 | 每日签到 | 默认 10 天 | 标准生成的低 / 中质量 |
| 体验包额度 | ¥5 体验包 | 7 天 | 进入订阅额度池 |
| 订阅额度 | Light / Creator / Pro 套餐 | 按订阅周期 | 高质量生成、专业工作流 |

当前套餐配置写在后端配置里：

| 套餐 | 月付 | 年付 | 月度额度 |
|------|------:|------:|---------:|
| Light | ¥29 | ¥268 | 100 |
| Creator | ¥69 | ¥628 | 350 |
| Pro | ¥149 | ¥1368 | 800 |

质量消耗也统一成额度成本：

| 质量 | 成本 |
|------|-----:|
| low | 1 |
| medium | 2 |
| high | 3 |

### QuotaManager 统一扣费

现在所有生成扣费都走 `QuotaManager.deduct_for_generation()`，不再散落在生成路由、编辑路由和旧的积分服务里。

核心规则是：

```text
标准工作流 low / medium
  -> 优先扣体验积分
  -> 体验积分不足再扣订阅额度

标准工作流 high
  -> 只扣订阅额度

专业工作流
  -> 统一扣订阅额度
```

对应逻辑大概是这样：

```python
if (
    normalized_workflow == STANDARD_WORKFLOW_TYPE
    and normalized_quality in EXPERIENCE_POINTS_QUALITIES
    and (user.free_points or 0) >= cost
):
    user.free_points -= cost
    return DeductionResult(cost, "free_points", normalized_workflow, cost)

if has_usable_quota(user) and (user.monthly_quota_remaining or 0) >= cost:
    user.monthly_quota_remaining -= cost
    return DeductionResult(cost, "quota", normalized_workflow, cost)

if normalized_quality == "high":
    raise QuotaError("High quality generation requires subscription quota")
raise QuotaError("Insufficient experience points and subscription quota")
```

注意 `balance_source` 很重要。任务创建时会把它写进 `generation_tasks.balance_source`，失败退款时才能知道该退回体验积分还是订阅额度：

```python
await QuotaManager.refund_generation(
    db,
    task.user_id,
    task.points_cost,
    task.balance_source,
)
```

这就是账务闭环的关键：**扣费时记录来源，退款时按来源回滚**。

### 懒刷新用户状态

`QuotaManager.refresh_user_state()` 还负责处理体验积分过期、订阅额度月度重置、订阅是否有效这些事情。

体验积分过期没有单独上定时任务，而是在查询余额或扣费前刷新：

```python
if user.free_points_expire_at and user.free_points_expire_at <= now:
    user.free_points = 0
    user.free_points_expire_at = None
```

订阅额度也是类似：如果 `monthly_quota_reset_at <= now`，就把重置时间往后推到新的周期，并补回套餐额度。

这种“访问时刷新”的方式比引入调度器简单很多。当前体量下，它更符合项目阶段。

---

## 生成规格：前端展示可以错，后端校验不能错

一开始尺寸选项写在前端常量里，能跑，但问题很明显：如果后端支持范围变了，前端可能还在展示旧选项；如果用户绕过前端直接请求接口，也可能传进来奇怪尺寸。

现在生成规格统一放在 `backend/app/services/generation_options.py`：

```python
MAX_IMAGE_LONG_EDGE = 3840
MAX_IMAGE_PIXELS = 8_294_400
ALLOWED_UPLOAD_MIME_TYPES = ("image/png", "image/jpeg", "image/webp")
```

支持的比例包括：

- `21:9`
- `16:9`
- `3:2`
- `4:3`
- `1:1`
- `3:4`
- `2:3`
- `9:16`

前端通过 `/api/points/plans` 拿到：

- `quality_options`
- `image_size_groups`
- `constraints`
- `workflow_presets`
- `subscription_plans`
- `trial_pack`

所以首页的质量、尺寸、工作流和充值页套餐都可以由后端统一下发。前端本地的 `frontend/src/constants/imageSizes.js` 只作为后端不可用时的兜底。

更重要的是，后端会在扣费前做校验：

```python
quality = GenerationOptions.normalize_quality(data.quality)
size = GenerationOptions.normalize_size(data.size)
workflow_type = QuotaManager.normalize_workflow_type(data.workflow_type)
```

这样非法尺寸、非法质量、非法工作流不会进入扣费，更不会打到上游。

---

## 图生图和编辑：上传文件不能只看扩展名

现在 2Bis 支持三种生成模式：

| 模式 | 路由 | 说明 |
|------|------|------|
| 文生图 | `POST /api/generate` | 只需要提示词 |
| 参考图 | `POST /api/edits` | 最多 3 张参考图 |
| 编辑 | `POST /api/edits` | 只能上传 1 张原图 |

上传限制也写在后端：

```python
MAX_REFERENCE_IMAGES = 3
IMAGE_TASK_MODES = {"ref2img", "edit"}
```

这里踩过的一个坑是：不能只相信浏览器传来的 `content_type`，也不能只看文件后缀。现在会读取文件头判断真实类型：

```python
if file_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
    return "image/png"
if file_bytes.startswith(b"\xff\xd8\xff"):
    return "image/jpeg"
if file_bytes[:4] == b"RIFF" and file_bytes[8:12] == b"WEBP":
    return "image/webp"
```

然后再检查浏览器声明的类型是否和真实文件头一致。这样可以挡掉“后缀是 png，内容其实不是图片”的情况。

上传文件会先保存到 `static/uploads`，任务里记录：

- `source_image_path`
- `source_image_mime_type`
- `source_image_paths`
- `source_image_mime_types`

保留单图字段是为了兼容旧逻辑，多图字段则用 JSON 存储当前参考图列表。

---

## 前端状态：从每个任务一个 interval 改成统一轮询循环

第一版前端轮询是“每个任务开一个 `setInterval`”。任务少的时候没问题，但任务多了以后定时器散得到处都是，也不好处理页面隐藏时的降频。

现在 Pinia store 里改成了统一调度：

```javascript
const POLL_INTERVAL = 5000
const HIDDEN_POLL_INTERVAL = 15000
const ACTIVE_STATUSES = ['pending', 'processing']

function schedulePolling(delay = pollDelay()) {
  if (pollingTimer || !activeTaskIds().length) return
  pollingTimer = window.setTimeout(runPollingLoop, delay)
}
```

核心变化：

- 只维护一个轮询 timer。
- 每轮拉取所有活跃任务。
- 标签页隐藏时从 5 秒降到 15 秒。
- 页面重新可见时立即跑一轮。
- 任务完成后刷新余额。

任务提交仍然保留乐观占位卡：

```javascript
const local = {
  id: `local-${Date.now()}`,
  status: 'queued',
  rawStatus: 'pending',
  prompt,
  quality,
  size,
}
tasks.value.push(local)
```

接口返回真实任务后，再把本地卡片替换掉。这样用户点击“开始生成”后立刻能看到任务进入列表，体验会顺很多。

---

## 上游 API：真正麻烦的是响应体和 Key 管理

AI API 调用看起来只是一次 HTTP 请求，实际项目里最容易出问题的地方就在这里。

当前 `AIClient` 做了这些事情：

- `httpx.AsyncClient` 单例，复用连接池。
- `AI_MAX_CONCURRENT` 控制上游并发。
- `AI_MIN_REQUEST_INTERVAL_SECONDS` 控制最小请求间隔。
- 429 限流时读取 `Retry-After` 或错误文本里的等待时间。
- 记录 header/body/parse/save 各阶段耗时。
- 支持 base64、图片二进制和 URL 三种返回形式。
- 如果返回远程图片 URL，后端会异步镜像到本地或对象存储。
- 对认证失败、余额不足、用量上限、response_format 不支持等错误做分类处理。

最有用的是上游审计字段。任务和历史里都会记录：

```text
upstream_request_id
upstream_request_quality
upstream_request_size
upstream_response_format
upstream_elapsed_seconds
upstream_header_seconds
upstream_body_seconds
upstream_parse_seconds
upstream_save_seconds
upstream_body_bytes
```

这让“为什么一张图生成了很久”不再只能猜。可以知道时间到底花在：

- 等上游开始响应；
- 接收巨大 base64 响应体；
- 解析 JSON；
- 保存图片；
- 还是本地队列排队。

### API Key 控制台

后来又加了一个管理员后台：`/admin/api-keys`。

它解决的是另一个实际问题：上游 Key 不可能永远只靠 `.env` 写死。现在数据库里可以配置多个通道：

- Base URL
- API Key 加密存储
- Key 掩码展示
- `response_format`
- 是否发送 `quality`
- 是否启用
- 是否当前生效
- 最后测试结果
- 最后使用时间
- 失败次数
- 熔断状态

Key 加密用了 Fernet，密钥来自 `API_KEY_ENCRYPTION_SECRET`，没有配置时才回退到 `SECRET_KEY`。

运行时获取配置时有缓存：

```python
API_KEY_CONFIG_CACHE_SECONDS = 5
```

如果当前 Key 出现认证失败、余额不足、用量上限等终止类错误，会打开熔断并切换到下一个可用配置。控制台里能直接看到哪个 Key 熔断、为什么熔断、什么时候恢复。

这个功能虽然不是“生成图片”的主流程，但对一个真实服务很重要。因为 AI 平台最容易遇到的不是代码 bug，而是上游通道不稳定、Key 余额不足、参数兼容性不同。

---

## 踩坑记录

### 坑一：Worker 没启动，任务一直 pending

第一版时我只启动了 FastAPI，忘了启动 worker。结果前端显示任务提交成功，Redis 里也有任务，但没人消费，页面就一直 pending。

后来本地开发入口改成了 `backend/run.py` 同时启动 API 和 worker：

```python
server = uvicorn.Server(config)
worker = asyncio.create_task(worker_main())
try:
    await server.serve()
finally:
    worker.cancel()
```

生产环境仍然可以拆成两个 systemd 服务：

```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
python worker.py
```

开发环境一条命令跑全套，生产环境拆进程，比较清晰。

### 坑二：卡住的 processing 任务到底要不要重试？

最早的想法是：worker 崩了，启动后把 `PROCESSING` 超时任务重新入队。

后来发现这个逻辑对 AI 生图不一定安全。因为任务卡住可能发生在这几种阶段：

- 上游还没开始；
- 上游已经开始但还没返回；
- 上游已经扣费并生成完，后端接收响应体时断了；
- 后端保存图片时挂了。

如果不区分阶段就自动重试，可能重复打上游，真实成本直接翻倍。

所以现在策略改成：发现 stale processing 任务后直接退款并标记失败：

```python
task.status = GenerationTaskStatus.REFUNDED
task.progress_message = "任务处理进程中断，额度已退回。"
```

这不是最完美的恢复策略，但对当前阶段来说更稳。等后续接入更可靠的上游回调或幂等查询接口，再考虑更精细的恢复。

### 坑三：上游返回 200，不代表图片已经收完

有一次看日志发现上游很快返回了 200，但前端还是等很久。后来加了 header/body/parse/save 的耗时审计才看清楚：请求头回来只是第一步，真正耗时的是后面接收大体积 base64 响应体。

所以 worker 里增加了进度阶段：

```text
requesting -> receiving -> saving -> completed
```

接收响应体时还会按时间或字节数更新进度：

```python
正在接收图片数据：12.5MB / 28.0MB，平均 420KB/s
```

这个改动对排查问题很有帮助，也让前端状态不再只是“生成中”三个字。

### 坑四：response_format 不是所有上游都支持

有些图片 API 支持 `response_format=url`，有些兼容服务不支持。最开始我以为传了 URL 返回就能避开 base64 大响应，结果部分上游直接 400。

现在每个 API Key 配置都可以单独设置 `response_format`，默认可以不发送。`AIClient` 也会识别“不支持 response_format”的错误，并给出明确提示，而不是让任务一直重试。

这件事的教训是：**兼容 OpenAI 风格接口，不等于每个参数都兼容**。

### 坑五：任务删除只删前端，刷新后又回来了

这个坑很经典。前端点删除后只是把数组里的任务移除，数据库记录还在。刷新页面重新 `GET /api/generate/tasks`，它当然又回来了。

现在删除任务会调用后端：

```javascript
await api.delete(`/generate/tasks/${id}`)
```

后端删除数据库记录后，如果图片是本地 `/static/` 文件，也会尝试清理文件。

### 坑六：上传图片不能只靠 accept 属性

前端 `<input accept="image/png,image/jpeg,image/webp">` 只是用户体验，不是安全校验。用户完全可以绕过前端直接构造请求。

所以后端必须自己校验：

- 文件不能为空；
- 不能超过 `MAX_UPLOAD_SIZE`；
- 只能是 PNG / JPG / WebP；
- 声明的 `content_type` 要和文件头一致；
- 参考图最多 3 张；
- 编辑模式只能 1 张。

这个逻辑放在后端后，前端写错也不会影响账务和上游调用。

### 坑七：计划信息写死在前端，后面一定会忘记同步

套餐、质量成本、分辨率、工作流最开始都很容易顺手写在前端。问题是后端扣费规则一改，前端可能还显示旧价格。

现在 `/api/points/plans` 一次返回计划、工作流和生成规格，前端只缓存和展示。后端才是权威来源。

这个改动看着不大，但能减少很多“显示 2 额度，实际扣 3 额度”之类的产品事故。

---

## 项目亮点总结

回头看，2Bis 现在已经不只是一个“调 API 出图”的小 demo，而是覆盖了不少真实项目会遇到的问题：

| 方面 | 当前实现 |
|------|----------|
| 异步架构 | FastAPI 提交任务，Redis 排队，worker 消费 |
| 并发控制 | worker 信号量 + AIClient 上游并发限制 + 请求间隔控制 |
| 账务闭环 | QuotaManager 统一扣费，`balance_source` 记录来源，失败按原来源退款 |
| 商业模型 | 体验积分、体验包、订阅套餐、专业工作流预留 |
| 生成规格 | 后端统一下发质量、比例、分辨率和上传限制 |
| 多模式生成 | 文生图、参考图、图片编辑 |
| 状态体验 | 前端乐观占位、统一轮询、隐藏页降频、任务进度消息 |
| 上游治理 | API Key 数据库配置、加密存储、测试、熔断、缓存 |
| 可观测性 | 上游 request id、header/body/parse/save 耗时、响应体大小 |
| 存储 | 本地静态目录和 S3 兼容对象存储预留 |
| 部署 | Docker Compose、Nginx、systemd 配置 |
| 测试 | 覆盖 quota、generation options、AI client、worker recovery、history、admin api keys |

---

## 下一步计划

目前项目还在继续迭代，短期我更关注这些方向：

- 上线后根据真实成功率、成本和用户使用习惯调整套餐额度。
- 继续完善专业工作流，不只停留在字段预留。
- 把轮询逐步替换成 WebSocket 或 SSE，减少无效请求。
- 增加更完整的管理后台：用户、订单、额度流水、生成统计。
- 补充更细的账务流水表，让每一次扣费和退款都有独立记录。
- 如果上游尺寸白名单更严格，继续收敛当前分辨率选项。

---

## 结语

2Bis 这段时间最大的变化，是从“我能不能把全栈跑起来”，变成了“这个东西如果真的给用户用，会在哪些地方出问题”。

异步队列、扣费退款、上传校验、上游审计、API Key 熔断，这些功能单独看都不酷，但它们决定了一个 AI 绘图平台能不能稳定运转。

项目目前仍在开发中，暂时没有开源。等核心闭环更稳定后，后面会考虑整理成一个更完整的学习案例。希望这篇更新后的记录，也能给正在做类似项目的你一点参考 (｀・ω・´)
