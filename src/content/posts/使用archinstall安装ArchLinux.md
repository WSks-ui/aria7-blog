---
title: 使用archinstall安装ArchLinux
published: 2026-06-03
description: 使用 archinstall 在 VMware 虚拟机中安装 ArchLinux 的完整记录，包含配置选项说明和四个常见坑的解决方法
tags: ["ArchLinux", "archinstall"]
category: "技术"
---

## 前言

ArchLinux 以滚动更新和极简主义著称，但传统安装方式需要手动执行几十条命令，对新手不太友好。官方推出的 `archinstall` 脚本通过交互式菜单大大简化了安装过程。本文将记录使用 archinstall 在 VMware 虚拟机中安装 ArchLinux 的完整经历，并总结遇到的坑及解决方法

本文基于以下环境实测：主机 Win11（AMD R9 AI 365H，32GB），VMware 虚拟机分配 4GB 内存、30GB 硬盘、2核4线程，Linux 内核版本 7.x

## 准备工作

### 下载ISO并制作启动盘

从 [Arch Linux 官网](https://archlinux.org/download/) 下载最新的 ISO 镜像

物理机使用 Rufus、balenaEtcher 或 Ventoy 写入U盘；虚拟机直接挂载ISO即可

### 启动到Live环境

从 U盘/ISO 启动，选择 "Arch Linux install medium"，默认进入 root 用户的 shell

### 连接网络（关键步骤）

archinstall 需要在线拉取软件包，务必在运行安装器前确保网络通畅

**有线网络**：通常自动获取 IP，测试 `ping baidu.com`

**无线网络（使用 iwctl）**：

```bash
iwctl
device list                     # 查看无线网卡名称，如 wlan0
station wlan0 scan
station wlan0 get-networks
station wlan0 connect "SSID"    # 输入密码
exit
```

## 运行 archinstall

在 Live 环境中直接输入：

```bash
archinstall
```

脚本会在一个配置界面中展示所有可选项（使用方向键和 Tab 切换，Enter 确认）：

| 选项 | 推荐设置 | 说明 |
|------|----------|------|
| 语言 | English | 安装器界面语言 |
| 键盘布局 | us | 保持默认 |
| 镜像地区 | China | 国内用户必选，否则下载极慢 |
| 系统语言 | en_US.UTF-8 | 建议先不设中文，避免终端乱码 |
| 磁盘分区 | 最佳配置（Best-effort） | 自动分区（会擦除整个磁盘） |
| 加密 | 否 | 新手可不加密 |
| Swap | 4G（或等于内存大小） | 内存 ≤ 8G 时建议设 Swap |
| 主机名 | 任意 | 例如 archlinux |
| Root 密码 | 设置强密码 | 留空会禁用 root 账户 |
| 普通用户 | 创建用户名和密码 | 日常使用推荐 |
| 配置文件 | 桌面环境（如KDE Plasma） | 选好会自动安装图形界面 |
| 音频 | pipewire | 推荐 |
| 额外软件包 | vim firefox 等 | 可选 |

确认无误后选择 Install 开始安装

## 常见坑及解决

### 坑一：VMware 虚拟机网络子网冲突导致无法联网

**现象**：虚拟机无法获取 IP 地址，或 ping 任何外网都失败

**原因**：VMware 虚拟网络编辑器中，VMnet0 和 VMnet8 使用了相同的子网 `192.168.181.0`，导致网络路由混乱

**解决**：

1. 打开 VMware "编辑" → "虚拟网络编辑器"
2. 选中 VMnet8（NAT模式），修改"子网IP"为不冲突的值，例如 `192.168.88.0`
3. 点击"应用"或"确定"（需要管理员权限）
4. 在虚拟机中重启网络服务：`systemctl restart systemd-networkd` 或直接重启虚拟机
5. 重新获取 IP：`dhcpcd` 或 `systemctl restart dhcpcd`
6. 验证：`ip addr` 应能看到类似 `192.168.88.129` 的地址，`ping 114.114.114.114` 正常

### 坑二：archinstall 卡在 "Waiting for time sync" 或 "Waiting for keyring sync"

**现象**：运行 archinstall 后，进度长时间（>3分钟）停留在同步时间或密钥环阶段

**原因**：网络延迟或 GPG 密钥服务器连接缓慢

**解决**：按 Ctrl+C 终止，使用跳过参数重新运行：

```bash
archinstall --skip-ntp --skip-wkd
```

- `--skip-ntp`：跳过等待时间同步
- `--skip-wkd`：跳过 Web Key Directory 同步（最常见的卡点）

如果仍然卡住，可以加上 `--no-mirror-select` 并手动设置镜像源：

```bash
echo "Server = https://mirrors.ustc.edu.cn/archlinux/\$repo/os/\$arch" > /etc/pacman.d/mirrorlist
archinstall --skip-ntp --skip-wkd --no-mirror-select
```

有时稍等几分钟它会自己继续，但如果超过 10 分钟仍无反应，果断终止后用跳过参数重试

### 坑三：pacman 无法安装 archinstall

**现象**：`error: target not found: archinstall`

**原因**：pacman 数据库尚未同步（首次使用 Live 环境时需要手动下载数据库）

**解决**：

```bash
pacman -Sy      # 同步数据库
pacman -S archinstall
```

### 坑四：安装完成后重启没有图形登录界面

**现象**：重启后依然是命令行 `login:`

**原因**：安装时在"配置文件"步骤没有选择任何桌面环境，或者虽然选了但显示管理器未启用

**解决**：登录命令行后，手动安装并启用显示管理器（以 SDDM 为例）：

```bash
sudo pacman -S sddm
sudo systemctl enable sddm
sudo systemctl start sddm   # 立即启动
```

如果想安装桌面环境：

```bash
sudo pacman -S plasma      # KDE
sudo pacman -S gnome       # GNOME
```

## 安装后建议

- **更新系统**：`sudo pacman -Syu`
- **安装常用软件**：`sudo pacman -S vim firefox git base-devel`
- **启用时间同步**：`sudo systemctl enable --now systemd-timesyncd`
- **配置中文（如果需要）**：
  - 编辑 `/etc/locale.gen`，取消 `zh_CN.UTF-8` 注释，运行 `sudo locale-gen`
  - 安装中文字体：`sudo pacman -S wqy-microhei`
- **配置 AUR 助手（可选）**：安装 yay 或 paru 以便从 AUR 安装软件

## 总结

使用 archinstall 可以大幅降低 ArchLinux 的安装门槛，全程只需在交互界面中完成配置，大部分工作自动完成。不过，在虚拟机环境中可能会遇到网络子网冲突、密钥环同步卡顿等问题。掌握上述避坑技巧，你也能顺利在 20 分钟内拥有一个可用的 Arch 系统