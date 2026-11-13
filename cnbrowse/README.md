# cnbrowse —— 用真实浏览器随机浏览国内网站，产生"就是人在上网"的流量

在后台用**真实的 Chrome 内核**随机逛国内各类网站：加载完整页面、拉取全部图片/CSS/JS/接口请求、
滚动触发懒加载、点进文章详情页、偶尔开新标签。流量特征与真人用浏览器上网一致。

```
$ ./cnbrowse --heavy --target-traffic 1GB
  cnbrowse · 真实浏览器随机浏览
  站点池 133 个  [仅高流量站]  并发标签页 1  停留 3-20s  每站深入 1 层  目标 1.00 GB
  浏览器 HeadlessChrome/147.0.7727.15
  统计口径：网络层实际收发字节（与运营商侧一致）

  ▶ 太平洋电脑网   www.pconline.com.cn/            22.66 MB 23.76 Mbps  太平洋电脑网_专业IT门户
  累计  22.66 MB  页面    1  用时 0:24   7.73 Mbps
     └ 详情    notebook.pconline.com.cn            5.12 MB  ...
  ▶ 央视网        www.cctv.com/                   13.02 MB   ...
  · 累计  182.7 MB / 1.00 GB (18.3%)  页面 38  请求 6165  10:46   2.37 Mbps
```

---

## 一、为什么这比"用脚本发请求"更像真人

| 观测维度 | curl/requests 脚本 | **cnbrowse（真实浏览器）** |
|---|---|---|
| TLS 指纹 (JA3/JA4) | 需额外伪装 | **原生 Chrome 指纹**（就是 Chrome 自己发的） |
| 页面子资源 | **不加载**（只下一个 HTML） | **全部加载**：图片/CSS/JS/字体/接口 |
| 单页请求数 | 1 | **50 ~ 900+**（实测网易首页 630 个请求） |
| 流量构成 | 只有文档 | **图片 70~87%、脚本 8~23%**（与真人一致） |
| 懒加载 / 无限滚动 | 无 | **滚动触发**，边看边加载 |
| 第三方统计/广告 | 无 | **有**（百度统计、广告位真实发起） |
| Cookie / 缓存 | 无 | **持久化 profile**，跨次访问像常用浏览器 |
| 访问节奏 | 固定频率，机械 | **随机停留、随机跳转、偶开新标签** |

实测对比（同一个网易首页）：
- 纯 HTTP 客���端：**265 KB / 1 个请求**
- cnbrowse 真实浏览器：**2.9 MB / 630 个请求**（图片、JS、广告位全都在）

差距就在这些子资源上——**这正是运营商侧判断"是不是浏览器"的关键**。

---

## 二、安装

只需 **Node 18+** 和一个 Chrome/Chromium 内核。**无需 npm install**（直接用 Node 内置 WebSocket 讲 CDP 协议）。

```bash
node -v        # 需要 >= 18
```

内核来源（自动检测，按优先级）：
1. Playwright 缓存的 Chrome for Testing / headless-shell（`~/Library/Caches/ms-playwright`）
2. 系统安装的 Google Chrome / Chromium / Edge / Brave

如果都没有，装一个即可:

```bash
brew install --cask google-chrome
# 或
npx playwright install chromium
```

自检：`./cnbrowse --list-sites` 能列出站点池就说明可用。

---

## 三、用法

### 最常用

```bash
./cnbrowse                                   # 随机浏览（Ctrl-C 停止）
./cnbrowse --target-traffic 1GB              # 累计到 1GB 流量后停止
./cnbrowse -t 3600                           # 跑 1 小时
./cnbrowse -n 300                            # 逛满 300 个页面
./cnbrowse --heavy                           # 只逛图片/媒体多的"高流量"站（流量效率最高）
```

### 挑选站点

```bash
./cnbrowse --list-sites                      # 查看全部站点（含分类和高流量标记）
./cnbrowse --list-categories                 # 查看分类
./cnbrowse -c news,tech,auto                 # 只逛新闻/科技/汽车
./cnbrowse --sites 京东,淘宝,知乎             # 指定站点（中文名、域名、分类都可以）
./cnbrowse --exclude 淘宝,京东                # 排除某些站
./cnbrowse --heavy -c shop                   # 组合：只逛购物类的高流量站
```

### 行为调节（让节奏更像某个具体的人）

| 选项 | 默认 | 说明 |
|---|---|---|
| `--depth <n>` | 1 | 每站深入详情页的层数。`2`= 首页→文章→回首页→再一篇文章 |
| `--dwell <a-b>` | 3-20 | 每页停留秒数区间。**调大更像"在认真看"** |
| `--concurrency <n>` | 1 | 并行标签页数。`1` 最像单人；`3~5` 流量更高但仍属真人范围 |
| `--max-rate <Mbps>` | 不限 | 限制平均速率上限，避免持续跑满带宽（**推荐设置**） |
| `--video-seconds <a-b>` | 8-25 | 每页视频播放时长区间 |
| `--no-video` | 关 | 关闭自动播放页面视频 |
| `--screenshot <目录>` | 关 | 视频起播 2 秒后自动截图，用来确认画面真的在动 |
| `--url <网址>` | 关 | 直接指定页面浏览（可多次），用于测试具体播放页 |
| `--video-roam` | 关 | 随机漫游：跳到哪算哪，页面上有视频就播一会儿，再跳下一个 |
| `--headed` | 关 | 显示浏览器窗口（默认无头运行） |
| `--audio` | 关 | 允许播放声音（默认静音） |

```bash
# 像一个在认真看新闻的人：慢节奏、每站多翻几篇
./cnbrowse -c news --dwell 15-60 --depth 3 --max-rate 5

# 像一边刷图一边逛：多一点并发、只去图站
./cnbrowse -c photo,shop --heavy --concurrency 4 --max-rate 20
```

### 页面里有视频，自动播

逛到带视频的页面时，工具会自动找到页面里的 `<video>`（包括同源 iframe 内的播放器），
静音播放一段时间后再继续逛下一站。播放走的是页面自己的播放器（原生 video / hls.js / dash.js /
直播 WebSocket），所以媒体流量与真人观看完全一致，也**不限于任何特定站点**。

```bash
./cnbrowse -c video --video-seconds 15-40      # 只逛视频站，每页看 15~40 秒
./cnbrowse --no-video                          # 只要图文流量

# 直接测某个播放页，并截图确认画面
./cnbrowse --url https://www.bilibili.com/video/BV1GJ411x7h7 \
  --headed --video-seconds 20-30 --screenshot /tmp/shots
```

### 随机漫游（视频优先）

`--video-roam` 是在一个站点里"乱点"：每页播一会儿（有视频就播），然后从页面里随机挑一个链接跳过去，
不区分是视频页还是文章页，真人怎么点它就怎么点。同一个视频不会立刻重复。

```bash
# 从 B 站某个视频开始，一个接一个地往下看
./cnbrowse --url https://www.bilibili.com/video/BV1GJ411x7h7 \
  --video-roam --video-seconds 10-25 --headed

# 从站点池里随机开始
./cnbrowse --video-roam -c video
```

输出长这样：

```
  ▶ [1] www.bilibili.com      10.54 MB  【官方 MV】Never Gonna Give You Up - Rick Astley
      ▶ 已播放 3s（页面时长 213s）拉流 240 KB
      → 下一个 https://www.bilibili.com/video/BV1Sb41177Je/
  ▶ [2] www.bilibili.com       1.77 MB  外国黑胖子跳舞原版素材
      （本页没检测到可播放视频）
```

实测：爱奇艺首页播 7 秒、斗鱼直播播 10 秒都能正常起播并产生媒体流量；
汇总里会出现「含视频页」以及每页的「播放期间拉流」字节数。

> 说明：不少站点首页的 `<video>` 是**隐藏的预加载/悬停预览**，页面上根本没有可见播放器，
> 这时会打印 `⚠ 播放器不在视口内`。想看真实播放效果，请用 `--url` 指向具体的播放页，
> 或配合 `--depth 1` 进入详情页。直播站若走 WebSocket 传流，字节数按 WebSocket 帧计入。

### 其它

```bash
./cnbrowse --stats-file ~/traffic.json       # 实时把统计写入 JSON（可外部读取）
./cnbrowse --profile ~/my-profile            # 用独立 profile（Cookie/缓存独立）
./cnbrowse -q                                # 安静模式，只输出最终汇总
./cnbrowse --chrome /path/to/chrome          # 手动指定内核
```

---

## 四、实现说明

```
cnbrowse (Node)
   │  ① 启动 Chrome，开调试端口，用 Node 内置 WebSocket 讲 CDP
   ├──────────────▶ Chrome (headless-shell / Chrome for Testing)
   │                     │
   │  ② 每个页面：         │  ③ 真实渲染 → 浏览器自己发起全部子资源请求
   │  Page.navigate ─────▶│     · 图片 / CSS / JS / 字体
   │  Input.dispatchMouseEvent (滚轮)  → 触发懒加载
   │  Runtime.evaluate  (点击"加载更多"、关弹窗) → 触发更多接口
   │  ④ Network.* 事件  ◀─┘  精确统计每个请求的字节（= 运营商侧看到的量）
   ▼
 统计与限速
```

关键点：

1. **流量就是浏览器产生的**：所有请求都由 Chrome 自己发起，没有中间人改写。
   TLS/JA4/HTTP2/头部顺序天然就是 Chrome 的，无需任何伪装。
2. **持久化 profile**：`~/.config/cnbrowse/browser-profile`。Cookie、localStorage、
   HTTP 缓存、已访问记录都会累积——第二次访问同一站点会走缓存，这**正是真实用户的特征**
   （缓存命中率高，而不是每次都全量下载）。
3. **反重复保护**：同一域名 6 分钟内不重复访问；近期访问过的站点会降低选中概率。
4. **风控兜底**：自动处理 JS 弹窗（`Page.handleJavaScriptDialog`）；对已知风控站
   （搜狐/NGA/起点等）使用真实浏览器直接访问，比脚本更容易通过。
5. **统计口径**：用 `Network.loadingFinished` 的 `encodedDataLength`，即网线上真实收发的字节
   （含响应头），与运营商侧计量一致。
6. **profile 独占锁**：避免两个实例共用同一 profile 导致页面静默失败。
7. **超时保护**：所有 CDP 调用都有超时；`Runtime.evaluate` 失败不会卡死整个流程。

---

## 五、站点池（133 个，13 类）

| 分类 | 数量 | 代表站点 |
|---|---|---|
| `portal` 综合门户 | 8 | 新浪、网易、腾讯、搜狐、凤凰网、百度 |
| `news` 新闻资讯 | 16 | 澎湃、人民网、新华网、央视网、观察者、界面 |
| `tech` 科技数码 | 21 | 中关村在线、IT之家、驱动之家、CSDN、少数派、36氪 |
| `auto` 汽车 | 8 | 汽车之家、易车、懂车帝、太平洋汽车、论坛 |
| `finance` 财经 | 7 | 东方财富、雪球、同花顺、证券时报、和讯 |
| `video` 视频娱乐 | 13 | B站、爱奇艺、优酷、腾讯视频、斗鱼、豆瓣电影 |
| `photo` 图片设计 | 12 | 花瓣、站酷、图虫、昵图、千图、视觉中国 |
| `shop` 购物 | 9 | 京东、淘宝、天猫、苏宁、唯品会、什么值得买 |
| `life` 生活服务 | 20 | 携程、去哪儿、大众点评、链家、土巴兔、穷游 |
| `sport` 体育 | 4 | 虎扑、懂球帝、新浪体育、腾讯体育 |
| `game` 游戏 | 5 | 游民星空、3DM、游侠网、178游戏 |
| `read` 阅读 | 5 | 起点、晋江、纵横、简书、孔夫子 |
| `gov` 政务机构 | 5 | 中国政府网、税务总局、教育部、中科院 |

其中 60+ 个标记为 `高流量`（图片/���体/商品图多，单位时间流量产出最高）。

---

## 六、实测数据

| 场景 | 时长 | 流量 | 页面 | 请求数 | 平均速率 |
|---|---|---|---|---|---|
| `--heavy` 单标签 | 3 分钟 | **144 MB** | ~10 | 14,402 | 6.6 Mbps |
| `--heavy --depth 1` | 10.8 分钟 | **183 MB** | 38 | 6,165 | 2.4 Mbps |
| 默认（混合站点） | 2 分钟 | 19 MB | 10 | 2,478 | 1.3 Mbps |

资源构成稳定在：**图片 70~87%、脚本 8~23%、文档 1~9%** —— 与真人浏览网页完全一致。

粗算：`--heavy` 模式下约 **1.3~2 GB / 小时**；加 `--concurrency 3` 可到 4~6 GB / 小时。

---

## 七、注意事项

- **尊重站点**：默认已限并发 `1`、随机停留、同域 6 分钟内不重复。建议配合 `--max-rate`
  避免长时间跑满带宽。请遵守各网站的用户协议与 robots 约定。
- **不做规避**：本工具不绕过登录、付费墙或访问控制，只访问公开页面。个别站点（如搜狐、
  NGA）有反爬策略，可能返回 403，属于正常现象，工具会自动跳过。
- **Cookie 与隐私**：profile 目录保存浏览产生的 Cookie，仅在本机使用，不会外传。
  不想保留就 `--profile /tmp/xxx` 或删掉该目录。
- **无头模式差异**：默认使用 `chrome-headless-shell`（自动化专用，最稳定）。
  个别站点对无头环境有额外校验，可用 `--headed` 换成完整 Chrome 窗口。
- 请遵守所在地法律法规，仅用于个人合理的网络使用场景。
