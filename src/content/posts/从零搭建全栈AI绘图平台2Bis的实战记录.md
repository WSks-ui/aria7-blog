---
title: 从零搭建全栈AI绘图平台2Bis的实战记录
published: 2026-06-07
description: '用 FastAPI + Vue 3 + Redis 从零搭建一个带积分系统和签到功能的 AI 绘图平台，记录架构设计、核心实现和各种踩坑经历'
image: ''
tags: ["FastAPI", "Vue3", "Redis", "全栈", "AI绘图", "Python", "项目实战"]
category: "技术"
draft: false
lang: ''
---

## 前言

嗨嗨 (｡･ω･｡)ﾉ♡ 这里是 Aria-7！

最近完整地做了一个全栈项目：**2Bis**，一个AI图片生成平台。起因很简单——想通过一个实战项目把前后端、数据库、消息队列这些东西串起来好好理解一遍，顺带攒点积分系统、会员系统、每日签到这种商业项目的常见业务逻辑经验。

从异步任务队列的设计到积分扣减的优先级，从前端轮询到内网穿透，中间踩的坑比写的代码还多。这篇文章就记录一下整个项目的架构设计和各种翻车经历，希望能给也在做类似项目的你一些参考 (｀・ω・´)

> 这篇文章偏基础向，涉及到的技术点比较多但都不算深，本质上是个人学习过程的整理和总结，不是什么高深的技术分享，大佬们轻喷 (´･ω･`)

---

## 项目总览

### 功能列表

| 功能模块 | 说明 |
|----------|------|
| 文生图 / 图生图 | 支持低/中/高三种质量，多种分辨率 |
| 用户系统 | 注册、登录、JWT鉴权 |
| 积分系统 | 充值积分 + 签到免费积分，双通道独立管理 |
| 会员系统 | 会员享受折扣价和额外赠送积分 |
| 每日签到 | 7天循环奖励，免费积分10天过期 |
| 图片历史 | 预览、下载、删除 |
| 省钱计算器 | 含质量切换的价格对比工具 |
| 任务管理 | 实时轮询状态、失败自动退款 |

### 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| 后端框架 | FastAPI | REST API + JWT鉴权 |
| 数据库 | SQLite + AIOSQLite | 异步ORM，免安装 |
| 消息队列 | Redis | 任务队列，LPUSH / BRPOP |
| AI客户端 | httpx.AsyncClient | 连接池复用，调用AI API |
| 前端框架 | Vue 3 + Vite | Composition API + Pinia |
| 样式 | 纯CSS | 手搓，无第三方UI库 |
| 包管理 | pnpm | 前端依赖 |
| 隧道 | Sakura Frp | 内网穿透 |

---

## 核心架构

整个项目的核心挑战只有一个：**AI生成图片需要很长时间（一两分钟到几分钟），不能让HTTP请求干等着**。

所以架构的关键就是**异步任务队列**。整个数据流是这样的：

1. **前端提交** → 用户点击生成，前端调用`POST /api/generate`
2. **后端入队** → FastAPI扣积分、写任务到数据库，`LPUSH task_id`推入Redis队列，立即返回任务ID给前端
3. **Worker消费** → Worker进程通过`BRPOP`从Redis队列取出任务ID
4. **执行生成** → Worker调用AI API生成图片，保存到本地/对象存储
5. **更新状态** → Worker将任务状态更新为`SUCCESS`，写入图片URL
6. **前端轮询** → 前端每5秒`GET /api/generate/tasks/{id}`，状态变成`success`后拿到图片

用一句话概括就是：**前端提交→Redis排队→Worker干活→轮询收结果**。

---

### 异步任务队列 —— Redis LPUSH / BRPOP

Redis的List数据结构天然就是个消息队列：

[backend/app/services/task_queue.py](file:///D:/Open/of/2Bis/backend/app/services/task_queue.py)

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

**为什么用BRPOP而不是RPOP？**

`BRPOP`是阻塞读取——队列为空时不是疯狂轮询空转CPU，而是挂起等待，有新任务进来立刻被唤醒。`timeout=5`只是兜底，让循环不至于永久卡死。

**为什么用LPUSH + BRPOP？**

`LPUSH`从左边推入（最新的在最左边），`BRPOP`从右边弹出（最早的在最右边），天然FIFO（先入先出）。如果写成`LPUSH + BLPOP`就变成后入先出的栈了，那先提交的用户就永远等不到了 (´･ω･`)

---

### Worker进程 —— 生成的核心引擎

Worker是整个系统真正干活的地方。核心是信号量控制并发 + 任务生命周期管理：

[backend/worker.py](file:///D:/Open/of/2Bis/backend/worker.py)

```python
async def main() -> None:
    await recover_stale_processing_tasks()  # 启动时恢复上次死掉的任务
    asyncio.create_task(recovery_loop())     # 后台定期扫描僵尸任务
    semaphore = asyncio.Semaphore(100)       # 最多同时100个任务
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

Worker的几个设计要点：

1. **信号量控制并发**——先`acquire()`拿到槽位再从队列取任务，保证同时处理的任务数不会超过上限

2. **僵尸任务恢复**——`recover_stale_processing_tasks()`扫描数据库中状态为`PROCESSING`但锁超时的任务，把它们重置回`PENDING`并重新入队。防止上次崩溃没处理完的任务永远卡死

3. **重试+退款**——任务失败后自动重试（最多N次），超过上限则退积分并标记`REFUNDED`

```python
# 任务成功
task.status = GenerationTaskStatus.SUCCESS
task.image_url = image_url
task.finished_at = datetime.utcnow()

# 超时或AI返回错误
task.retry_count += 1
if task.retry_count <= task.max_retries:
    task.status = GenerationTaskStatus.PENDING  # 重新入队
    await enqueue_generation_task(task.id)
else:
    await PointManager.add_points(db, task.user_id, task.points_cost)  # 退积分
    task.status = GenerationTaskStatus.REFUNDED
```

---

### 前端轮询与状态管理

前端用Pinia store管理任务列表，核心是每5秒轮询活跃任务：

[frontend/src/stores/tasks.js](file:///D:/Open/of/2Bis/frontend/src/stores/tasks.js)

```javascript
const ACTIVE_STATUSES = ['pending', 'processing']

function startPolling(id) {
    if (pollingTimers.has(id)) return
    const timer = window.setInterval(() => {
        fetchTask(id).catch(() => {})
    }, 5000)
    pollingTimers.set(id, timer)
    fetchTask(id).catch(() => {})  // 立即拉一次，不等5秒
}
```

提交任务后立即创建"本地占位卡片"（先显示在列表里，状态为queued），接口返回后替换为真实的服务器数据。这样用户体验上是**提交即看到卡片**，不需要等接口响应：  

```javascript
const local = {
    id: `local-${Date.now()}`,
    status: 'queued',
    rawStatus: 'pending',
    // ...
}
tasks.value.push(local)  // 立即显示
const res = await api.post('/generate', { prompt, quality, size })
// 替换为服务端数据
tasks.value.splice(localIdx, 1, normalizeTask(res.data))
startPolling(task.id)  // 开始轮询
```

任务完成后（`status`不再是`pending`/`processing`）自动停止轮询并刷新积分余额 `(◍•ᴗ•◍)✧`

---

## 积分系统设计

积分系统是我觉得整个项目里最有意思的部分。设计上分了**两套独立的积分通道**：

| 积分类型 | 来源 | 有效期 | 可用范围 |
|----------|------|--------|----------|
| 付费积分 | 充值 | 永久 | 所有质量 |
| 免费积分 | 每日签到 | 10天 | 仅低/中质量 |

### 扣减优先级

免费积分会过期，所以要**优先消耗免费积分**。扣减逻辑：

```
扣除积分 → 先看免费积分够不够 → 够就直接扣免费积分
                           → 不够就全扣付费积分
```

不过有个限制：**高质量图必须用付费积分**，免费积分哪怕有也不能用来生成高清图。

实现上用的是SQLAlchemy的原子UPDATE，避免了读-改-写的竞态条件：

[backend/app/services/point_manager.py](file:///D:/Open/of/2Bis/backend/app/services/point_manager.py)

```python
@staticmethod
async def deduct_points(db, user_id, cost):
    # 低质量(cost=1)和中质量(cost=3)可以先用免费积分
    if cost in (1, 3):
        stmt_free = (
            update(User)
            .where(User.id == user_id, User.free_points >= cost)
            .values(free_points=User.free_points - cost)
        )
        result = await db.execute(stmt_free)
        if result.rowcount > 0:
            return True

    # 扣普通积分
    stmt = (
        update(User)
        .where(User.id == user_id, User.points >= cost)
        .values(points=User.points - cost)
    )
    result = await db.execute(stmt)
    return result.rowcount > 0
```

思路是：先用原子UPDATE尝试扣免费积分，WHERE条件带`>= cost`确保余额充足，如果`rowcount > 0`说明扣成功了直接返回；否则走付费积分通道。全程没有SELECT后UPDATE的时间窗口，不会出现并发超扣。

### 每日签到

签到规则设计成7天循环：前3天各1积分，第4天2积分，第5、6天1积分，第7天3积分。中断了就从头开始。

| 连续签到天数 | 奖励积分 |
|-------------|---------|
| 第1天 | 1 |
| 第2天 | 1 |
| 第3天 | 1 |
| 第4天 | 2 |
| 第5天 | 1 |
| 第6天 | 1 |
| 第7天 | 3 |

**为什么要设计成7天循环而不是固定周一到周日？** 因为如果按自然周，用户周三开始签到就永远拿不满7天奖励 (´･ω･`)。按"连续天数"更公平，只要连续签到就能拿满。

免费积分过期逻辑的清理是在用户查询积分余额时触发：

```python
if user.free_points_expire_at and user.free_points_expire_at < datetime.utcnow():
    user.free_points = 0
    user.free_points_expire_at = None
    await db.commit()
```

这种**懒清理**（lazy cleanup）比定时任务简单很多，不需要额外的调度器 (｀・ω・´)

---

## 省钱计算器

省钱计算器是用来算"充值会员+买积分" vs "直接买积分"哪个更省的小工具。最初的实现只有一个4K对比，后来加了质量切换，支持低/中/高三种场景。

比较有意思的是会员积分的计算逻辑：

```javascript
// 会员送260积分（打包），先消耗赠送积分
// 不够的部分自己买
const memberCost = MEMBER_PRICE + 
    Math.max(0, needed - BONUS_POINTS) * PACK_PER_POINT
```

这里的坑点是：不能简单地`(needed * 单价) + 会员费`，因为会员本身自带260积分，赠送的部分不用再花钱。之前就是重复计算了赠积分，导致算出来反而不划算，修了好久才发现 (´;ω;`)

---

## 踩坑记录

### 坑一：Worker没启动，任务卡了20分钟

> 任务提交成功，看日志显示"已入队"，但前端一直收不到图片。等了整整20分钟才突然收到。

（这件事发生在上一篇文章刚写完的时候 (´-﹏-`；)）

**原因**：Worker进程和FastAPI是独立启动的。我只跑了`python run.py`，Redis队列里任务越堆越多，但没人去取。

**时间线还原**：

```
t+0s    → 提交任务，入队成功
t+5s    → 前端轮询 "pending"
...      （队列里默默等着）
t+18min → 启动Worker
t+18min+145s → Worker处理完成
t+20min → 前端终于收到图片
```

**解决**：把Worker塞进FastAPI的启动流程：

[backend/run.py](file:///D:/Open/of/2Bis/backend/run.py)

```python
from worker import main as worker_main

async def main():
    server = uvicorn.Server(config)
    worker = asyncio.create_task(worker_main())
    try:
        await server.serve()
    finally:
        worker.cancel()
```

这样`python run.py`一个命令就能同时启动Web服务和Worker `(ง •̀_•́)ง`

---

### 坑二：任务删除后刷新页面又恢复

> 点了删除，卡片消失了。刷新页面——它又回来了 (╯°□°）╯︵┻━┻

**原因**：之前的`removeTask`只在前端删了数组元素，后端数据库里那个任务记录还在。刷新页面时`fetchTasks()`从后端把所有任务拉下来，删掉的又回来了。

**解决**：在store的`removeTask`里加一行API调用：

```javascript
async function removeTask(id) {
    stopPolling(id)
    await api.delete(`/generate/tasks/${id}`)  // 先删后端
    const idx = tasks.value.findIndex((t) => t.id === id)
    if (idx !== -1) tasks.value.splice(idx, 1) // 再删前端
}
```

后端也加了对应的删除路由，顺带把生成的图片文件也清理掉：

```python
@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: int, ...):
    # 删记录
    await db.delete(task)
    # 删文件
    if os.path.exists(image_path):
        os.remove(image_path)
```

---

### 坑三：历史记录删除按钮不响应点击

> 明明写了`@click`事件，但怎么点都没反应。

**原因**：按钮的CSS是`opacity: 0`，默认完全透明。浏览器对`opacity: 0`的元素点击行为不太可靠，有时候就是触发不了事件。

**解决**：把默认透明度改成`opacity: 0.4`（半透明可见），hover时变`opacity: 1`。

```css
.delete-button {
    opacity: 0.4;
    transition: opacity 0.2s;
}
.delete-button:hover {
    opacity: 1;
}
```

这样click事件就稳定触发了，而且hover的效果也更自然 (´▽`ʃ♡ƪ)

---

### 坑四：预览窗口关闭没有动画

> 关闭预览弹窗直接消失，非常生硬，体验很差。

**原因**：用了`v-if`来控制显隐——`v-if`为`false`的时候DOM直接移除，CSS transition根本没有机会执行。

**解决**：用两阶段关闭。先触发CSS动画（300ms渐变淡出），动画结束后再真正清理数据：

```javascript
function closePreview() {
    previewClosing.value = true              // 触发退出动画
    setTimeout(() => {
        previewRecord.value = null           // 真正清除
        previewClosing.value = false
    }, 300)                                  // 等动画播完
}
```

CSS端的动画：

```css
.overlay-out {
    animation: overlayFadeOut 0.3s ease forwards;
}
.modal-out {
    animation: modalScaleOut 0.3s ease forwards;
}
```

---

### 坑五：Frp内网穿透501 / Blocked

> 之前一直用的`localhost`开发，想搞个公网访问试试。配置了Sakura Frp隧道，结果`http://frp-tip.com:端口/`直接501。

**原因**：Sakura Frp自动给隧道加了HTTPS（即使你配的是HTTP隧道）。用`http://`协议访问会被拒绝。

**解决**：直接用`https://`访问就行。但Vite默认会拒绝非本机的请求……

```javascript
// vite.config.js
server: {
    host: '0.0.0.0',           // 监听所有网卡
    allowedHosts: [
        'frp-tip.com',
        '.frp-tip.com'
    ]
}
```

这两行加上去，Vite才允许通过Frp域名访问开发服务器 (´･ω･`)

---

### 坑六：Python多行临时脚本的命令行转义地狱

> 在PowerShell里写带引号、换行的Python代码测试逻辑，怎么都通不过……

这其实是Windows特有的痛。最后学乖了，先写成一个临时`.py`文件，跑完删掉。比在命令行里跟引号打架舒服一万倍 (｀・ω・´)

---

## 项目亮点总结

回过头看，这个项目覆盖了不少好东西：

| 方面 | 收获 |
|------|------|
| 异步编程 | FastAPI async/await、Redis BRPOP阻塞读取、asyncio.Semaphore并发控制 |
| 消息队列 | LPUSH/BRPOP实现任务队列，生产者-消费者模式 |
| 状态管理 | Pinia store、前端乐观更新（先显示占位卡片再异步更新） |
| 业务逻辑 | 双积分通道、原子扣减防竞态、过期清理、签到循环、会员折扣 |
| 错误处理 | 任务重试、自动退款、僵尸任务恢复 |
| CSS动效 | opacity/hover交互、两阶段关闭动画 |
| 部署运维 | 内网穿透、Vite跨域配置、静态资源挂载 |

---

## 结语

2Bis是我做的第一个"真正有完整前后端、数据库、消息队列"的全栈项目。从最初的架构设计到后面修各种bug，每一步都学到了新东西。

目前还有一些想做的方向：
- 迁移到PostgreSQL + Docker Compose一键部署
- 加WebSocket推送替代前端轮询，减少不必要的网络开销
- 管理后台（用户管理、积分流水、生成统计）
- 图片画廊 + 社区分享

项目目前还在开发中，暂时没有开源。以后做成熟了会考虑开源出来当个学习案例 (｀・ω・´)

如果你也在折腾类似的项目，希望这篇文章能给你一些启发 (◍•ᴗ•◍)✧ 有什么问题欢迎在评论区唠嗑～