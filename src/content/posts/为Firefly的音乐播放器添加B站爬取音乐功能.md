---
title: 给Firefly音乐播放器接上B站
published: 2026-05-31
description: 记录将Bilibili音频源接入博客播放器，以及自建播放列表功能从构思到落地的完整过程
image: "/assets/images/posts/B站音乐播放器/cover.png"
tags: ["Astro", "Firefly", "音乐播放器", "Bilibili", "JavaScript", "博客"]
category: "技术"
---

## 说在前头

我的博客用的是[Firefly](https://github.com/skylie/firefly)主题，自带一个挺好看的音乐播放器。默认支持两种模式：**Meting API在线音乐**和**本地音乐**。但一直有个遗憾 -- 播放器不支持Bilibili。

作为一个重度B站用户，经常听到好听的BGM想收藏到博客里。如果能直接在博客的播放器里播B站视频的音频，那该多好。

于是我开始了漫长的魔改之路...

---

## 总体架构

最终实现的功能和流程如下：

```
用户输入 BV 号
    ↓
Vercel Serverless (api/bilibili-audio.js)
    ├── 请求 B站官方接口获取音频流
    │   └── 返回 { title, artist, pic, audio_url }
    ↓
MusicManager (后台控制器)
    ├── 管理播放状态、队列、音量
    ├── 维护已保存的视频收藏
    └── 维护自建播放列表
    ↓
MusicPlayer (UI 组件)
    ├── 播放器控件（播放/暂停/上下曲/进度条）
    ├── 播放列表抽屉
    ├── 歌词展示
    └── 音源面板（添加视频、收藏、播放列表）
```

核心是两个Astro组件：**MusicManager**（数据层）和**MusicPlayer**（表现层），通过`window.__fireflyMusic`全局对象和自定义事件`fm:*`通信。

---

## Phase 1: Bilibili音频代理

这是最基础的一步。B站的前端接口加了CORS限制，浏览器直接请求`api.bilibili.com`会被拦截。解决方案是用**Vercel Serverless Function**做代理。

[api/bilibili-audio.js](file:///D:/Open/Wike/Firefly/api/bilibili-audio.js)接收`?bvid=BV1xxx&meta=1`参数，向B站接口请求数据：

```javascript
// Step 1: 获取视频基本信息
const infoUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;

// Step 2: 获取音频流 URL
const audioUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&qn=0&fnver=0&fnval=4048&fourk=1`;

// Step 3: 返回格式化数据
return { title, artist, pic, audio_url };
```

**关键点**：`fnval=4048`这个参数告诉B站API返回`dash`格式的流，其中包含纯音频轨道（`audio`），而不是视频流。这样前端只需要一个`<audio>`标签就能播放。

这个函数部署在Vercel上，配置了512MB内存和30s超时：

```json
{
  "functions": {
    "api/bilibili-audio.js": {
      "memory": 512,
      "maxDuration": 30
    }
  }
}
```

---

## Phase 2: 组件通信架构

MusicManager是整个播放器的**大脑**，使用IIFE模式封装在`window.__fireflyMusic`里：

```
MusicManager → 事件广播 → MusicPlayer
     ↑                        ↓
     └── 方法调用 ←───────────┘
```

### 事件系统

```javascript
// MusicManager 端
function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

// MusicPlayer 端
function on(name, fn) {
  handlers[name] = fn;
  window.addEventListener(name, fn);
}
```

### 播放器状态

```javascript
var state = {
    playMode: 0,        // 0=列表循环, 1=单曲循环, 2=随机
    volume: 0.7,
    isMuted: false,
    isPlaying: false,
    playlist: [],
    currentIndex: 0,
    lyrics: [],
    currentLrcIndex: -1
};
```

状态全在Manager中，Player只监听事件渲染UI。这种**事件驱动+单向数据流**的设计让两个组件解耦得很好。

![播放器控制区域：进度条、音量、播放/暂停、列表/歌词抽屉](/assets/images/posts/B站音乐播放器/player-controls.png)

---

## Phase 3: 第三方API + 官方API降级

B站音频获取并不只有一条路。MusicManager实现了多层降级策略：

```
setBilibiliSource('video', bvid)
    ↓
Layer 1: 第三方 API（用户配置的多个 API 端点）
    ├── 遍历所有 API
    ├── 替换 :type, :id, :r 占位符
    └── 如果成功 → 使用该数据
    ↓ (全部失败)
Layer 2: B站官方 API（通过代理）
    ├── /api/bilibili-audio?bvid=xxx
    ├── 获取音频直链
    └── 如果成功 → 使用该数据
    ↓ (全部失败)
抛出错误 "All Bilibili APIs failed"
```

这种多层设计保证了即使某个第三方API挂了，用户仍然能通过官方接口播放。

---

## Phase 4: 自建播放列表

一开始我尝试了直接导入B站收藏夹，但B站的API限制太多（需要Cookie、跨域、私有收藏夹不可访问），体验很糟糕。

![老版本的B站收藏夹导入方案：选择收藏夹类型后输入fid](/assets/images/posts/B站音乐播放器/old-collection-approach.png)

后来换了个思路 —— **让用户在博客里自己创建播放列表**，把想听的BV号归类管理：

### 数据模型

```javascript
// localStorage["music-custom-playlists"]
[
  {
    id: "pl_xxx_yyy",
    name: "日推歌单",
    tracks: [
      { bvid: "BV1Gi576kE2T", title: "使一颗心免于哀伤", artist: "知更鸟", pic: "" },
      { bvid: "BV1xxx", title: "卡农摇滚版", artist: "...", pic: "" }
    ],
    createdAt: 1685000000000,
    updatedAt: 1685000000000
  }
]
```

### 功能

音源面板分三个区域：

**1. 视频输入区** —— 输入BV号点击"应用"直接播放，或点"收藏"保存到本地。

**2. 我的收藏** —— 所有收藏过的视频列在这里。每条右侧有两个按钮：
- `[+]` 弹出播放列表选择框，将视频添加到指定歌单
- `[删除]` 从收藏中移除

**3. 自建播放列表** —— 顶部输入框可创建新的歌单。每个歌单条目显示名称和曲目数，hover后出现"全部播放"和"删除"按钮。点击歌单标题可**展开**查看内部曲目，每首曲目同样有`[+]`（添加到播放队列）和`[删除]`（移出歌单）按钮。

每个`[+]`按钮会弹出播放列表选择框，点击后曲目会**追加到主播放队列的末尾**，而不是替换当前播放。

![已保存的视频收藏列表：每个视频旁有[+]添加到播放列表和删除按钮](/assets/images/posts/B站音乐播放器/saved-videos.png)

![自建播放列表展开状态：显示曲目名称、BV号，右侧[+]和删除按钮](/assets/images/posts/B站音乐播放器/playlists.png)

### 多曲目队列

```javascript
async function setBilibiliPlaylist(bvids) {
    // 逐个获取音频 URL
    var tracks = [];
    for (var i = 0; i < bvids.length; i++) {
        var t = await fetchBilibiliVideoTracks(bvids[i]);
        tracks.push(t[0]);
    }
    state.playlist = tracks;     // 替换整个队列
    loadTrack(0, true);          // 自动播放第一首
}

async function addToBilibiliQueue(bvid) {
    var t = await fetchBilibiliVideoTracks(bvid);
    state.playlist.push(t[0]);   // 追加到队列末尾
    emit('fm:queue-updated');    // 通知 UI 刷新
}
```

这样用户就可以从不同播放列表里挑选曲目，拼接成自己的专属播放队列了。配合播放器的**列表循环/单曲循环/随机播放**三种模式，体验还不错。

---

## 性能优化 & 踩坑

### 1. CSS transition GPU加速

播放器用了大量CSS transition（打开/关闭抽屉、进度条拖拽），如果全部用CPU渲染会卡顿。在样式里加了一行：

```css
.playlist-drawer, .source-drawer {
    transition: grid-template-rows 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
```

利用`cubic-bezier`缓动函数让动画更丝滑，

### 2. DOM清理

播放器组件可能因为页面导航被移除，如果不清理事件监听器会造成内存泄漏：

```javascript
var observer = new MutationObserver(function (mutations) {
    for (var mutation of mutations) {
        if (mutation.removedNodes.contains(widget)) {
            Object.keys(handlers).forEach(function (name) {
                window.removeEventListener(name, handlers[name]);
            });
            document.removeEventListener('click', popupDocHandler, true);
            observer.disconnect();
        }
    }
});
```

### 3. 本地存储溢出

`localStorage`有5MB限制，如果用户收藏了大量视频或播放列表很大可能存不下。目前的处理是静默try-catch，但理论上可以考虑压缩或分片存储。

---

## 总结

经过几天的折腾，最终给Firefly的音乐播放器加上了这些能力：

| 功能 | 说明 |
|------|------|
| B站视频播放 | 输入BV号，代理获取音频流 |
| 视频收藏 | 保存喜欢的视频到本地 |
| 自建播放列表 | 创建分类歌单，管理视频 |
| 全部播放 | 一键加载整个列表到队列 |
| 追加到队列 | 从列表中挑选曲目拼接播放 |
| 播放模式 | 列表循环 / 单曲循环 / 随机 |
| 歌词展示 | 支持B站视频歌词加载 |
| 多层降级 | 第三方API->官方API自动切换 |

代码托管在[GitHub](https://github.com/WSks-ui/aria7-blog)上，欢迎指教和Star。

如果你也在用Astro + Firefly，希望这篇博客能给你一些魔改的灵感。
