import type { MusicPlayerConfig } from "../types/config";

// 音乐播放器配置
export const musicPlayerConfig: MusicPlayerConfig = {
	// 禁用音乐播放器方法：
	// 模板默认侧边栏和导航栏两个都显示
	// 1. 侧边栏：在sidebarConfig.ts侧边栏配置把音乐组件enable设为false禁用即可
	// 2. 导航栏：在本配置文件把showInNavbar设为false禁用即可

	// 是否在导航栏显示音乐播放器入口
	showInNavbar: true,

	// 使用方式："meting" 使用 Meting API，"local" 使用本地音乐列表，"bilibili" 使用B站视频音频
	mode: "meting",

	// 默认音量 (0-1)
	volume: 0.7,

	// 播放模式：'list'=列表循环, 'one'=单曲循环, 'random'=随机播放
	playMode: "list",

	// 是否显启用歌词
	showLyrics: true,

	// Meting API 配置
	meting: {
		// Meting API 地址
		// 默认使用官方 API，也可以使用自定义 API
		api: "https://api.i-meto.com/meting/api?server=:server&type=:type&id=:id&r=:r",
		// 音乐平台：netease=网易云音乐, tencent=QQ音乐, kugou=酷狗音乐, xiami=虾米音乐, baidu=百度音乐
		server: "netease",
		// 类型：song=单曲, playlist=歌单, album=专辑, search=搜索, artist=艺术家
		type: "playlist",
		// 歌单/专辑/单曲 ID 或搜索关键词
		id: "10046455237",
		// 认证 token（可选）
		auth: "",
		// 备用 API 配置（当主 API 失败时使用）
		fallbackApis: [
			"https://api.injahow.cn/meting/?server=:server&type=:type&id=:id",
			"https://api.moeyao.cn/meting/?server=:server&type=:type&id=:id",
		],
	},

	// 本地音乐配置（当 mode 为 'local' 时使用）
	// 1. 支持传入歌词文件的路径
	// lrc: "/assets/music/lrc/使一颗心免于哀伤-哼唱.lrc",
	// 2. 或者直接填入歌词字符串内容
	// lrc: "[00:00.00]歌词内容...",
	local: {
		playlist: [
			{
				name: "使一颗心免于哀伤",
				artist: "知更鸟 / HOYO-MiX / Chevy",
				url: "/assets/music/使一颗心免于哀伤-哼唱.mp3",
				cover: "/assets/music/cover/109951169585655912.webp",
				lrc: "",
			},
		],
	},

	// Bilibili 视频音频配置（当 mode 为 'bilibili' 时使用）
	// B站拥有大量免费音乐内容：翻唱、VOCALOID、OST、同人音乐等，无需VIP即可播放
	// 使用方式：
	//   1. 找一个B站音乐视频，复制它的 BV 号
	//   2. 将 type 设为 "video"，id 填 BV 号（如 "BV1GJ411m8Q7"）
	//   3. 也可使用收藏夹 ID，将 type 设为 "playlist"
	// 注意：B站官方 API 返回的视频 URL 可能无法直接播放（需要 CORS 代理）
	// 推荐使用第三方 B 站音频提取服务（如默认示例），或自行部署 B 站音频转发服务
	bilibili: {
		// Bilibili 音频提取 API 地址
		// 支持占位符：:type（video/playlist）, :id（BV号/收藏夹ID）, :r（随机数）
		// 默认使用开源的 bilibili-api（返回 Meting 兼容格式），你也可以自建
		api: "https://api.boos.ink/bilibili/api?type=:type&id=:id&r=:r",
		// 类型：video=单个视频, playlist=收藏夹/合集
		type: "video",
		// Bilibili 视频 BV 号（示例：BV1GJ411m8Q7）
		// 收藏夹示例（需将 type 改为 "playlist"）："123456789"
		id: "BV1GJ411m8Q7",
		// 认证 cookie（可选，某些 API 需要传入 B 站 Cookie 以获取高音质）
		auth: "",
		// 备用 API 配置（当主 API 失败时使用）
		// 可添加其他兼容 Meting 格式的 Bilibili 音频提取服务
		fallbackApis: ["https://api.bilibili.com/x/web-interface/view?bvid=:id"],
	},
};
