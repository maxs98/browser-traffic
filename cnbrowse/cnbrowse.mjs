#!/usr/bin/env node
/**
 * cnbrowse —— 用真实浏览器随机浏览国内网站，产生与真人上网一致的流量。
 *
 * 设计目标：流量特征 = 真人用 Chrome 上网
 *   * 用真实 Chrome 内核（Chrome for Testing / 系统 Chrome）渲染页面，
 *     因此页面里的图片/CSS/JS/字体/接口请求都会被真实发起。
 *   * 持久化 profile：Cookie、localStorage、DNS/HTTP 缓存像常用浏览器一样累积。
 *   * 随机行为：逛首页 -> 滚动懒加载 -> 进详情页 -> 停留 -> 换站，
 *     节奏带随机性，不是固定频率的机械抓取。
 *   * 全部流量走 127.0.0.1 的调试端口，浏览器引擎本身对外发起的就是正常 HTTPS。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ────────────────────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const C = {
  on: process.stdout.isTTY,
  w: (s, c) => (C.on ? `\x1b[${c}m${s}\x1b[0m` : s),
  dim: (s) => C.w(s, 2), bold: (s) => C.w(s, 1), green: (s) => C.w(s, 32),
  yellow: (s) => C.w(s, 33), red: (s) => C.w(s, 31), cyan: (s) => C.w(s, 36),
};
const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? Math.round(n) : n.toFixed(i === 1 ? 0 : 2)} ${u[i]}`;
};
/** 解析 "500MB" / "2GB" / "800" 为字节数 */
const parseSize = (t) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?\s*$/i.exec(String(t));
  if (!m) throw new Error(`无法解析容量: ${t}`);
  const mul = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mul);
};
const fmtDur = (s) => {
  s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const fmtRate = (bps) => (bps > 1e6 ? `${(bps / 1e6).toFixed(2)} Mbps` : `${(bps / 1e3).toFixed(0)} kbps`);

// ────────────────────────────────────────────────────────────────────────────
// 站点池：国内各领域站点（heavy = 图片/媒体多，流量大）
// ────────────────────────────────────────────────────────────────────────────
const SITES = [
  // 综合门户（子资源极多）
  { n: '新浪', u: 'https://www.sina.com.cn/', c: 'portal', heavy: true },
  { n: '网易', u: 'https://www.163.com/', c: 'portal', heavy: true },
  { n: '腾讯网', u: 'https://www.qq.com/', c: 'portal', heavy: true },
  { n: '搜狐', u: 'https://www.sohu.com/', c: 'portal', heavy: true, risk: true },
  { n: '凤凰网', u: 'https://www.ifeng.com/', c: 'portal', heavy: true },
  { n: '中华网', u: 'https://www.china.com/', c: 'portal' },
  { n: '环球网', u: 'https://www.huanqiu.com/', c: 'portal', heavy: true },
  { n: '百度', u: 'https://www.baidu.com/', c: 'portal' },
  // 新闻资讯
  { n: '澎湃新闻', u: 'https://www.thepaper.cn/', c: 'news' },
  { n: '人民网', u: 'http://www.people.com.cn/', c: 'news', heavy: true },
  { n: '新华网', u: 'http://www.xinhuanet.com/', c: 'news', heavy: true },
  { n: '央视网', u: 'https://www.cctv.com/', c: 'news', heavy: true },
  { n: '中新网', u: 'https://www.chinanews.com.cn/', c: 'news', heavy: true },
  { n: '光明网', u: 'https://www.gmw.cn/', c: 'news', heavy: true },
  { n: '中国日报', u: 'https://www.chinadaily.com.cn/', c: 'news', heavy: true },
  { n: '观察者网', u: 'https://www.guancha.cn/', c: 'news', heavy: true },
  { n: '第一财经', u: 'https://www.yicai.com/', c: 'news', heavy: true },
  { n: '界面新闻', u: 'https://www.jiemian.com/', c: 'news' },
  { n: '财新网', u: 'https://www.caixin.com/', c: 'news' },
  { n: '参考消息', u: 'http://www.cankaoxiaoxi.com/', c: 'news' },
  { n: '中国青年网', u: 'https://www.youth.cn/', c: 'news', heavy: true },
  { n: '北青网', u: 'https://www.ynet.com/', c: 'news', heavy: true },
  { n: '南方网', u: 'https://www.southcn.com/', c: 'news' },
  { n: '中国网', u: 'http://www.china.com.cn/', c: 'news', heavy: true },
  // 科技数码（图片多）
  { n: '中关村在线', u: 'https://www.zol.com.cn/', c: 'tech', heavy: true },
  { n: '太平洋电脑网', u: 'https://www.pconline.com.cn/', c: 'tech', heavy: true },
  { n: 'IT之家', u: 'https://www.ithome.com/', c: 'tech', heavy: true },
  { n: '驱动之家', u: 'https://www.mydrivers.com/', c: 'tech', heavy: true },
  { n: '快科技', u: 'https://news.mydrivers.com/', c: 'tech', heavy: true },
  { n: 'CnBeta', u: 'https://www.cnbeta.com.tw/', c: 'tech' },
  { n: '雷锋网', u: 'https://www.leiphone.com/', c: 'tech' },
  { n: '品玩', u: 'https://www.pingwest.com/', c: 'tech' },
  { n: 'CSDN', u: 'https://www.csdn.net/', c: 'tech', heavy: true },
  { n: '博客园', u: 'https://www.cnblogs.com/', c: 'tech' },
  { n: '掘金', u: 'https://juejin.cn/', c: 'tech' },
  { n: '开源中国', u: 'https://www.oschina.net/', c: 'tech' },
  { n: '51CTO', u: 'https://www.51cto.com/', c: 'tech' },
  { n: 'InfoQ中文', u: 'https://www.infoq.cn/', c: 'tech' },
  { n: '少数派', u: 'https://sspai.com/', c: 'tech', heavy: true },
  { n: '爱范儿', u: 'https://www.ifanr.com/', c: 'tech', heavy: true },
  { n: '36氪', u: 'https://36kr.com/', c: 'tech' },
  { n: '虎嗅', u: 'https://www.huxiu.com/', c: 'tech', heavy: true },
  { n: '钛媒体', u: 'https://www.tmtpost.com/', c: 'tech' },
  { n: '果壳', u: 'https://www.guokr.com/', c: 'tech' },
  { n: '知乎', u: 'https://www.zhihu.com/', c: 'tech' },
  // 汽车（图集极多，流量大）
  { n: '汽车之家', u: 'https://www.autohome.com.cn/', c: 'auto', heavy: true },
  { n: '易车', u: 'https://www.yiche.com/', c: 'auto', heavy: true },
  { n: '太平洋汽车', u: 'https://www.pcauto.com.cn/', c: 'auto', heavy: true },
  { n: '懂车帝', u: 'https://www.dongchedi.com/', c: 'auto', heavy: true },
  { n: '爱卡汽车', u: 'https://www.xcar.com.cn/', c: 'auto', heavy: true },
  // 财经
  { n: '东方财富', u: 'https://www.eastmoney.com/', c: 'finance', heavy: true },
  { n: '新浪财经', u: 'https://finance.sina.com.cn/', c: 'finance', heavy: true },
  { n: '雪球', u: 'https://xueqiu.com/', c: 'finance' },
  { n: '同花顺', u: 'https://www.10jqka.com.cn/', c: 'finance' },
  { n: '证券时报', u: 'https://www.stcn.com/', c: 'finance' },
  { n: '和讯网', u: 'https://www.hexun.com/', c: 'finance' },
  { n: '金融界', u: 'https://www.jrj.com.cn/', c: 'finance' },
  // 视频/娱乐（媒体流量最大）
  { n: '哔哩哔哩', u: 'https://www.bilibili.com/', c: 'video', heavy: true },
  { n: '优酷', u: 'https://www.youku.com/', c: 'video', heavy: true },
  { n: '爱奇艺', u: 'https://www.iqiyi.com/', c: 'video', heavy: true },
  { n: '腾讯视频', u: 'https://v.qq.com/', c: 'video', heavy: true },
  { n: '芒果TV', u: 'https://www.mgtv.com/', c: 'video', heavy: true },
  { n: '西瓜视频', u: 'https://www.ixigua.com/', c: 'video', heavy: true },
  { n: '斗鱼', u: 'https://www.douyu.com/', c: 'video', heavy: true },
  { n: '虎牙', u: 'https://www.huya.com/', c: 'video', heavy: true },
  { n: '网易云音乐', u: 'https://music.163.com/', c: 'video', heavy: true },
  { n: 'QQ音乐', u: 'https://y.qq.com/', c: 'video', heavy: true },
  // 图片/视觉（高流量）
  { n: '花瓣网', u: 'https://huaban.com/', c: 'photo', heavy: true },
  { n: '站酷', u: 'https://www.zcool.com.cn/', c: 'photo', heavy: true },
  { n: '摄影部落', u: 'https://dp.pconline.com.cn/', c: 'photo', heavy: true },
  { n: '图虫', u: 'https://tuchong.com/', c: 'photo', heavy: true },
  { n: '500px中文', u: 'https://500px.com.cn/', c: 'photo', heavy: true },
  // 购物（图片海量）
  { n: '京东', u: 'https://www.jd.com/', c: 'shop', heavy: true },
  { n: '淘宝', u: 'https://www.taobao.com/', c: 'shop', heavy: true },
  { n: '天猫', u: 'https://www.tmall.com/', c: 'shop', heavy: true },
  { n: '苏宁', u: 'https://www.suning.com/', c: 'shop', heavy: true },
  { n: '国美', u: 'https://www.gome.com.cn/', c: 'shop', heavy: true },
  { n: '当当', u: 'http://www.dangdang.com/', c: 'shop', heavy: true },
  { n: '唯品会', u: 'https://www.vip.com/', c: 'shop', heavy: true },
  { n: '什么值得买', u: 'https://www.smzdm.com/', c: 'shop', heavy: true },
  { n: '小红书', u: 'https://www.xiaohongshu.com/', c: 'shop', heavy: true },
  // 生活服务
  { n: '携程', u: 'https://www.ctrip.com/', c: 'life', heavy: true },
  { n: '去哪儿', u: 'https://www.qunar.com/', c: 'life', heavy: true },
  { n: '飞猪', u: 'https://www.fliggy.com/', c: 'life', heavy: true },
  { n: '马蜂窝', u: 'https://www.mafengwo.cn/', c: 'life', heavy: true, risk: true },
  { n: '中国天气', u: 'http://www.weather.com.cn/', c: 'life' },
  { n: '豆瓣', u: 'https://www.douban.com/', c: 'life', heavy: true },
  { n: '大众点评', u: 'https://www.dianping.com/', c: 'life', heavy: true },
  { n: '美团', u: 'https://www.meituan.com/', c: 'life' },
  { n: '饿了么', u: 'https://www.ele.me/', c: 'life' },
  { n: '58同城', u: 'https://www.58.com/', c: 'life' },
  { n: '链家', u: 'https://www.lianjia.com/', c: 'life', heavy: true },
  { n: '安居客', u: 'https://www.anjuke.com/', c: 'life', heavy: true },
  // 体育/游戏/娱乐
  { n: '虎扑', u: 'https://www.hupu.com/', c: 'sport', heavy: true },
  { n: '懂球帝', u: 'https://www.dongqiudi.com/', c: 'sport', heavy: true },
  { n: '新浪体育', u: 'https://sports.sina.com.cn/', c: 'sport', heavy: true },
  { n: '腾讯体育', u: 'https://sports.qq.com/', c: 'sport', heavy: true },
  { n: '游民星空', u: 'https://www.gamersky.com/', c: 'game', heavy: true },
  { n: '3DM', u: 'https://www.3dmgame.com/', c: 'game', heavy: true },
  { n: '游侠网', u: 'https://www.ali213.net/', c: 'game', heavy: true },
  { n: 'NGA', u: 'https://bbs.nga.cn/', c: 'game', risk: true },
  { n: '178游戏', u: 'https://www.178.com/', c: 'game', heavy: true },
  // 阅读/文化
  { n: '起点中文网', u: 'https://www.qidian.com/', c: 'read', heavy: true, risk: true },
  { n: '晋江文学城', u: 'https://www.jjwxc.net/', c: 'read', heavy: true },
  { n: '纵横中文网', u: 'https://www.zongheng.com/', c: 'read', heavy: true },
  { n: '简书', u: 'https://www.jianshu.com/', c: 'read' },
  { n: '孔夫子旧书网', u: 'https://www.kongfz.com/', c: 'read', heavy: true },
  // 图片/素材/设计（流量大且稳定）
  { n: '昵图网', u: 'https://www.nipic.com/', c: 'photo', heavy: true },
  { n: '千图网', u: 'https://www.58pic.com/', c: 'photo', heavy: true },
  { n: '包图网', u: 'https://ibaotu.com/', c: 'photo', heavy: true },
  { n: '摄图网', u: 'https://699pic.com/', c: 'photo', heavy: true },
  { n: '视觉中国', u: 'https://www.vcg.com/', c: 'photo', heavy: true },
  { n: '致设计', u: 'https://www.zhisheji.com/', c: 'photo', heavy: true },
  { n: 'UI中国', u: 'https://www.ui.cn/', c: 'photo', heavy: true },
  // 旅行/户外（图集多）
  { n: '穷游网', u: 'https://www.qyer.com/', c: 'life', heavy: true },
  { n: '携程攻略', u: 'https://you.ctrip.com/', c: 'life', heavy: true },
  { n: '绿野户外', u: 'https://www.lvye.cn/', c: 'life', heavy: true },
  // 影视/剧集（海报图多）
  { n: '猫眼电影', u: 'https://www.maoyan.com/', c: 'video', heavy: true },
  { n: '豆瓣电影', u: 'https://movie.douban.com/', c: 'video', heavy: true },
  { n: '时光网', u: 'https://www.mtime.com/', c: 'video', heavy: true },
  // 汽车社区（图集极多）
  { n: '汽车之家论坛', u: 'https://club.autohome.com.cn/', c: 'auto', heavy: true },
  { n: '易车社区', u: 'https://bbs.yiche.com/', c: 'auto', heavy: true },
  { n: '太平洋汽车论坛', u: 'https://bbs.pcauto.com.cn/', c: 'auto', heavy: true },
  // 家居/装修（效果图多）
  { n: '土巴兔', u: 'https://www.to8to.com/', c: 'life', heavy: true },
  { n: '齐家网', u: 'https://www.jia.com/', c: 'life', heavy: true },
  // 母婴/女性
  { n: '妈妈网', u: 'https://www.mama.cn/', c: 'life', heavy: true },
  { n: '瑞丽网', u: 'https://www.rayli.com.cn/', c: 'life', heavy: true },
  { n: '太平洋时尚网', u: 'https://www.pclady.com.cn/', c: 'life', heavy: true },
  // 政务/机构
  { n: '中国政府网', u: 'https://www.gov.cn/', c: 'gov', heavy: true },
  { n: '国家税务总局', u: 'https://www.chinatax.gov.cn/', c: 'gov' },
  { n: '教育部', u: 'http://www.moe.gov.cn/', c: 'gov' },
  { n: '中国科学院', u: 'https://www.cas.cn/', c: 'gov', heavy: true },
  { n: '国家统计局', u: 'https://www.stats.gov.cn/', c: 'gov' },
];

const CATEGORIES = [...new Set(SITES.map((s) => s.c))];

// ────────────────────────────────────────────────────────────────────────────
// CDP 客户端
// ────────────────────────────────────────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();     // method -> Set(fn)
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', (e) => rej(new Error(`CDP 连接失败: ${e.message || e.type}`)), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.rej(new Error(`${p.method}: ${m.error.message || JSON.stringify(m.error)}`)) : p.res(m.result);
        return;
      }
      if (m.method) {
        const hs = this.handlers.get(m.method);
        if (hs) for (const h of [...hs]) { try { h(m.params, m.sessionId); } catch {} }
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }
  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} 超时`)); } }, 90000);
      this.pending.set(id, {
        method,
        res: (v) => { clearTimeout(t); res(v); },
        rej: (e) => { clearTimeout(t); rej(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// ────────────────────────────────────────────────────────────────────────────
// Chrome 进程管理
// ────────────────────────────────────────────────────────────────────────────
const HL = [
  'chrome-mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'chrome-mac-x64/chrome-headless-shell-mac-x64/chrome-headless-shell',
  'chrome-headless-shell-mac-x64/chrome-headless-shell',
];
const FULL = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
];
/** 从 Playwright 缓存里找内核；headless 优先 headless-shell（自动化专用，最稳） */
function findInPlaywrightCache(preferHeadless) {
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(base)) return null;
  let entries = [];
  try { entries = readdirSync(base); } catch { return null; }
  const hDirs = entries.filter((e) => e.startsWith('chromium_headless_shell-')).map((e) => join(base, e)).sort().reverse();
  const fDirs = entries.filter((e) => e.startsWith('chromium-')).map((e) => join(base, e)).sort().reverse();
  const order = preferHeadless ? [...hDirs.flatMap((d) => HL.map((s) => join(d, s))), ...fDirs.flatMap((d) => FULL.map((s) => join(d, s)))]
                              : [...fDirs.flatMap((d) => FULL.map((s) => join(d, s))), ...hDirs.flatMap((d) => HL.map((s) => join(d, s)))];
  for (const p of order) if (existsSync(p)) return p;
  return null;
}
const SYSTEM_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
function findChrome(explicit, preferHeadless) {
  if (explicit) {
    const p = explicit.replace(/^~/, homedir());
    if (!existsSync(p)) throw new Error(`指定的浏览器不存在: ${p}`);
    return p;
  }
  const fromCache = findInPlaywrightCache(preferHeadless);
  if (fromCache) return fromCache;
  for (const p of SYSTEM_BROWSERS) if (existsSync(p)) return p;
  const extra = [
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/Applications/Safari.app/Contents/MacOS/Safari',
  ];
  throw new Error('找不到 Chrome/Chromium。请安装 Google Chrome，或用 --chrome <路径> 指定内核');
}

// 让 headless 的 UA 与真实 Chrome 完全一致（去掉 HeadlessChrome 字样）
function chromeMajor(bin) {
  try {
    const m = /Chrome\/(\d+)\./.exec(bin); return m ? m[1] : null;
  } catch { return null; }
}

class Browser {
  constructor(opts) {
    this.opts = opts;
    this.preferHeadless = !opts.headed;
    this.bin = findChrome(opts.chrome, this.preferHeadless);
    this.proc = null;
    this.cdp = null;
    this.port = opts.port || randInt(9300, 9899);
    this.profileDir = opts.profile;
    this.version = null;
  }

  async launch() {
    mkdirSync(this.profileDir, { recursive: true });
    // 同一个 profile 不能被两个 Chrome 同时占用（否则页面会静默失败），加锁保护
    const lockFile = join(this.profileDir, '.cnbrowse.lock');
    if (existsSync(lockFile)) {
      let owner = null;
      try { owner = JSON.parse(readFileSync(lockFile, 'utf8')); } catch {}
      if (owner?.pid) {
        let alive = false;
        try { process.kill(owner.pid, 0); alive = true; } catch {}
        if (alive) {
          throw new Error(
            `profile 已被另一个 cnbrowse 实例占用（PID ${owner.pid}）\n` +
            `  请先结束它，或换一个 profile：--profile ${this.profileDir}-2`);
        }
      }
      try { rmSync(lockFile, { force: true }); } catch {}
    }
    try { writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch {}
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
      '--disable-background-networking', '--disable-component-update',
      '--disable-default-apps', '--disable-sync', '--no-pings',
      '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion',
      '--window-size=1512,945',
      '--lang=zh-CN', '--accept-lang=zh-CN,zh;q=0.9,en;q=0.8',
      '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
      // 无头模式才禁用 GPU；有头模式下禁用 GPU 会让视频渲染成黑屏
      ...(this.opts.headed ? [] : ['--disable-gpu', '--disable-software-rasterizer']),
      '--disable-ipc-flooding-protection',
      ...(this.opts.headed ? [] : ['--headless=new']),
      ...(this.opts.audio ? [] : ['--mute-audio']),
      ...(this.opts.proxy ? [`--proxy-server=${this.opts.proxy}`] : []),
      'about:blank',
    ];
    this.proc = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    let stderr = '';
    this.proc.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-10000); });

    // 等调试端口就绪
    const deadline = Date.now() + 30000;
    let ver = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (r.ok) { ver = await r.json(); break; }
      } catch {}
      if (this.proc.exitCode !== null) throw new Error(`浏览器启动即退出 (code=${this.proc.exitCode})\n${stderr.slice(-800)}`);
      await sleep(300);
    }
    if (!ver) throw new Error(`浏览器调试端口未就绪\n${stderr.slice(-800)}`);
    this.version = ver.Browser;
    this.cdp = new CDP(ver.webSocketDebuggerUrl);
    await this.cdp.ready;
    return this;
  }

  async newPage() {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init();
    return page;
  }

  async close() {
    try { this.cdp?.close(); } catch {}
    try { rmSync(join(this.profileDir, '.cnbrowse.lock'), { force: true }); } catch {}
    try {
      await fetch(`http://127.0.0.1:${this.port}/json/close/` , {}).catch(() => {});
    } catch {}
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      await sleep(400);
      if (this.proc.exitCode === null) { try { this.proc.kill('SIGKILL'); } catch {} }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 页面封装
// ────────────────────────────────────────────────────────────────────────────
class Page {
  constructor(browser, targetId, sessionId) {
    this.b = browser; this.cdp = browser.cdp;
    this.targetId = targetId; this.S = sessionId;
    this.bytes = 0;
    this.requests = 0;
    this.reqs = new Map();
    this.byTypeDelta = new Map();
    this.hostDelta = new Map();
    this._mark = { bytes: 0, requests: 0, failed: 0 };
    this.loading = 0;
    this.lastActivity = Date.now();
    this.hosts = new Map();
    this.byType = new Map();
    this.failed = 0;
    this._offs = [];
    // 记录各 frame 的执行上下文，用来在 iframe 里也找 <video>
    this.contexts = new Map();
    // 真实 UA（覆盖 headless 标记）
    const major = this._chromeMajor();
    this.ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }

  _chromeMajor() {
    const m = /Chrome\/(\d+)\./.exec(this.b.version || '');
    return m ? m[1] : '147';
  }

  async init() {
    const S = this.S;
    this._offs.push(this.cdp.on('Network.responseReceived', (p, sid) => {
      if (sid !== S) return;
      const r = p.response;
      this.lastActivity = Date.now();
      let host = ''; try { host = new URL(r.url).hostname; } catch {}
      this.reqs.set(p.requestId, { url: r.url, type: p.type, status: r.status, mime: r.mimeType, host, cache: !!(r.fromDiskCache || r.fromMemoryCache) });
      if (host) {
        this.hosts.set(host, (this.hosts.get(host) || 0) + 1);
        this.hostDelta.set(host, (this.hostDelta.get(host) || 0) + 1);
      }
    }, S));
    // 请求数：每个请求只计一次（responseReceived）
    this._offs.push(this.cdp.on('Network.requestWillBeSent', (p, sid) => {
      if (sid !== S) return;
      this.requests++;
      this.lastActivity = Date.now();
    }, S));
    // 字节数：以 loadingFinished 的 encodedDataLength 为准（含响应头，等于网线上真实收发字节）
    this._offs.push(this.cdp.on('Network.loadingFinished', (p, sid) => {
      if (sid !== S) return;
      this.lastActivity = Date.now();
      const n = p.encodedDataLength || 0;
      this.bytes += n;
      const r = this.reqs.get(p.requestId);
      if (r) { r.bytes = n;
        this.byType.set(r.type, (this.byType.get(r.type) || 0) + n);
        this.byTypeDelta.set(r.type, (this.byTypeDelta.get(r.type) || 0) + n); }
    }, S));
    this._offs.push(this.cdp.on('Network.loadingFailed', (p, sid) => {
      if (sid === S) this.failed++;
    }, S));
    // 直播/FLV 走 WebSocket，不属于普通请求，需要单独计入字节
    this._offs.push(this.cdp.on('Network.webSocketFrameReceived', (p, sid) => {
      if (sid !== S) return;
      const n = (p.response && p.response.payloadData || '').length;
      if (n > 0) {
        this.bytes += n;
        this.lastActivity = Date.now();
        this.byType.set('WebSocket', (this.byType.get('WebSocket') || 0) + n);
        this.byTypeDelta.set('WebSocket', (this.byTypeDelta.get('WebSocket') || 0) + n);
      }
    }, S));
    this._offs.push(this.cdp.on('Runtime.executionContextCreated', (p, sid) => {
      if (sid !== S) return;
      const c = p.context;
      if (c && c.auxData && c.auxData.isDefault) this.contexts.set(c.id, c.auxData.frameId || '');
    }, S));
    this._offs.push(this.cdp.on('Runtime.executionContextDestroyed', (p, sid) => {
      if (sid === S) this.contexts.delete(p.executionContextId);
    }, S));
    this._offs.push(this.cdp.on('Runtime.executionContextsCleared', (_p, sid) => {
      if (sid === S) this.contexts.clear();
    }, S));

    // 弹窗/对话框会阻塞渲染进程，必须自动关掉
    this._offs.push(this.cdp.on('Page.javascriptDialogOpening', (_p, sid) => {
      if (sid !== S) return;
      this.cdp.send('Page.handleJavaScriptDialog', { accept: true }, S).catch(() => {});
    }, S));
    this._offs.push(this.cdp.on('Inspector.targetCrashed', (_p, sid) => {
      if (sid === S) this.crashed = true;
    }, S));

    await this.cdp.send('Network.enable', { maxTotalBufferSize: 2e8, maxResourceBufferSize: 4e7 }, S);
    await this.cdp.send('Page.enable', {}, S);
    await this.cdp.send('Runtime.enable', {}, S);
    await this.cdp.send('Network.setUserAgentOverride', {
      userAgent: this.ua,
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      platform: 'macOS',
      userAgentMetadata: {
        platform: 'macOS', platformVersion: '15.2.0', architecture: 'arm', model: '',
        mobile: false, fullVersion: `${this._chromeMajor()}.0.0.0`,
        brandFullVersionList: [
          { brand: 'Google Chrome', version: `${this._chromeMajor()}.0.0.0` },
          { brand: 'Chromium', version: `${this._chromeMajor()}.0.0.0` },
          { brand: 'Not?A_Brand', version: '24' }],
        brandVersionList: [
          { brand: 'Google Chrome', version: this._chromeMajor() },
          { brand: 'Chromium', version: this._chromeMajor() },
          { brand: 'Not?A_Brand', version: '24' }],
      },
    }, S);
    // 视口尺寸贴近常见笔记本
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1512, height: 945, deviceScaleFactor: 2, mobile: false,
    }, S);
  }

  async navigate(url, timeout = 45000) {
    const t0 = Date.now();
    await this.cdp.send('Page.navigate', { url }, this.S);
    await this.waitForLoad(timeout);
    return Date.now() - t0;
  }

  async waitForLoad(timeout = 45000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (this.crashed) return false;
      try {
        const rs = await this.evaluate('document.readyState', false, 3000);
        if (rs === 'complete') return true;
      } catch {}
      await sleep(150);
    }
    return false;
  }

  /** 等网络静默：一段时间内没有新的数据到达 */
  async waitForQuiet(quietMs = 1200, maxMs = 15000) {
    const end = Date.now() + maxMs;
    let last = this.lastActivity;
    while (Date.now() < end) {
      await sleep(200);
      if (this.lastActivity === last) {
        if (Date.now() - last >= quietMs) return true;
      } else last = this.lastActivity;
    }
    return false;
  }

  async evaluate(expr, awaitPromise = false, timeoutMs = 8000, contextId = undefined) {
    const params = { expression: expr, returnByValue: true, awaitPromise };
    if (contextId !== undefined) params.contextId = contextId;
    const p = this.cdp.send('Runtime.evaluate', params, this.S);
    const v = await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('eval 超时')), timeoutMs)),
    ]);
    if (v.exceptionDetails) throw new Error(v.exceptionDetails.text || 'eval 失败');
    return v.result?.value;
  }

  /** 用鼠标滚轮滚动（比直接改 scrollTop 更接近真人） */
  async wheel(steps, opts = {}) {
    const x = opts.x ?? randInt(500, 1000);
    const y = opts.y ?? randInt(300, 800);
    for (let i = 0; i < steps; i++) {
      const delta = randInt(180, 520);
      try {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x, y, deltaX: 0, deltaY: delta, modifiers: 0, pointerType: 'mouse',
        }, this.S);
      } catch {}
      await sleep(randInt(160, 620));
    }
  }

  /** 把页面滚到底（触发所有懒加载） */
  async scrollThrough({ maxSteps = 25, onStep } = {}) {
    let lastH = 0, same = 0;
    for (let i = 0; i < maxSteps; i++) {
      const h = await this.evaluate('document.body ? document.body.scrollHeight : 0').catch(() => 0);
      await this.wheel(1);
      await this.waitForQuiet(500, 2500);
      if (onStep) onStep(i, h);
      if (h && h === lastH) { if (++same >= 2) break; } else same = 0;
      lastH = h;
      if (Math.random() < 0.25) await sleep(randInt(600, 2200)); // 偶尔停下来看看
    }
  }

  /** 从当前页面挑一个"像文章/详情"的同域链接 */
  async pickArticleLink(sameHost = true, exclude = []) {
    const host = (() => { try { return new URL(this.url).hostname; } catch { return ''; } })();
    const links = await this.evaluate(`
      (() => {
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          let h = a.href;
          if (!h || !h.startsWith('http')) continue;
          if (a.target === '_blank') continue;
          const t = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim();
          if (t.length < 6 || t.length > 90) continue;
          if (/登录|注册|下载|APP|客户端|首页|更多|全部|排行|广告/.test(t)) continue;
          if (seen.has(h)) continue;
          seen.add(h);
          const deep = h.split('/').length;
          out.push({ u: h, t, deep, host: (()=>{try{return new URL(h).hostname}catch{return ''}})() });
          if (out.length > 600) break;
        }
        return out;
      })()
    `).catch(() => []);
    if (!Array.isArray(links) || !links.length) return null;
    let pool = links.filter((l) => !exclude.includes(l.u));
    if (sameHost && host) {
      const same = pool.filter((l) => l.host === host || l.host.endsWith('.' + host.replace(/^www\./, '')));
      if (same.length) pool = same;
    }
    // 偏爱路径更深的链接（更可能是文章详情）
    const scored = pool.map((l) => ({ ...l, s: l.deep * 2 + (l.t.length > 12 ? 1 : 0) + Math.random() * 4 }));
    scored.sort((a, b) => b.s - a.s);
    return pick(scored.slice(0, Math.min(25, scored.length)));
  }

  async url() {
    try {
      const { result } = await this.cdp.send('Runtime.evaluate',
        { expression: 'location.href', returnByValue: true }, this.S);
      return result?.value || '';
    } catch { return ''; }
  }

  async title() {
    try {
      const { result } = await this.cdp.send('Runtime.evaluate',
        { expression: 'document.title', returnByValue: true }, this.S);
      return (result?.value || '').replace(/\s+/g, ' ').trim();
    } catch { return ''; }
  }

  /** 抓一张当前视口截图（用于确认画面真的在动） */
  async screenshot(dir, tag = 'shot') {
    try {
      const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.S);
      if (!data) return null;
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(dir, `${stamp}-${tag}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    } catch (e) {
      return null;
    }
  }

  /** 触发页面内的延迟请求（滚动、hover、点击"加载更多"） */
  async stimulate() {
    // 尝试点掉可能的弹窗/遮罩（常见于门户站）
    await this.evaluate(`(() => {
      const sels = ['.close','.btn-close','.close-btn','[class*=close]','[class*=Clos]'];
      let n = 0;
      for (const s of sels) for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width < 60 && r.height < 60) { try { el.click(); n++; } catch {} }
        if (n > 3) return n;
      }
      return n;
    })()`).catch(() => {});
    // 点击"加载更多/下一页"以拉取更多内容
    if (Math.random() < 0.5) {
      await this.evaluate(`(() => {
        for (const el of document.querySelectorAll('a,button,div,span')) {
          const t = (el.innerText || '').trim();
          if (/^(加载更多|查看更多|展开全部|下一页|下页|更多)$/.test(t)) { try { el.click(); return t; } catch {} }
        }
        return null;
      })()`).catch(() => {});
      await this.waitForQuiet(900, 4000);
    }
  }

  /** 在当前页面（含同源 iframe）里找 <video> */
  async probeVideos() {
    const probe = `(() => {
      const out = [];
      for (const v of document.querySelectorAll('video')) {
        const r = v.getBoundingClientRect();
        const cs = getComputedStyle(v);
        const vis = cs.display !== 'none' && cs.visibility !== 'hidden' &&
                    parseFloat(cs.opacity || '1') > 0.05;
        const inView = r.bottom > 0 && r.top < innerHeight &&
                       r.right > 0 && r.left < innerWidth;
        out.push({
          src: String(v.currentSrc || v.src || '').slice(0, 160),
          dur: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
          t: Math.round(v.currentTime || 0),
          paused: !!v.paused,
          rs: v.readyState || 0,
          area: Math.round((r.width || 0) * (r.height || 0)),
          vis, inView,
        });
      }
      return out;
    })()`;
    const found = [];
    for (const ctxId of this.contexts.keys()) {
      try {
        const vids = await this.evaluate(probe, false, 3000, ctxId);
        if (Array.isArray(vids) && vids.length) found.push({ ctxId, vids });
      } catch {}
    }
    return found;
  }

  /**
   * 让页面里的视频真正播放起来，并停留指定秒数。
   * 走的是页面自己的播放器（HLS/DASH/原生 video），因此媒体流量与真人观看完全一致。
   */
  async playPageVideo(maxSeconds) {
    const bytesBefore = this.bytes;
    const found = await this.probeVideos();
    if (!found.length) return { played: false, reason: 'no-video' };
    // 优先挑选"真的看得见"的视频：可见 > 在视口内 > 面积大
    const score = (v) => (v.vis ? 1e10 : 0) + (v.inView ? 1e9 : 0) + (v.area || 0);
    const ranked = found
      .map((c) => ({ ...c, best: [...c.vids].sort((x, y) => score(y) - score(x))[0] }))
      .sort((a, b) => score(b.best) - score(a.best));
    const best = ranked[0];
    const visible = !!(best.best && best.best.vis);
    const ctxId = best.ctxId;

    const startScript = `(async () => {
      const vs = [...document.querySelectorAll('video')];
      if (!vs.length) return { ok: false };
      const sc = (v) => {
        const r = v.getBoundingClientRect(), cs = getComputedStyle(v);
        const vis = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05;
        const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
        return (vis ? 1e10 : 0) + (inView ? 1e9 : 0) + (r.width * r.height);
      };
      vs.sort((a, b) => sc(b) - sc(a));
      const v = vs[0];
      // 把播放器滚到视口中央，确保人眼能看到画面
      try { v.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      await new Promise((r) => setTimeout(r, 350));
      v.muted = true; v.volume = 0;
      try { v.play(); } catch (e) {}
      if (v.paused) {
        const cands = [...document.querySelectorAll('button,[class*=play],[class*=Play],[aria-label*=播放],[title*=播放]')];
        for (const b of cands.slice(0, 60)) {
          const tag = ((b.className || '') + ' ' + ((b.getAttribute && b.getAttribute('aria-label')) || '') + ' ' + (b.title || '')).toString();
          if (/play|播放/i.test(tag)) { try { b.click(); break; } catch (e) {} }
        }
        try { v.play(); } catch (e) {}
      }
      return { ok: true, paused: !!v.paused, dur: Number.isFinite(v.duration) ? Math.round(v.duration) : 0 };
    })()`;
    try { await this.evaluate(startScript, true, 6000, ctxId); } catch {}

    const probeT = `(() => {
      const vs = [...document.querySelectorAll('video')];
      if (!vs.length) return null;
      const v = vs[0];
      return { t: v.currentTime || 0, paused: !!v.paused, ended: !!v.ended,
               dur: Number.isFinite(v.duration) ? v.duration : 0 };
    })()`;

    const limitMs = Math.max(3, maxSeconds) * 1000;
    const t0 = Date.now();
    let lastT = null, advanced = 0, dur = best.vids[0]?.dur || 0;
    let shotTaken = false, onScreen = null;
    while (Date.now() - t0 < limitMs) {
      if (this.crashed) break;
      await sleep(1000);
      let st = null;
      try { st = await this.evaluate(probeT, false, 3000, ctxId); } catch { break; }
      if (!st) break;
      if (lastT !== null && st.t > lastT) advanced += st.t - lastT;
      lastT = st.t;
      if (st.dur > 0) dur = st.dur;
      // 起播 2 秒后抓一张图，方便确认画面是否真的在动
      if (advanced >= 2 && !shotTaken) {
        shotTaken = true;
        // 记录播放器是否真的落在视口里（有些站点只是隐藏的预加载 <video>）
        try {
          const pos = await this.evaluate(`(() => {
            const v = document.querySelector('video');
            if (!v) return null;
            const r = v.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height),
                     onScreen: r.bottom > 0 && r.top < innerHeight && r.right > 0 &&
                               r.left < innerWidth && r.width > 40 && r.height > 40 };
          })()`, false, 3000, ctxId);
          onScreen = !!(pos && pos.onScreen);
        } catch { onScreen = null; }
        if (this.b?.opts?.screenshots) {
          await this.screenshot(this.b.opts.screenshots, 'video').catch(() => {});
        }
      }
      if (st.ended) break;
    }
    const secs = (Date.now() - t0) / 1000;
    return {
      played: advanced >= 1, advanced: Math.round(advanced), seconds: Math.round(secs),
      duration: Math.round(dur), bytes: this.bytes - bytesBefore,
      visible, onScreen, area: best.best?.area || 0,
    };
  }

  /** 记录基线 */
  mark() { this._mark = { bytes: this.bytes, requests: this.requests, failed: this.failed }; }

  /** 取走自上次 mark 以来的增量（并重置增量桶） */
  takeDelta() {
    const d = {
      bytes: this.bytes - this._mark.bytes,
      requests: this.requests - this._mark.requests,
      failed: this.failed - this._mark.failed,
    };
    this._mark = { bytes: this.bytes, requests: this.requests, failed: this.failed };
    const byType = new Map(this.byTypeDelta); this.byTypeDelta = new Map();
    const hosts = new Map(this.hostDelta); this.hostDelta = new Map();
    return { ...d, byType, hosts };
  }

  async close() {
    for (const off of this._offs) { try { off(); } catch {} }
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 流量统计
// ────────────────────────────────────────────────────────────────────────────
class Traffic {
  constructor(statsFile) {
    this.t0 = Date.now();
    this.bytes = 0;
    this.pages = 0;
    this.videoPages = 0;
    this.requests = 0;
    this.failed = 0;
    this.byType = new Map();
    this.hosts = new Map();
    this.perSite = new Map();
    this.statsFile = statsFile;
    this.history = [];
  }
  /** 记录一次页面访问的增量（必须传增量，避免与页面累计值重复相加） */
  absorb(page, site, delta) {
    const bytes = delta?.bytes ?? 0;
    const reqs = delta?.requests ?? 0;
    const failed = delta?.failed ?? 0;
    this.bytes += bytes;
    this.requests += reqs;
    this.failed += failed;
    for (const [k, v] of (delta?.byType || [])) this.byType.set(k, (this.byType.get(k) || 0) + v);
    for (const [k, v] of (delta?.hosts || [])) this.hosts.set(k, (this.hosts.get(k) || 0) + v);
    const key = site?.n || '直连';
    const cur = this.perSite.get(key) || { bytes: 0, pages: 0 };
    cur.bytes += bytes; cur.pages++; this.perSite.set(key, cur);
    this.pages++;
  }
  get elapsed() { return Math.max(0.001, (Date.now() - this.t0) / 1000); }
  get rate() { return this.bytes * 8 / this.elapsed; }
  snapshot() {
    return {
      elapsedSec: Math.round(this.elapsed), bytes: this.bytes, pages: this.pages,
      videoPages: this.videoPages,
      requests: this.requests, failed: this.failed, mbps: +(this.rate / 1e6).toFixed(3),
      byType: Object.fromEntries([...this.byType.entries()].map(([k, v]) => [k, v])),
      topHosts: [...this.hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
      perSite: Object.fromEntries([...this.perSite.entries()].sort((a, b) => b[1].bytes - a[1].bytes)),
    };
  }
  persist() {
    if (!this.statsFile) return;
    try {
      mkdirSync(dirname(this.statsFile), { recursive: true });
      writeFileSync(this.statsFile, JSON.stringify(this.snapshot(), null, 2));
    } catch {}
  }
  line() {
    return `${C.dim('累计')} ${C.cyan(fmtBytes(this.bytes).padStart(9))}  ` +
      `${C.dim('页面 ' + String(this.pages).padStart(4))}  ` +
      `${C.dim('用时 ' + fmtDur(this.elapsed))}  ` +
      `${C.green(fmtRate(this.rate).padStart(10))}`;
  }

  report() {
    const s = this.snapshot();
    const L = [];
    L.push('');
    L.push(C.bold('── 流量汇总 ' + '─'.repeat(46)));
    L.push(`  总流量      ${C.cyan(fmtBytes(s.bytes))}`);
    L.push(`  页面数      ${s.pages}`);
    if (s.videoPages) {
      L.push(`  含视频页    ${s.videoPages}${C.dim(`（${(s.videoPages / Math.max(1, s.pages) * 100).toFixed(0)}% 的页面播了视频）`)}`);
    }
    L.push(`  请求数      ${s.requests}${s.failed ? C.dim(`（失败 ${s.failed}）`) : ''}`);
    L.push(`  运行时长    ${fmtDur(s.elapsedSec)}`);
    L.push(`  平均速率    ${C.green(fmtRate(s.mbps * 1e6))}`);
    const types = s.byType;
    const tot = Object.values(types).reduce((a, b) => a + b, 0) || 1;
    const tb = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 7)
      .map(([k, v]) => `${k} ${fmtBytes(v)}(${(v / tot * 100).toFixed(0)}%)`).join('  ');
    if (tb) L.push(`  资源构成    ${C.dim(tb)}`);
    const th = s.topHosts.slice(0, 6).map(([h, n]) => `${h}(${n})`).join(' ');
    if (th) L.push(`  活跃域名    ${C.dim(th)}`);
    const ps = Object.entries(s.perSite).slice(0, 8)
      .map(([k, v]) => `${k} ${fmtBytes(v.bytes)}/${v.pages}页`).join('  ');
    if (ps) L.push(`  分站流量    ${C.dim(ps)}`);
    L.push(C.dim('─'.repeat(56)));
    if (this.statsFile) L.push(C.dim(`  统计已写入 ${this.statsFile}`));
    return L.join('\n');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    categories: [], sites: [], exclude: [], pages: 0, duration: 0, depth: 1,
    minDwell: 3, maxDwell: 20, quiet: false, headed: false, audio: false,
    profile: join(homedir(), '.config', 'cnbrowse', 'browser-profile'),
    statsFile: '', chrome: '', port: 0, seed: '', heavyOnly: false, verbose: false,
    concurrency: 1, maxRate: 0, noImage: false, saveFailed: false, targetBytes: 0,
    video: true, videoSeconds: [8, 25], screenshots: '', urls: [],
  };
  const a = argv.slice();
  const need = (i, k) => { if (i + 1 >= a.length) throw new Error(`${k} 需要一个参数`); return a[i + 1]; };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    switch (k) {
      case '--category': case '-c': o.categories.push(...need(i, k).split(',')); i++; break;
      case '--sites': o.sites.push(...need(i, k).split(',')); i++; break;
      case '--exclude': o.exclude.push(...need(i, k).split(',')); i++; break;
      case '--pages': case '-n': o.pages = parseInt(need(i, k), 10); i++; break;
      case '--duration': case '-t': o.duration = parseInt(need(i, k), 10); i++; break;
      case '--depth': o.depth = parseInt(need(i, k), 10); i++; break;
      case '--dwell': { const v = need(i, k).split('-').map(Number); o.minDwell = v[0]; o.maxDwell = v[1] ?? v[0]; i++; break; }
      case '--profile': o.profile = need(i, k); i++; break;
      case '--stats-file': o.statsFile = need(i, k); i++; break;
      case '--chrome': o.chrome = need(i, k); i++; break;
      case '--port': o.port = parseInt(need(i, k), 10); i++; break;
      case '--concurrency': o.concurrency = Math.max(1, parseInt(need(i, k), 10)); i++; break;
      case '--max-rate': o.maxRate = parseFloat(need(i, k)) * 1e6; i++; break;
      case '--target-traffic': o.targetBytes = parseSize(need(i, k)); i++; break;
      case '--no-video': o.video = false; break;
      case '--screenshot': o.screenshots = need(i, k); i++; break;
      case '--url': o.urls.push(need(i, k)); i++; break;
      case '--video-seconds': {
        const v = need(i, k).split('-').map(Number);
        o.videoSeconds = [v[0] || 8, v[1] ?? v[0] ?? 25];
        i++; break;
      }
      case '--quiet': case '-q': o.quiet = true; break;
      case '--headed': o.headed = true; break;
      case '--audio': o.audio = true; break;
      case '--heavy': o.heavyOnly = true; break;
      case '--verbose': case '-v': o.verbose = true; break;
      case '--list-sites': o.listSites = true; break;
      case '--list-categories': o.listCategories = true; break;
      case '--help': case '-h': o.help = true; break;
      case '--version': o.version = true; break;
      default:
        if (k.startsWith('-')) throw new Error(`未知参数 ${k}`);
        o.sites.push(k);
    }
  }
  return o;
}

const HELP = `
cnbrowse —— 用真实浏览器随机浏览国内网站，产生与真人上网一致的流量

用法:
  node cnbrowse.mjs [选项]                  随机浏览（默认不限时长）
  node cnbrowse.mjs -t 600                  浏览 10 分钟后停止
  node cnbrowse.mjs -n 200                  浏览满 200 个页面后停止
  node cnbrowse.mjs -c news,tech            只逛新闻和科技类站点
  node cnbrowse.mjs --heavy                 只逛图片/媒体多的"高流量"站点
  node cnbrowse.mjs --sites 京东,淘宝,知乎   指定站点名（支持中文名/域名/分类）
  node cnbrowse.mjs --list-sites            查看站点池

选项:
  -c, --category <列表>   站点类别，逗号分隔（用 --list-categories 查看）
      --sites <列表>      指定站点（中文名、域名、或类别）
      --exclude <列表>    排除站点
  -n, --pages <数量>      浏览多少个页面后停止（0=不限）
  -t, --duration <秒>     运行多少秒后停止（0=不限）
      --target-traffic <容量>  累计到指定流量后停止（如 500MB、2GB）
      --depth <层数>      每站深入详情页的层数（默认 1）
      --dwell <a-b>       每页停留秒数区间（默认 3-20）
      --heavy             只逛高流量站点（图片/视频/购物）
      --concurrency <n>   并行标签页数（默认 1，更像真人）
      --max-rate <Mbps>   限制平均速率上限（默认不限）
      --no-video          不自动播放页面里的视频（默认会播）
      --video-seconds <a-b>  每页视频播放时长区间（默认 8-25 秒）
      --screenshot <目录>  视频起播 2 秒后自动截图，用于确认画面在动
      --url <网址>        直接指定要浏览的页面（可多次；用于测试某个具体播放页）
      --profile <目录>    浏览器 profile 目录（保留 Cookie/缓存，默认 ~/.config/cnbrowse/...）
      --stats-file <路径> 持续把统计写入 JSON
      --chrome <路径>     指定 Chrome/Chromium 可执行文件
      --port <端口>       调试端口（默认随机）
      --headed            显示浏览器窗口（默认无头；窗口可配合隐藏）
      --audio             允许播放声音（默认静音）
  -q, --quiet             只输出最终汇总
  -v, --verbose           输出每个请求的调试信息
  -h, --help              显示帮助
`;

function resolveSites(o) {
  let pool = SITES.slice();
  // --url：直接指定页面，忽略内置站点池（便于测试具体播放页）
  if (o.urls && o.urls.length) {
    return o.urls.map((u) => {
      let host = u;
      try { host = new URL(u).hostname; } catch {}
      return { n: host, u, c: 'custom', heavy: true };
    });
  }
  if (o.heavyOnly) pool = pool.filter((s) => s.heavy);
  if (o.categories.length) {
    const cs = o.categories.map((c) => c.toLowerCase());
    const bad = cs.filter((c) => !CATEGORIES.includes(c));
    if (bad.length) throw new Error(`未知类别: ${bad.join(', ')}（可用: ${CATEGORIES.join(', ')}）`);
    pool = pool.filter((s) => cs.includes(s.c));
  }
  if (o.sites.length) {
    const wanted = [];
    for (const raw of o.sites) {
      const q = raw.trim().toLowerCase();
      const hit = SITES.filter((s) =>
        s.n.toLowerCase() === q || s.c === q ||
        s.n.toLowerCase().includes(q) ||
        s.u.toLowerCase().includes(q));
      if (!hit.length) throw new Error(`站点池里没有: ${raw}（用 --list-sites 查看）`);
      wanted.push(...hit);
    }
    const keep = new Set(wanted.map((s) => s.u));
    pool = pool.filter((s) => keep.has(s.u));
  }
  if (o.exclude.length) {
    const ex = o.exclude.map((x) => x.trim().toLowerCase());
    pool = pool.filter((s) => !ex.some((q) => s.n.toLowerCase().includes(q) || s.u.toLowerCase().includes(q)));
  }
  if (!pool.length) throw new Error('筛选后没有可用站点');
  return pool;
}

// ──────────────────────────────────────────���─────────────────────────────────
// 浏览主循环
// ────────────────────────────────────────────────────────────────────────────
class Runner {
  constructor(opts, browser) {
    this.o = opts;
    this.browser = browser;
    this.traffic = new Traffic(opts.statsFile);
    this.stopped = false;
    this.visited = new Map();   // 域名 -> 上次访问时间，避免过于频繁
    this.recent = [];
  }

  log(msg) { if (!this.o.quiet) process.stdout.write(msg); }
  /** 打印一行日志：先清掉底部的实时进度行，再输出，避免串行 */
  logln(msg = '') {
    if (this.o.quiet) return;
    if (this._hasBar) process.stdout.write('\r' + ' '.repeat(110) + '\r');
    console.log(msg);
    this._hasBar = false;
  }

  /** 挑下一个站点：近期没逛过的优先，带随机权重 */
  nextSite() {
    const now = Date.now();
    const pool = this.o._pool;
    const cand = pool.filter((s) => {
      const h = (() => { try { return new URL(s.u).hostname; } catch { return s.u; } })();
      const last = this.visited.get(h) || 0;
      return now - last > 6 * 60 * 1000;
    });
    const use = cand.length ? cand : pool;
    // 高流量站点略微加权（流量目标）
    const weighted = [];
    for (const s of use) {
      weighted.push(s);
      if (s.heavy) { weighted.push(s); if (Math.random() < 0.4) weighted.push(s); }
    }
    let s = pick(weighted);
    let guard = 0;
    while (this.recent.includes(s.u) && guard++ < 40) s = pick(weighted);
    this.recent.push(s.u); if (this.recent.length > 12) this.recent.shift();
    const h = (() => { try { return new URL(s.u).hostname; } catch { return s.u; } })();
    this.visited.set(h, Date.now());
    return s;
  }

  /** 浏览单个页面（导航 + 滚动 + 刺激加载），返回该页流量 */
  async visit(page, url, label, dwell = true) {
    page.mark();
    try {
      await page.navigate(url, 45000);
    } catch (e) {
      return { ...page.takeDelta(), title: '', err: e.message };
    }
    await page.waitForQuiet(1200, 12000);
    if (this.o.verbose) this.logln(C.dim(`      ${url.slice(0, 110)}`));

    // 滚动触发懒加载
    await page.scrollThrough({ maxSteps: randInt(6, 18) });
    await page.stimulate();

    // 页面里有视频就播一会儿：媒体流量与真人观看一致
    let video = null;
    if (this.o.video) {
      const maxSec = randInt(this.o.videoSeconds[0], this.o.videoSeconds[1]);
      try {
        video = await page.playPageVideo(maxSec);
        if (video && video.played) {
          this.traffic.videoPages++;
          if (this.o.verbose) {
            this.logln(C.dim(`      视频播放 ${video.advanced}s（页面时长 ${video.duration || '?'}s）`));
          }
        }
      } catch (e) {
        if (this.o.verbose) this.logln(C.dim(`      视频播放失败: ${e.message}`));
      }
    }

    // 停留（期间偶尔滚动，产生少量后续请求）
    // 已经看了一会儿视频的话，停留时间折半，更像"看两眼就走"
    if (dwell) {
      const base = randInt(this.o.minDwell, this.o.maxDwell);
      const s = (video && video.played) ? Math.max(1, Math.round(base / 2)) : base;
      const end = Date.now() + s * 1000;
      while (Date.now() < end && !this.stopped) {
        await sleep(randInt(300, 900));
        if (Math.random() < 0.35) await page.wheel(1);
      }
    }
    await page.waitForQuiet(400, 2000);
    const title = await page.title();
    return { ...page.takeDelta(), title, video };
  }

  async browseOnce(page, site) {
    const res = { site, bytes: 0, pages: 0 };
    const r0 = await this.visit(page, site.u, site.n, true);
    res.bytes += r0.bytes; res.pages++;
    const shown = (r0.title || site.n).slice(0, 50);
    this.logln(`\n  ${C.green('▶')} ${C.bold(site.n.padEnd(11))}${C.dim(site.u.replace(/^https?:\/\//, '').slice(0, 30).padEnd(31))}` +
      ` ${C.cyan(fmtBytes(r0.bytes).padStart(9))} ${C.dim(fmtRate(r0.bytes / Math.max(1, r0.sec ?? 1)).padStart(9))}  ${C.dim(shown)}`);
    if (r0.video && r0.video.played) {
      this.logln(C.dim(`      ▶ 已播放视频 ${r0.video.advanced}s` +
        `（页面时长 ${r0.video.duration || '直播/?'}s）` +
        ` 播放期间拉流 ${fmtBytes(r0.video.bytes || 0)}` +
        (r0.video.onScreen === false
          ? C.yellow('  ⚠ 播放器不在视口内（隐藏的预加载/预览）')
          : '')));
    }
    this.traffic.absorb(page, site, r0);
    this.traffic.persist();
    this.logln('  ' + this.traffic.line());

    // 深入详情页
    const depth = Math.max(0, this.o.depth);
    const seen = [site.u];
    for (let d = 1; d <= depth; d++) {
      if (this.stopped || this.shouldStop()) break;
      if (d > 1) {   // 再回首页挑新链接，更像真人翻页
        const rh = await this.visit(page, site.u, site.n, false);
        this.traffic.absorb(page, site, rh);
        this.traffic.persist();
      }
      const link = await page.pickArticleLink(true, seen);
      if (!link) break;
      seen.push(link.u);
      const r = await this.visit(page, link.u, site.n, true);
      res.bytes += r.bytes; res.pages++;
      this.logln(`  ${C.cyan('  └ 详情')}${' '.repeat(4)}${C.dim(link.host.slice(0, 30).padEnd(31))} ` +
        `${C.cyan(fmtBytes(r.bytes).padStart(9))}  ${C.dim((r.title || link.t).slice(0, 52))}`);
      this.traffic.absorb(page, site, r);
      this.traffic.persist();
      this.logln('  ' + this.traffic.line());
      if (Math.random() < 0.35) break;
    }

    // 偶尔在新开标签页里逛（真人常有多标签）
    if (!this.stopped && !this.shouldStop() && Math.random() < 0.18) {
      const extra = await this.browser.newPage();
      try {
        const s2 = this.nextSite();
        const r = await this.visit(extra, s2.u, s2.n, true);
        this.logln(`  ${C.cyan('  ⊞ 新标签')} ${C.dim(s2.n.slice(0, 30).padEnd(31))} ` +
          `${C.cyan(fmtBytes(r.bytes).padStart(9))}  ${C.dim((r.title || '').slice(0, 52))}`);
        this.traffic.absorb(extra, s2, r);
        this.traffic.persist();
        this.logln('  ' + this.traffic.line());
      } catch (e) { if (this.o.verbose) this.logln(C.dim(`     新标签失败 ${e.message}`)); }
      finally { try { await extra.close(); } catch {} }
    }
    return res;
  }

  /** 限速：若平均速率已超过目标，则等待，使曲线贴近设定值 */
  async pace() {
    const o = this.o;
    if (!o.maxRate) return;
    while (!this.stopped && this.traffic.rate > o.maxRate) {
      await sleep(400);
      if (this.traffic.bytes / this.traffic.elapsed < o.maxRate) break;
      // 速率是累计平均，若已超得不多就继续走
      if (this.traffic.rate < o.maxRate * 1.08) break;
    }
  }

  shouldStop() {
    if (this.stopped) return true;
    const o = this.o;
    if (o.duration > 0 && this.traffic.elapsed >= o.duration) return true;
    if (o.pages > 0 && this.traffic.pages >= o.pages) return true;
    if (o.targetBytes > 0 && this.traffic.bytes >= o.targetBytes) return true;
    return false;
  }

  async run() {
    const o = this.o;
    const worker = async (id) => {
      let page;
      try { page = await this.browser.newPage(); }
      catch (e) { if (!o.quiet) console.error(C.red(`  标签页创建失败: ${e.message}`)); return; }
      try {
        while (!this.shouldStop()) {
          const site = this.nextSite();
          try { await this.browseOnce(page, site); }
          catch (e) {
            if (!o.quiet) console.error(C.yellow(`  ! ${site.n} 出错: ${e.message}`));
            this.traffic.failed++;
          }
          if (this.shouldStop()) break;
          await this.pace();                   // 速率/节奏控制
          await sleep(randInt(600, 2600));     // 换站之间的自然停顿
        }
      } finally { try { await page.close(); } catch {} }
    };
    const workers = [];
    for (let i = 0; i < o.concurrency; i++) {
      workers.push(worker(i));
      if (i < o.concurrency - 1) await sleep(randInt(500, 1800));  // 错开启动
    }
    await Promise.all(workers);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────────────────────
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }
  if (o.version) { console.log('cnbrowse 1.0.0'); return 0; }
  if (o.listCategories) { console.log(CATEGORIES.join('  ')); return 0; }
  if (o.listSites) {
    console.log('');
    console.log(C.bold(`站点池（${SITES.length} ��）`));
    for (const c of CATEGORIES) {
      const list = SITES.filter((s) => s.c === c);
      console.log(`\n${C.cyan(c)} (${list.length})`);
      for (const s of list) {
        console.log(`  ${s.n.padEnd(12)} ${C.dim(s.u.padEnd(40))}${s.heavy ? C.yellow(' 高流量') : ''}`);
      }
    }
    console.log('');
    return 0;
  }

  o._pool = resolveSites(o);

  if (!o.quiet) {
    console.log('');
    console.log(C.bold('  cnbrowse · 真实浏览器随机浏览'));
    console.log(C.dim(`  站点池 ${o._pool.length} 个` +
      (o.categories.length ? `  类别 ${o.categories.join(',')}` : '') +
      (o.heavyOnly ? '  [仅高流量站]' : '') +
      `  并发标签页 ${o.concurrency}  停留 ${o.minDwell}-${o.maxDwell}s` +
      `  每站深入 ${o.depth} 层` +
      (o.video ? `  视频 ${o.videoSeconds[0]}-${o.videoSeconds[1]}s` : '  不播视频') +
      (o.maxRate ? `  限速 ${(o.maxRate / 1e6).toFixed(2)} Mbps` : '') +
      (o.targetBytes ? `  目标 ${fmtBytes(o.targetBytes)}` : '')));
  }

  const browser = new Browser(o);
  try {
    await browser.launch();
  } catch (e) {
    console.error(C.red(`\n启动浏览器失败: ${e.message}\n`));
    return 2;
  }
  if (!o.quiet) {
    console.log(C.dim(`  浏览器 ${browser.version}`));
    console.log(C.dim(`  内核 ${browser.bin}`));
    console.log(C.dim(`  profile ${browser.profileDir}`));
    console.log(C.dim(`  统计口径：网络层实际收发字节（与运营商侧一致）`));
    console.log('');
  }

  const runner = new Runner(o, browser);
  const stop = (sig) => {
    if (runner.stopped) return;
    runner.stopped = true;
    if (!o.quiet) console.log(C.yellow(`\n  收到 ${sig}，正在收尾…`));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const ticker = o.quiet ? null : setInterval(() => {
    const t = runner.traffic;
    const goal = o.targetBytes ? ` / ${fmtBytes(o.targetBytes)} (${(t.bytes / o.targetBytes * 100).toFixed(1)}%)` : '';
    const line = `\r  ${C.dim('·')} 累计 ${C.cyan(fmtBytes(t.bytes).padStart(9))}${C.dim(goal)}  ` +
      `页面 ${String(t.pages).padStart(4)}  请求 ${String(t.requests).padStart(6)}  ` +
      `${fmtDur(t.elapsed)}  ${C.green(fmtRate(t.rate).padStart(10))}`;
    process.stdout.write(line.padEnd(96));
    runner._hasBar = true;
  }, 1000);

  const t0 = Date.now();
  try { await runner.run(); }
  finally {
    if (ticker) clearInterval(ticker);
    if (!o.quiet) process.stdout.write('\r' + ' '.repeat(100) + '\r');
    runner.traffic.persist();
    await browser.close();
  }

  console.log(runner.traffic.report());
  return 0;
}

main().then((rc) => process.exit(rc)).catch((e) => {
  console.error(C.red(`\n错误: ${e.message}\n`));
  if (process.env.CNBROWSE_DEBUG) console.error(e.stack);
  process.exit(1);
});
