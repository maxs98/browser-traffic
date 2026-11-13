# bilicli —— 命令行看 B 站，"看不见画面，但流量就是浏览器看视频"

在终端里听 B 站视频（不显示画面），同时让**运营商/网关设备看到的流量特征与浏览器观看视频一致**。

```
$ bilicli play BV1GJ411x7h7
  【官方 MV】Never Gonna Give You Up - Rick Astley
  UP: 索尼音乐中国 · 时长 03:33 · 音频 mp4a.40.2 203kbps · 视频 852x480 avc1.64001F 786kbps
  播放器 ffplay · 流经本地代理 127.0.0.1:12000 · 上游 Chrome 指纹 chrome
  流量模式 模拟浏览器拉流（视频轨按实时码率取流后丢弃）
  ████████████─────���──────  47.3%  00:01:41/03:33  音频 2.4 MB  视频 10.1 MB  12.5 MB @ 1.04 Mbps
```

---

## 一、为什么在运营商侧"看起来像浏览器看视频"

判断依据不是"你用了什么程序"，而是这条连接在网络里的可观测量。本工具逐项对齐：

| 观测维度 | 浏览器看视频 | 普通下载工具（curl/yt-dlp） | bilicli |
|---|---|---|---|
| TLS 指纹 (JA3/JA4) | Chrome 的 ClientHello | Python/OpenSSL 默认 | **Chrome 完全相同**（`t13d1516h2_...`） |
| HTTP/2 指纹 (Akamai) | Chrome 的 SETTINGS/窗口/伪头序 | 常为 HTTP/1.1 或不同参数 | **与 Chrome 一致**（`1:65536;2:0;4:6291456;...`） |
| User-Agent | 真实 Chrome UA | 常含 `python-requests`/`curl` | **真实 Chrome UA + 全套 sec-ch-ua** |
| 请求头顺序 | 浏览器固定顺序 | 库的默认顺序 | **按浏览器顺序**（curl_cffi impersonate 保证） |
| 目标域名/路径 | `*.bilivideo.com/upgcxcode/.../*.m4s` | 同（这层一样） | **同**（走 B 站正规 DASH 取流接口） |
| 取流方式 | Range 分片、MSE 逐段喂给解码器 | 单一整段 GET | **Range 分片 + 节流** |
| ���率曲线 | 起步突发填缓冲 → 稳态≈码率 | 起步即全速拉满 | **起步突发 → 稳态≈码率**（实测吻合） |
| 是否下视频 | 下（画面在本地解码） | 看你下不下 | **下**（默认下完即丢，不显示） |
| Cookie | buvid3/buvid4/b_nut 设备指纹 | 通常没有 | **有**（且跨次复用同一套，像同一台设备） |

也就是说：**同域名、同协议特征、同码率、同节奏、同字节构成**。区别只在"视频字节去哪了"——浏览器交给屏幕，bilicli 直接丢弃。

---

## 二、安装

需要 Python 3.8+ 和一个播放器。

```bash
# 1) 依赖
python3 -m pip install curl_cffi

# 2) 播放器（二选一；有 ffmpeg 就自带 ffplay）
brew install ffmpeg        # 或 brew install mpv
```

把仓库放到任意目录后，直接运行：

```bash
python3 bili.py doctor     # 自检：指纹 / 取流 / 分片 / 播放器
```

想当命令用（可选）：

```bash
chmod +x bili.py
sudo ln -sf "$PWD/bili.py" /usr/local/bin/bilicli
```

---

## 三、用法

### 播放（核心命令）

```bash
bilicli play BV1GJ411x7h7                      # 只听声音 + 模拟视频流量（默认）
bilicli play https://b23.tv/xxxxxx             # 短链直接贴
bilicli play BV1xx411c7mD -p 3                 # 第 3 个分P
bilicli play BV1xx411c7mD -ss 120              # 从 2:00 开始
bilicli play BV1xx411c7mD -r 1.5               # 1.5 倍速
bilicli play BV1xx411c7mD -vol 30              # 音量 30
bilicli play ep12345                           # 番剧/剧集
```

### 自动漫游（连播）

自动获取播放链接，播完一个自动接下一条，适合挂着当"背景播放 + 流量源"。

```bash
bilicli roam                                  # 从热门开始，一路漫游下去
bilicli roam BV1GJ411x7h7                     # 从该视频的相关推荐开始漫游
bilicli roam --source ranking -n 20           # 排行榜连播 20 个
bilicli roam BV1xx411c7mD --source multi      # 多P 连播
bilicli roam --source search --keyword 罗翔    # 按搜索词连播
bilicli roam --source up --mid 123456         # 某个 UP 主的投稿连播
```

常用开关：

| 选项 | 说明 |
|---|---|
| `-n, --count` | 播多少个后停（0=不限） |
| `--minutes` / `--hours` | 跑多久后停 |
| `--max-duration` / `--min-duration` | 跳过太长/太短的视频 |
| `--delay 1-4` | 视频之间停顿秒数区间 |
| `--shuffle` | 打乱顺序 |
| `--no-expand` | 不从相关推荐扩张，只用当前来源 |
| `--save-dir` | 配合 `-m realtime`，把每个视频存到指定目录 |

默认会从当前视频的相关推荐持续扩张，所以只要不设上限就会一直播下去；`Ctrl-C` 随时停止并打印整轮汇总。
播放失败的视频（失效、付费、无音轨）会自动跳过并继续下一条。

### 三种流量模式

| 模式 | 说明 | 流量特征 | 用途 |
|---|---|---|---|
| `-m stream`（默认） | 音频照常播放；视频轨按真实码率取流后**丢弃** | **与浏览器几乎一致** | 既要听，又要在网络侧看起来像在看视频 |
| `-m realtime` | 同上，但把视频**存下来**并合并成 mp4 | 与浏览器一致 | 顺便把视频留下 |
| `-m audio` | 只取音频 | 明显小于浏览器 | 省流量（隐蔽性略低） |

```bash
bilicli play BV1xx411c7mD -m realtime -r 3     # 3 倍速边听边存
# 结束后输出合并好的 output.mp4
```

### 清晰度

未登录时 B 站通常只给到 480P/360P，且**不会**下发更高清的视频轨——网络侧看到的就是 480P 的码率。
想更贴近"真人在看 1080P"，导入登录 Cookie：

```bash
bilicli login                                   # 自动从 Firefox/Chrome/Safari 读取
bilicli login --cookie 'SESSDATA=xxx; bili_jct=yyy'   # 或手动指定
```

导入后 `-q 1080p` 即可（1080P 视频轨码率约 2~4 Mbps，速率曲线更像真人看视频）。

```bash
bilicli play BV1xx411c7mD -q 1080p
bilicli play BV1xx411c7mD --max-height 720      # 用码率换"看起来更自然"
bilicli play BV1xx411c7mD --codec avc           # 默认 h264，最像网页默认行为
```

### 其它

```bash
bilicli search 罗翔 -n 10      # 搜索
bilicli info BV1xx411c7mD      # 视频信息 + 分P 列表
bilicli doctor                 # 自检
```

播放中按 `Ctrl-C` 退出；结束时打印本次流量统计（音频轨/视频轨的字节数、请求次数、平均码率）。

---

## 四、实现要点

```
┌─────────────┐   http://127.0.0.1:12000/audio.m4s    ┌──────────────┐
│  ffplay     │ ────────────────────────────────────▶ │  本地流代理   │
│ (只解码音频) │ ◀──── Range 转发、字节原样透传 ────── │  StreamProxy │
└─────────────┘                                        └──────┬───────┘
                                                              │ curl_cffi
   ┌───────���────��─────────────────────────────────────────────┘
   │  Chrome TLS / JA4 / HTTP2 / 头序
   ▼
┌────────────────────┐   ① /x/web-interface/view      ┌──────────────┐
│ api.bilibili.com   │ ◀──────────────────────────── │  bilicli     │
│  (wbi 签名接口)     │ ── ② /x/player/wbi/playurl ──▶ │              │
└────────────────────┘                                │              │
┌────────────────────┐   ③ Range 分片取流 (.m4s)      │              │
│ *.bilivideo.com    │ ◀──────────────────────────── │              │
│  (CDN, HTTP/2)     │ ── ④ 音频→ffplay 视频→丢弃 ──▶ │              │
└────────────────────┘                                └─────────���────┘
```

1. **指纹层**：全部上游流量由 `curl_cffi` 发起（`impersonate="chrome"`），TLS/JA4/HTTP2/Akamai/头序/UA 都与真实 Chrome 相同。播放器本身**从不直连 CDN**，只连 `127.0.0.1`。
2. **签名层**：`wbi` 签名（`w_rid` = md5(排序后的查询串 + mixin key)）用于取流接口，并维护 `buvid3/buvid4/b_nut` 设备 Cookie。
3. **取流层**：走 B 站官方 DASH 链路，取 Range 分片 `.m4s`。
4. **流量塑形**：视频轨在后台线程按**该轨真实码率**取流——起步突发填满约 4~12 秒缓冲，之后随播放进度涓流补充；分片大小 256~512 KB，贴近 MSE 播放器的分段请求。
5. **音频播放**：`ffplay -nodisp -autoexit` 通过本地代理读音频轨，因此 Seek（拖动进度）也能正确转发 Range。
6. **单次下载**：`-m realtime` 时在代理层把同一份字节旁路写入磁盘，不重复请求。

---

## 五、自检输出示例

```
$ bilicli doctor
  ✓ TLS 指纹 JA4 : t13d1516h2_8daaf6152771_d8a2da3f94cd
      Akamai HTTP2 : 1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
      User-Agent   : Mozilla/5.0 ... Chrome/136.0.0.0 Safari/537.36
  ✓ 设备 Cookie  : buvid3, buvid4
  ✓ 取流链路     : DASH 音频 3 条 / 视频 6 条，当前 480P 标清
  ✓ CDN 分片取流 : HTTP 206 h2 1024B  bytes 0-1023/5408198
  ✓ 本地播放器   : /opt/homebrew/bin/ffplay
  ! 登录态       : 未登录（通常上限 480P/360P）

  全部通过：流量在运营商侧与浏览器观看 B 站视频一致。
```

---

## 六、边界与说明

- **不显示画面**是这个工具的用法本身，不是伪装手段：视频字节确实取了、也按真实码率取了，只是不送去渲染。
- **不做协议层面的欺骗**：没有改包、没有伪造 TCP/TLS 特征到违规程度，用的是 B 站官方公开接口 + 一个真实存在的浏览器客户端的正常行为。上游（B 站/CDN）看到的是**合规的客户端请求**。
- **登录 Cookie 属于你的隐私**：保存在 `~/.config/bilicli/cookies.json`（权限 600）。`bilicli login` 只需 `SESSDATA` 等必要字段，脚本不会外传。
- **付费/地区限制内容**（部分番剧、大会员专享）即使导入 Cookie 也可能取不到流。
- 未登录时清晰度上限较低（��常是 480P/360P），此时网络侧的码率会低于"真人在看 1080P"——如需完全贴合，导入 Cookie 并指定 1080P。
- 请遵守 B 站用户协议与所在地法律法规，仅将本项目用于个人学习与合理的个人观看场景。
