import type { AnnouncementConfig } from "../types/config";

export const announcementConfig: AnnouncementConfig = {
	// 公告标题
	title: "公告",

	// 公告内容
	content:
		"📢 临近期末，正在专心备考中。期间可能会整理一些学习笔记发布，但内容非常基础（第12周才开始学专业课，啥也不会），主要是给自己看的，对大家可能没什么参考价值。博客约等于停更状态啦 (´･ω･`)

	// 是否允许用户关闭公告
	closable: true,

	link: {
		// 启用链接
		enable: true,
		// 链接文本
		text: "了解更多",
		// 链接 URL
		url: "/about/",
		// 内部链接
		external: false,
	},
};
