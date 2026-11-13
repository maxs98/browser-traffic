# browser-traffic

在命令行里产生"看起来就是浏览器在用"的国内网络流量。两个工具，一个目标：让运营商/网关侧看到的
连接特征与真人使用浏览器一致，而不是脚本或下载器的特征。

| 工具 | 作用 | 技术栈 |
|---|---|---|
| [cnbrowse](cnbrowse/README.md) | 用真实 Chrome 内核随机浏览国内网站，产生整页浏览流量 | Node 18+ / CDP，零依赖 |
| [bilicli](bilicli/README.md) | 命令行看 B 站（不出画面），流量与浏览器看视频一致 | Python 3.8+ / curl_cffi |

## 快速开始

```bash
# 随机浏览国内网站，累计到 1GB 流量后停止
./cnbrowse/cnbrowse --target-traffic 1GB

# 只逛图片/媒体密集的高流量站点，跑 1 小时
./cnbrowse/cnbrowse --heavy -t 3600 --max-rate 20

# 命令行看 B 站，只听声音，后台按真实码率拉视频轨
./bilicli/bilicli play BV1GJ411x7h7
```

## 安装依赖

```bash
# cnbrowse：只需 Node 18+，无需 npm install
node -v

# bilicli：需要 curl_cffi 和 ffmpeg（含 ffplay）
python3 -m pip install curl_cffi
brew install ffmpeg
```

两个工具共用同一套思路：**真实客户端特征 + 与视角一致的流量节奏**。它们都不改写数据包，
只是用真实的浏览器/播放器行为去访问公开内容。

## 目录结构

```
browser-traffic/
├── cnbrowse/            # 真实浏览器随机浏览
│   ├── cnbrowse         # 启动脚本
│   ├── cnbrowse.mjs     # 主程序（CDP 驱动 Chrome）
│   └── README.md
└── bilicli/             # 命令行 B 站（音频 + 浏览器式视频流量）
    ├── bilicli          # 启动脚本
    ├── bili.py          # 主程序
    ├── requirements.txt
    └── README.md
```

## 注意

- 浏览器 profile 与登录 Cookie 存在 `~/.config/` 下（`cnbrowse/`、`bilicli/`），不在本仓库内。
- 建议配合 `--max-rate` 限制平均速率，避免长时间跑满带宽。
- 只访问公开页面，不绕过登录或付费墙，请遵守各站点用户协议与所在地法规。
