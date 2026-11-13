#!/usr/bin/env python3
"""
bilicli —— 命令行看 B 站，不出画面，但网络流量与浏览器观看视频一致。

设计要点：
  * 上游所有请求由 curl_cffi 发出，TLS/JA4/HTTP2/Akamai 指纹与真实 Chrome 一致，
    请求头顺序、Accept-Encoding(br/zstd)、Cookie(buvid3/4、b_nut) 也与浏览器一致。
  * 走 B 站正经的 DASH 取流链路：web-interface/view -> player/wbi/playurl -> CDN m4s。
  * "browser" 模式下除了播放音频，还会用后台线程按实时码率拉取视频轨（丢弃不显示），
    使上行/下行的字节构成、分片节奏、速率曲线都接近网页播���器。
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import re
import shutil
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from curl_cffi import requests as cffi_requests
except ImportError:  # pragma: no cover
    sys.stderr.write("缺少依赖 curl_cffi，请执行：python3 -m pip install curl_cffi\n")
    sys.exit(2)

__version__ = "1.0.0"

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("BILICLI_HOME", HOME / ".config" / "bilicli"))
COOKIE_FILE = CONFIG_DIR / "cookies.json"

# B 站 wbi 签名用的字符重排表
MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]

QUALITY_ALIASES = {
    "8k": 127, "dolby": 126, "hdr": 125, "4k": 120, "1080p60": 116,
    "1080p+": 112, "1080p": 80, "720p": 64, "480p": 32, "360p": 16, "auto": 0,
}
QUALITY_NAMES = {
    127: "8K 超高清", 126: "杜比视界", 125: "HDR 真彩", 120: "4K 超清",
    116: "1080P60", 112: "1080P 高码率", 80: "1080P 高清", 74: "720P60",
    64: "720P 准高清", 32: "480P 标清", 16: "360P 流畅",
}
# 浏览器上更常见的编码优先：H.264 -> AV1 -> HEVC
CODEC_PREF = ("avc1", "av01", "hev1", "hvc1")


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
class C:
    """终端着色（非 tty 时自动关闭）"""
    _on = sys.stdout.isatty()

    @staticmethod
    def w(s: str, code: str) -> str:
        if not C._on:
            return s
        return f"\033[{code}m{s}\033[0m"

    @staticmethod
    def dim(s: str) -> str: return C.w(s, "2")
    @staticmethod
    def bold(s: str) -> str: return C.w(s, "1")
    @staticmethod
    def green(s: str) -> str: return C.w(s, "32")
    @staticmethod
    def yellow(s: str) -> str: return C.w(s, "33")
    @staticmethod
    def red(s: str) -> str: return C.w(s, "31")
    @staticmethod
    def cyan(s: str) -> str: return C.w(s, "36")


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024.0
    return f"{n:.1f} GB"


def human_time(sec: float) -> str:
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def parse_size(text: str) -> int:
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([kKmMgG]?)\s*", text or "")
    if not m:
        raise argparse.ArgumentTypeError(f"无法解析大小: {text!r}")
    val = float(m.group(1))
    mult = {"": 1, "k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}[m.group(2).lower()]
    return int(val * mult)


class Log:
    def __init__(self, verbose: bool = False, quiet: bool = False):
        self.verbose = verbose
        self.quiet = quiet

    def info(self, msg: str) -> None:
        if not self.quiet:
            print(msg)

    def debug(self, msg: str) -> None:
        if self.verbose and not self.quiet:
            print(C.dim(f"  · {msg}"))

    def warn(self, msg: str) -> None:
        if not self.quiet:
            print(C.yellow(f"  ! {msg}"), file=sys.stderr)

    def error(self, msg: str) -> None:
        print(C.red(f"错误: {msg}"), file=sys.stderr)


class Stats:
    """流量统计：直接对应"看起来像不像浏览器看视频"这个目标"""

    def __init__(self) -> None:
        self.t0 = time.time()
        self._lock = threading.Lock()
        self.bytes = {"audio": 0, "video": 0}
        self.requests = {"audio": 0, "video": 0}
        self.errors: List[str] = []

    def add(self, track: str, n: int) -> None:
        with self._lock:
            self.bytes[track] = self.bytes.get(track, 0) + n

    def hit(self, track: str) -> None:
        with self._lock:
            self.requests[track] = self.requests.get(track, 0) + 1

    def note_error(self, msg: str) -> None:
        with self._lock:
            if len(self.errors) < 20:
                self.errors.append(msg)

    @property
    def elapsed(self) -> float:
        return max(1e-6, time.time() - self.t0)

    def rate_mbps(self, track: Optional[str] = None) -> float:
        with self._lock:
            total = self.bytes[track] if track else sum(self.bytes.values())
        return total * 8 / self.elapsed / 1e6

    def summary(self) -> str:
        with self._lock:
            a, v = self.bytes["audio"], self.bytes["video"]
            ra, rv = self.requests["audio"], self.requests["video"]
        lines = [
            "",
            C.bold("── 本次流量（与浏览器播放同源同节奏）──────────────"),
            f"  音频轨  {human_bytes(a):>10}  {ra:>4} 次分片请求  {a*8/self.elapsed/1e6:>6.2f} Mbps",
            f"  视频轨  {human_bytes(v):>10}  {rv:>4} 次分片请求  {v*8/self.elapsed/1e6:>6.2f} Mbps",
            f"  合计    {human_bytes(a+v):>10}  用时 {human_time(self.elapsed)}  "
            f"平均 {(a+v)*8/self.elapsed/1e6:.2f} Mbps",
        ]
        if self.errors:
            lines.append(C.dim(f"  重试/异常 {len(self.errors)} 次"))
        lines.append(C.dim("──────────────────────────────────────────────────"))
        return "\n".join(lines)


# --------------------------------------------------------------------------
# HTTP 客户端（浏览器级指纹）
# --------------------------------------------------------------------------
class Client:
    """封装 curl_cffi 会话：TLS/JA4/HTTP2/头序 全部模仿真实浏览器。"""

    def __init__(self, impersonate: str = "chrome", log: Optional[Log] = None,
                 cookie_file: Optional[Path] = None):
        self.log = log or Log()
        self.impersonate = impersonate
        self.cookie_file = Path(cookie_file) if cookie_file else COOKIE_FILE
        self.s = cffi_requests.Session(impersonate=impersonate)
        # 中文优先，其余交给 impersonate 提供的浏览器默认头
        self.s.headers.update({"accept-language": "zh-CN,zh;q=0.9,en;q=0.8"})
        self._mixin: Optional[str] = None
        self._mixin_ts: float = 0.0
        self.nav: Dict[str, Any] = {}
        self._load_cookies()
        self._bootstrap_identity()

    # ---- cookie 持久化：多次调用看起来是同一个"浏览器" ----
    def _load_cookies(self) -> None:
        if not self.cookie_file.exists():
            return
        try:
            data = json.loads(self.cookie_file.read_text("utf-8"))
        except Exception:
            return
        for name, value in (data.get("cookies") or {}).items():
            try:
                self.s.cookies.set(name, value, domain=".bilibili.com")
            except Exception:
                pass

    def _save_cookies(self) -> None:
        try:
            self.cookie_file.parent.mkdir(parents=True, exist_ok=True)
            jar = {}
            for ck in self.s.cookies.jar:
                if "bilibili" in (ck.domain or "") or not ck.domain:
                    jar[ck.name] = ck.value
            tmp = self.cookie_file.with_suffix(".tmp")
            tmp.write_text(json.dumps({"cookies": jar}, ensure_ascii=False, indent=1), "utf-8")
            tmp.replace(self.cookie_file)
            os.chmod(self.cookie_file, 0o600)
        except Exception as exc:
            self.log.debug(f"cookie 保存失败: {exc}")

    def _bootstrap_identity(self) -> None:
        """像浏览器一样：先开首页拿 b_nut/buvid、再补 buvid3/4 设备指纹。"""
        try:
            self.s.get("https://www.bilibili.com/", timeout=20)
        except Exception as exc:
            self.log.debug(f"首页访问失败: {exc}")
        try:
            r = self.s.get("https://api.bilibili.com/x/frontend/finger/spi", timeout=15)
            data = (r.json() or {}).get("data") or {}
            if data.get("b_3"):
                self.s.cookies.set("buvid3", data["b_3"], domain=".bilibili.com")
            if data.get("b_4"):
                self.s.cookies.set("buvid4", data["b_4"], domain=".bilibili.com")
        except Exception as exc:
            self.log.debug(f"设备指纹接口失败: {exc}")
        self._save_cookies()

    # ---- wbi 签名 ----
    def mixin_key(self, force: bool = False) -> str:
        now = time.time()
        if self._mixin and not force and now - self._mixin_ts < 1800:
            return self._mixin
        nav = self.api("/x/web-interface/nav")
        self.nav = nav
        wi = ((nav.get("data") or {}).get("wbi_img")) or {}
        img = (wi.get("img_url") or "").rsplit("/", 1)[-1].split(".")[0]
        sub = (wi.get("sub_url") or "").rsplit("/", 1)[-1].split(".")[0]
        if not img or not sub:
            raise RuntimeError("无法获取 wbi 密钥（nav 接口异常）")
        raw = img + sub
        self._mixin = "".join(raw[i] for i in MIXIN_TAB)[:32]
        self._mixin_ts = now
        return self._mixin

    def sign(self, params: Dict[str, Any]) -> Dict[str, Any]:
        mixin = self.mixin_key()
        p = dict(params)
        p["wts"] = int(time.time())
        p = dict(sorted(p.items()))
        query = re.sub(r"[!'()*]", "", urllib.parse.urlencode(p))
        p["w_rid"] = hashlib.md5((query + mixin).encode("utf-8")).hexdigest()
        return p

    @property
    def logged_in(self) -> bool:
        return bool((self.nav.get("data") or {}).get("isLogin"))

    def uname(self) -> str:
        return ((self.nav.get("data") or {}).get("uname") or "")

    # ---- 通用 API ----
    def api(self, path: str, params: Optional[Dict[str, Any]] = None, *,
            wbi: bool = False, referer: str = "https://www.bilibili.com/",
            origin: Optional[str] = "https://www.bilibili.com",
            timeout: int = 20, retries: int = 2) -> Dict[str, Any]:
        url = path if path.startswith("http") else "https://api.bilibili.com" + path
        last: Optional[Exception] = None
        for attempt in range(retries + 1):
            try:
                p = self.sign(params or {}) if wbi else dict(params or {})
                headers = {}
                if referer:
                    headers["referer"] = referer
                if origin:
                    headers["origin"] = origin
                r = self.s.get(url, params=p, headers=headers, timeout=timeout)
                try:
                    return r.json()
                except Exception:
                    raise RuntimeError(f"非 JSON 响应 HTTP {r.status_code}: {r.text[:160]}")
            except Exception as exc:
                last = exc
                if attempt < retries:
                    time.sleep(0.6 * (attempt + 1))
                    if wbi:
                        self.mixin_key(force=True)
        raise RuntimeError(str(last))

    # ---- 具体业务接口 ----
    def view(self, bvid: Optional[str] = None, aid: Optional[int] = None) -> Dict[str, Any]:
        p: Dict[str, Any] = {}
        if bvid:
            p["bvid"] = bvid
        elif aid:
            p["aid"] = aid
        else:
            raise ValueError("需要 bvid 或 aid")
        return self.api("/x/web-interface/view", p)

    def playurl(self, *, bvid: str, cid: int, qn: int = 0, fnval: int = 4048,
                fourk: int = 1) -> Dict[str, Any]:
        params = {
            "bvid": bvid, "cid": cid, "qn": qn, "fnval": fnval,
            "fnver": 0, "fourk": fourk, "otype": "json",
        }
        return self.api("/x/player/wbi/playurl", params, wbi=True,
                        referer=f"https://www.bilibili.com/video/{bvid}")

    def playurl_pgc(self, *, ep_id: int, qn: int = 0, fnval: int = 4048,
                    fourk: int = 1) -> Dict[str, Any]:
        params = {"ep_id": ep_id, "qn": qn, "fnval": fnval, "fnver": 0,
                  "fourk": fourk, "otype": "json"}
        return self.api("/pgc/player/web/playurl", params, wbi=True,
                        referer=f"https://www.bilibili.com/bangumi/play/ep{ep_id}")

    def search(self, keyword: str, page: int = 1, page_size: int = 20) -> Dict[str, Any]:
        """搜索。风控时先访问搜索页刷新 buvid，再换接口重试。"""
        params = {"search_type": "video", "keyword": keyword,
                  "page": page, "page_size": page_size}
        referer = f"https://search.bilibili.com/all?keyword={urllib.parse.quote(keyword)}"
        last: Dict[str, Any] = {}
        for attempt in range(3):
            if attempt > 0:
                try:
                    self.s.get("https://search.bilibili.com/", timeout=20)
                except Exception:
                    pass
                self._bootstrap_identity()
            try:
                r = self.api("/x/web-interface/wbi/search/type",
                             params, wbi=True, referer=referer)
            except Exception as exc:
                self.log.debug(f"搜索请求异常: {exc}")
                r = {}
            if r.get("code") == 0 and (r.get("data") or {}).get("result"):
                return r
            last = r
            if not (r.get("data") or {}).get("v_voucher"):
                break
            time.sleep(1.0 + attempt)
        return last


# --------------------------------------------------------------------------
# 媒体流解析
# --------------------------------------------------------------------------
class Track:
    def __init__(self, kind: str, url: str, backup: List[str], codec: str = "",
                 qid: int = 0, bandwidth: int = 0, width: int = 0, height: int = 0,
                 frame_rate: str = "", size: int = 0):
        self.kind = kind
        self.url = url
        self.backup = list(backup or [])
        self.codec = codec
        self.qid = qid
        self.bandwidth = bandwidth
        self.width = width
        self.height = height
        self.frame_rate = frame_rate
        self.size = size

    def __repr__(self) -> str:
        if self.kind == "video":
            return f"<video {self.width}x{self.height} {self.codec} {self.bandwidth//1000}kbps>"
        return f"<audio {self.codec} {self.bandwidth//1000}kbps>"


class Media:
    """一次播放所需的全部信息：标题、音轨、视频轨、分P/剧集。"""

    def __init__(self) -> None:
        self.bvid = ""
        self.aid = 0
        self.cid = 0
        self.ep_id = 0
        self.title = ""
        self.owner = ""
        self.cover = ""
        self.duration = 0
        self.pages: List[Dict[str, Any]] = []   # 分P
        self.audio: List[Track] = []
        self.video: List[Track] = []
        self.durl: List[Dict[str, Any]] = []    # 非 DASH 时的单文件流
        self.accept_quality: List[int] = []
        self.current_quality: int = 0
        self.warnings: List[str] = []
        self.kind = "video"                     # video | bangumi

    def best_audio(self) -> Optional[Track]:
        return max(self.audio, key=lambda t: t.bandwidth) if self.audio else None

    def pick_video(self, prefer: str = "avc", max_height: int = 0,
                   max_qid: int = 0) -> Optional[Track]:
        pool = list(self.video)
        if not pool:
            return None
        if max_qid:
            pool = [t for t in pool if t.qid <= max_qid] or pool
        if max_height:
            pool = [t for t in pool if (t.height or 0) <= max_height] or pool
        top_q = max(t.qid for t in pool)
        pool = [t for t in pool if t.qid == top_q]        # 先取最高清晰度
        if prefer != "any":
            ranked = {c: i for i, c in enumerate(CODEC_PREF)}
            def key(t: Track) -> Tuple[int, int]:
                fam = next((i for i, c in enumerate(CODEC_PREF) if t.codec.startswith(c)),
                           len(CODEC_PREF))
                return (fam, -t.bandwidth)
            best = min(pool, key=key)
            return best
        return max(pool, key=lambda t: t.bandwidth)

    def quality_label(self, qid: Optional[int] = None) -> str:
        q = qid if qid is not None else self.current_quality
        return QUALITY_NAMES.get(q, f"Q{q}")


def _total_from_range(content_range: Optional[str]) -> int:
    """从 `bytes 0-1023/5408198` 里取出总长度，用于判断流是否取完。"""
    if not content_range or "/" not in content_range:
        return 0
    tail = content_range.rsplit("/", 1)[-1].strip()
    return int(tail) if tail.isdigit() else 0


def _mk_track(kind: str, d: Dict[str, Any]) -> Track:
    base = d.get("baseUrl") or d.get("base_url") or ""
    backup = d.get("backupUrl") or d.get("backup_url") or []
    return Track(
        kind=kind, url=base, backup=backup,
        codec=(d.get("codecs") or d.get("codec") or ""),
        qid=int(d.get("id") or 0),
        bandwidth=int(d.get("bandwidth") or 0),
        width=int(d.get("width") or 0),
        height=int(d.get("height") or 0),
        frame_rate=str(d.get("frameRate") or d.get("frame_rate") or ""),
        size=int(d.get("size") or 0),
    )


def _collect_audio(dash: Dict[str, Any]) -> List[Track]:
    out = [_mk_track("audio", a) for a in (dash.get("audio") or [])]
    # 杜比 / 无损音轨也算可选音轨
    for key in ("dolby", "flac"):
        node = dash.get(key)
        if isinstance(node, dict):
            for a in (node.get("audio") or []):
                t = _mk_track("audio", a)
                if t.url:
                    out.append(t)
    seen, uniq = set(), []
    for t in out:
        if t.url and t.url not in seen:
            seen.add(t.url)
            uniq.append(t)
    return uniq


def resolve(client: Client, target: str, *, quality: str = "auto",
            pn: int = 1, prefer_codec: str = "avc", max_height: int = 0,
            log: Optional[Log] = None) -> Media:
    """把 BV 号 / av 号 / 链接 / 剧集号 解析成可播放的 Media。"""
    log = log or Log()
    ref = parse_target(target)
    m = Media()

    if ref["kind"] == "episode":
        r = client.playurl_pgc(ep_id=ref["ep_id"], qn=QUALITY_ALIASES.get(quality, 0))
        data = r.get("data") or {}
        if r.get("code") != 0 or not (data.get("dash") or data.get("durl")):
            raise RuntimeError(f"取流失败（剧集 ep{ref['ep_id']}）：{r.get('message')}")
        m.kind = "bangumi"
        m.ep_id = ref["ep_id"]
        m.title = data.get("title") or f"ep{ref['ep_id']}"
        _fill_streams(m, data)
        m.bvid = ref.get("bvid", "")
        return m

    v = client.view(bvid=ref.get("bvid"), aid=ref.get("aid"))
    if v.get("code") != 0:
        raise RuntimeError(f"视频信息获取失败：{v.get('message')}")
    vd = v["data"]
    pages = vd.get("pages") or []
    m.bvid = vd.get("bvid") or ""
    m.aid = int(vd.get("aid") or 0)
    m.title = vd.get("title") or ""
    m.owner = ((vd.get("owner") or {}).get("name")) or ""
    m.cover = vd.get("pic") or ""
    m.duration = int(vd.get("duration") or 0)
    m.pages = pages
    if not pages:
        raise RuntimeError("该视频没有可播放的分P")

    idx = min(max(pn - 1, 0), len(pages) - 1)
    page = pages[idx]
    if pn - 1 >= len(pages):
        m.warnings.append(f"分P 只有 {len(pages)} 个，已回退到第 {len(pages)} P")
    m.cid = int(page.get("cid") or 0)
    if len(pages) > 1:
        m.title = f"{m.title} · P{idx+1} {page.get('part') or ''}".strip()
    # 多P 时进度条应跟随当前分P 的时长，而不是整部合集
    if page.get("duration"):
        m.duration = int(page["duration"])

    r = client.playurl(bvid=m.bvid, cid=m.cid, qn=QUALITY_ALIASES.get(quality, 0))
    if r.get("code") != 0:
        raise RuntimeError(f"取流失败：{r.get('message')}")
    _fill_streams(m, r.get("data") or {})
    return m


def _fill_streams(m: Media, data: Dict[str, Any]) -> None:
    m.accept_quality = [int(q) for q in (data.get("accept_quality") or [])]
    m.current_quality = int(data.get("quality") or 0)
    dash = data.get("dash") or {}
    if dash:
        m.audio = _collect_audio(dash)
        m.video = [_mk_track("video", v) for v in (dash.get("video") or [])]
    if not m.audio and not m.video:
        durl = data.get("durl") or []
        if durl:
            m.durl = durl
    if not m.audio and not m.durl and not m.video:
        raise RuntimeError("该视频没有返回任何可用流（可能是付费/地区限制内容）")
    if m.duration == 0:
        for d in (m.durl or []):
            if d.get("length"):
                m.duration = max(m.duration, int(d["length"]) // 1000)


# --------------------------------------------------------------------------
# 输入解析
# --------------------------------------------------------------------------
_BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")
_AV_RE = re.compile(r"av(\d+)", re.I)
_EP_RE = re.compile(r"ep(\d+)", re.I)


def parse_target(raw: str) -> Dict[str, Any]:
    """支持 BV 号��av 号、完整链接、b23.tv 短链、ep 号。"""
    s = (raw or "").strip()
    if not s:
        raise ValueError("请输入视频地址、BV 号或关键词")
    if s.startswith("http://") or s.startswith("https://"):
        # 从 URL 里抠出标识
        ep = _EP_RE.search(s)
        if ep and "/bangumi/" in s:
            return {"kind": "episode", "ep_id": int(ep.group(1))}
        bv = _BV_RE.search(s)
        if bv:
            return {"kind": "video", "bvid": bv.group(1)}
        av = _AV_RE.search(s)
        if av:
            return {"kind": "video", "aid": int(av.group(1))}
        return {"kind": "url", "url": s}
    m = _BV_RE.search(s)
    if m:
        return {"kind": "video", "bvid": m.group(1)}
    m = _AV_RE.fullmatch(s)
    if m:
        return {"kind": "video", "aid": int(m.group(1))}
    m = _EP_RE.fullmatch(s)
    if m:
        return {"kind": "episode", "ep_id": int(m.group(1))}
    if s.startswith("BV") or s.isdigit():
        return {"kind": "video", "bvid": s}
    return {"kind": "keyword", "keyword": s}


# --------------------------------------------------------------------------
# 本地流代理：让播放器经此取流，上游则始终是 Chrome 指纹
# --------------------------------------------------------------------------
class StreamProxy:
    """
    上游 CDN 请求全部由 Client（Chrome 指纹）代发，播放器只连本机 127.0.0.1。
    这样播放器的 Seek（Range 请求）也能被正确转发，同时上游看不到裸 curl/ffmpeg。
    """

    def __init__(self, client: Client, tracks: Dict[str, Track], log: Log,
                 stats: Stats, speed: float = 1.0, chunk: int = 262144,
                 tee: Optional[Dict[str, Any]] = None):
        self.client = client
        self.tracks = tracks
        self.log = log
        self.stats = stats
        self.speed = speed
        self.chunk = chunk
        # tee: {track: {"path": Path, "handle": file, "written": int}}
        # 把同一份字节同时交给播放器和磁盘，避免二次下载（更贴近浏览器单次取流）
        self.tee: Dict[str, Dict[str, Any]] = dict(tee or {})
        self._server: Optional[socketserver.ThreadingTCPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._last_activity = time.time()
        self.port = 0
        self._throttle_lock = threading.Lock()
        self._next_send = 0.0

    @property
    def idle_seconds(self) -> float:
        return time.time() - self._last_activity

    def url_for(self, track: str) -> str:
        return f"http://127.0.0.1:{self.port}/{track}.m4s"

    def start(self) -> None:
        proxy = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "bilicli/1.0"
            sys_version = ""

            def log_message(self, *args):  # 静音
                pass

            def do_HEAD(self):
                self._serve(head_only=True)

            def do_GET(self):
                self._serve(head_only=False)

            def _serve(self, head_only: bool):
                name = self.path.lstrip("/").split("?")[0].replace(".m4s", "")
                track = proxy.tracks.get(name)
                if track is None:
                    self.send_error(404, "unknown track")
                    return
                proxy._last_activity = time.time()
                rng = self.headers.get("Range")
                upstream_headers = {"referer": "https://www.bilibili.com/", "accept": "*/*"}
                if rng:
                    upstream_headers["range"] = rng
                resp = None
                last_err: Optional[Exception] = None
                for url in [track.url] + track.backup:
                    try:
                        resp = proxy.client.s.get(url, headers=upstream_headers,
                                                  timeout=30, stream=True)
                        # 2xx 正常；416 表示 Range 超出末尾，同样是有效语义，需��传
                        if resp.status_code < 400 or resp.status_code == 416:
                            break
                        resp.close()
                        last_err = RuntimeError(f"HTTP {resp.status_code}")
                        resp = None
                    except Exception as exc:
                        last_err = exc
                        resp = None
                if resp is None:
                    proxy.stats.note_error(f"{name}: {last_err}")
                    self.send_error(502, "upstream failed")
                    return
                proxy.stats.hit(name)
                try:
                    self.send_response(resp.status_code)
                    for hk in ("content-type", "content-length", "content-range"):
                        if hk in resp.headers:
                            self.send_header(hk.title(), resp.headers[hk])
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()
                    if head_only:
                        return
                    slot = proxy.tee.get(name)
                    for chunk in resp.iter_content(proxy.chunk):
                        if not chunk:
                            continue
                        self.wfile.write(chunk)
                        proxy.stats.add(name, len(chunk))
                        proxy._pace(len(chunk))
                        _t = time.time()
                        proxy._last_activity = _t
                        if slot is not None:
                            try:
                                slot["handle"].write(chunk)
                                slot["written"] += len(chunk)
                            except Exception as exc:
                                proxy.stats.note_error(f"{name} 写入本地失败: {exc}")
                                slot["handle"] = None
                                proxy.tee.pop(name, None)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # 播放器 Seek/退出，正常现象
                except Exception as exc:
                    proxy.stats.note_error(f"{name} 传输中断: {exc}")
                finally:
                    try:
                        resp.close()
                    except Exception:
                        pass

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        # 端口固定在 12000-12999 段里挑一个可用的，便于复现
        for port in range(12000, 13000):
            try:
                self._server = Server(("127.0.0.1", port), Handler)
                self.port = port
                break
            except OSError:
                continue
        if self._server is None:
            raise RuntimeError("找不到可用本地端口")
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        kwargs={"poll_interval": 0.3}, daemon=True)
        self._thread.start()
        self.log.debug(f"本地流代理 127.0.0.1:{self.port}")

    def _pace(self, n: int) -> None:
        """按 speed 倍速限流：>1 表示比真实播放更快地拉流。"""
        if self.speed <= 0 or self.speed == 1.0:
            return
        with self._throttle_lock:
            now = time.time()
            if self._next_send < now:
                self._next_send = now
            self._next_send += n / (self.speed * 1_000_000)  # 按 1MB/s 基准缩放
            wait = self._next_send - time.time()
        if wait > 0:
            time.sleep(min(wait, 0.5))

    def stop(self) -> None:
        if self._server:
            try:
                self._server.shutdown()
                self._server.server_close()
            except Exception:
                pass
        self._server = None


# --------------------------------------------------------------------------
# 播放器
# --------------------------------------------------------------------------
class Player:
    def __init__(self, client: Client, media: Media, *, log: Log, volume: int = 100,
                 browser_mode: bool = True, video_mode: str = "stream",
                 prefer_codec: str = "avc", max_height: int = 0, max_qid: int = 0,
                 start_at: float = 0.0, speed: float = 1.0, extra_args: Optional[List[str]] = None):
        self.client = client
        self.media = media
        self.log = log
        self.volume = max(0, min(100, volume))
        self.browser_mode = browser_mode
        self.video_mode = video_mode          # stream | off | realtime
        self.start_at = max(0.0, start_at)
        self.speed = speed
        self.extra_args = list(extra_args or [])
        self.stats = Stats()
        self.audio = media.best_audio()
        self.video = media.pick_video(prefer=prefer_codec, max_height=max_height, max_qid=max_qid)
        self.proxy: Optional[StreamProxy] = None
        self._ffplay: Optional[subprocess.Popen] = None
        self._stop = threading.Event()
        self._video_thread: Optional[threading.Thread] = None
        self.video_plan_bytes = 0

    # ---- 播放器可执行文件 ----
    @staticmethod
    def find_player() -> Tuple[str, str]:
        for name, mode in (("ffplay", "ffplay"), ("mpv", "mpv")):
            path = shutil.which(name)
            if path:
                return path, mode
        raise RuntimeError(
            "找不到播放器。请安装 ffmpeg（含 ffplay）或 mpv：\n"
            "  brew install ffmpeg        # 或 brew install mpv"
        )

    def _build_cmd(self, exe: str, mode: str, url: str) -> List[str]:
        if mode == "ffplay":
            cmd = [exe, "-hide_banner", "-loglevel", "warning", "-nodisp",
                   "-autoexit", "-volume", str(self.volume)]
            if self.start_at > 0:
                cmd += ["-ss", f"{self.start_at:.3f}"]
            if self.speed != 1.0:
                cmd += ["-af", f"atempo={self.speed:.3f}"]
            cmd += self.extra_args
            cmd += ["-i", url]
            return cmd
        # mpv：--no-video 就是"只听声音"，同样走本地代理
        cmd = [exe, "--no-video", "--really-quiet", "--no-terminal",
               f"--volume={self.volume}"]
        if self.start_at > 0:
            cmd += [f"--start={self.start_at:.3f}"]
        if self.speed != 1.0:
            cmd += [f"--speed={self.speed:.3f}"]
        cmd += self.extra_args + [url]
        return cmd

    # ---- 视频轨后台拉取：让流量构成和网页播放器一致 ----
    def _video_puller(self) -> None:
        """按视频轨真实码率在后台持续取流（数据丢弃不显示）。"""
        if self.video is None:
            return
        url = self.proxy.url_for("video")
        target_bps = max(self.video.bandwidth, 100_000) / 8.0     # bytes/s
        # 浏览器会先把缓冲区填满（突发下载），之后随播放进度补充。
        # lead = 允许领先播放进度多少秒的缓冲，模拟网页播放器的预取深度。
        lead = min(12.0, max(4.0, (self.media.duration or 60) * 0.05))
        got = 0
        started = time.time()
        headers = {"accept": "*/*"}
        # 分片大小参考浏览器 MSE 取流：通常是几十~几百 KB 一段，
        # 而不是把整条轨一次拖走；节流靠"取满后等待"，而不是缩小每次请求。
        seg_bytes = int(min(524288, max(262144, target_bps * 8)))
        offset = 0
        fails = 0
        while not self._stop.is_set():
            if self.video.size and offset >= self.video.size:
                return                         # 已取完整条轨，正常收工
            elapsed = (time.time() - started) * self.speed
            allowed = (lead + elapsed) * target_bps
            if got >= allowed:
                time.sleep(0.25)
                continue
            n = seg_bytes
            if self.video.size:
                n = min(n, self.video.size - offset)
            if n <= 0:
                return
            end = offset + n - 1
            try:
                r = self.client.s.get(
                    url,
                    headers={**headers, "range": f"bytes={offset}-{end}"},
                    timeout=30, stream=True,
                )
                if r.status_code == 416:
                    r.close()
                    return                     # 已到流末尾，正常结束
                if r.status_code >= 400:
                    r.close()
                    raise RuntimeError(f"HTTP {r.status_code}")
                if not self.video.size:
                    self.video.size = _total_from_range(r.headers.get("content-range"))
                chunk_total = 0
                for chunk in r.iter_content(65536):
                    if self._stop.is_set():
                        break
                    chunk_total += len(chunk)
                    got += len(chunk)   # 字节由本地代理统一计数，避免重复统计
                r.close()
                offset += max(chunk_total, n)
                self.video_plan_bytes = offset
                fails = 0
            except Exception as exc:
                fails += 1
                self.stats.note_error(f"视频轨: {exc}")
                if fails >= 4:
                    self.log.warn(f"视频轨拉取连续失败，已停止：{exc}")
                    return
                time.sleep(1.0)
            time.sleep(0.05)

    # ---- 实时下载模式：真正把视频存下来，节奏同浏览器 ----
    def _realtime_download(self, out_path: Path) -> None:
        if self.video is None:
            self.log.warn("没有视频轨（该清晰度可能不提供 DASH），跳过视频下载")
            return
        url = self.proxy.url_for("video")
        target_bps = max(self.video.bandwidth, 100_000) / 8.0
        total = self.video.size or 0
        written = 0
        started = time.time()
        offset = 0
        seg = 1 << 20
        with open(out_path, "wb") as fh:
            while not self._stop.is_set():
                # speed 同时作用于播放速度与下载速度，两者保持同一节奏
                allowed = ((time.time() - started) * self.speed + 4.0) * target_bps
                if written >= allowed:
                    time.sleep(0.15)
                    continue
                end = offset + seg - 1
                if total and offset >= total:
                    break
                try:
                    r = self.client.s.get(
                        url, headers={"accept": "*/*", "range": f"bytes={offset}-{end}"},
                        timeout=30, stream=True,
                    )
                    if r.status_code == 416:
                        r.close()
                        break                  # 已取完，正常结束
                    if r.status_code >= 400:
                        r.close()
                        raise RuntimeError(f"HTTP {r.status_code}")
                    if not total:
                        total = _total_from_range(r.headers.get("content-range"))
                    n = 0
                    for chunk in r.iter_content(65536):
                        if self._stop.is_set():
                            break
                        fh.write(chunk)
                        written += len(chunk)
                        n += len(chunk)   # 字节由本地代理统一计数
                    r.close()
                    if n == 0:
                        break
                    offset += n
                except Exception as exc:
                    self.stats.note_error(f"视频下载: {exc}")
                    time.sleep(1.0)
        self.log.info(f"  视频轨已保存 {human_bytes(written)} -> {out_path}")

    # ---- 进度显示 ----
    def _progress(self) -> None:
        dur = self.media.duration or 0
        start = time.time()
        while not self._stop.is_set():
            el = self.start_at + (time.time() - start) * self.speed
            aud = self.stats.bytes["audio"]
            vid = self.stats.bytes["video"]
            if dur:
                pct = min(100.0, el / dur * 100)
                bar_n = 24
                fill = int(bar_n * pct / 100)
                bar = "█" * fill + "─" * (bar_n - fill)
                head = f"{bar} {pct:5.1f}%  {human_time(el)}/{human_time(dur)}"
            else:
                head = f"{human_time(el)}"
            tail = (f"  音频 {human_bytes(aud):>8}"
                    + (f"  视频 {human_bytes(vid):>8}" if self.browser_mode else "")
                    + f"  {human_bytes(aud+vid)} @ {(aud+vid)*8/self.stats.elapsed/1e6:.2f} Mbps")
            line = f"\r  {head}{tail}"
            sys.stdout.write(line[:200].ljust(min(len(line), 200)))
            sys.stdout.flush()
            if self._ffplay and self._ffplay.poll() is not None:
                break
            if dur and el >= dur + 1:
                break
            time.sleep(0.5)
        sys.stdout.write("\r" + " " * 100 + "\r")
        sys.stdout.flush()

    # ---- 主流程 ----
    def run(self) -> int:
        if self.audio is None:
            raise RuntimeError("该视频没有可用音轨")
        exe, mode = self.find_player()
        tracks: Dict[str, Track] = {"audio": self.audio}
        if self.video is not None:
            tracks["video"] = self.video
        self.proxy = StreamProxy(self.client, tracks, self.log, self.stats)
        self.proxy.start()

        m = self.media
        print()
        print(C.bold(f"  {m.title[:66]}"))
        meta = []
        if m.owner:
            meta.append(f"UP: {m.owner}")
        meta.append(f"时长 {human_time(m.duration)}" if m.duration else "时长未知")
        meta.append(f"音频 {self.audio.codec or '?'} {self.audio.bandwidth//1000}kbps")
        if self.video is not None:
            meta.append(f"视频 {self.video.width}x{self.video.height} "
                        f"{self.video.codec} {self.video.bandwidth//1000}kbps")
        print(C.dim("  " + " · ".join(meta)))
        print(C.dim(f"  播放器 {Path(exe).name} · 流经本地代理 127.0.0.1:{self.proxy.port}"
                    f" · 上游 Chrome 指纹 {self.client.impersonate}"))
        mode_desc = {
            "stream": C.green("模拟浏览器拉流（视频轨按实时码率取流后丢弃）"),
            "realtime": C.green("模拟浏览器播放并保存视频"),
            "audio": C.yellow("仅音频（流量明显小于浏览器，隐蔽性略低）"),
        }.get(self.video_mode, C.yellow(self.video_mode))
        print(f"  流量模式 {mode_desc}")
        if self.client.logged_in:
            print(C.dim(f"  已登录：{self.client.uname()}（可用 1080P+ 等高清晰度）"))
        else:
            print(C.dim("  未登录：清晰度上限通常为 480P/360P，"
                        "用 `bilicli login` 导入浏览器 Cookie 可解锁 1080P"))
        print()

        cmd = self._build_cmd(exe, mode, self.proxy.url_for("audio"))
        self.log.debug("执行: " + " ".join(cmd[:8]) + " ...")

        down_dir: Optional[Path] = None
        if self.video_mode == "realtime":
            down_dir = Path(tempfile.mkdtemp(prefix="bilicli-"))
            # 音频不重复下载：在代理层把播放用的同一份字节旁路写入磁盘
            try:
                afh = open(down_dir / "audio.m4s", "wb")
                self.proxy.tee["audio"] = {"handle": afh, "written": 0,
                                           "path": down_dir / "audio.m4s"}
                self._audio_handle = afh
            except Exception as exc:
                self.log.warn(f"无法创建音频输出：{exc}")
            self._video_thread = threading.Thread(
                target=self._realtime_download, args=(down_dir / "video.m4s",), daemon=True)

        rc = 0
        try:
            self._ffplay = subprocess.Popen(cmd, stdin=subprocess.DEVNULL)
            if self.video_mode == "stream" and self.video is not None:
                self._video_thread = threading.Thread(target=self._video_puller, daemon=True)
            if self._video_thread:
                self._video_thread.start()
            prog = threading.Thread(target=self._progress, daemon=True)
            prog.start()
            rc = self._ffplay.wait()
            if rc == 0:
                # 音频放完了，等视频轨把剩余缓冲拉完（浏览器也这样）
                if self._video_thread and self._video_thread.is_alive():
                    self._video_thread.join(timeout=20)
        except KeyboardInterrupt:
            print()
        finally:
            self._stop.set()
            if self._ffplay and self._ffplay.poll() is None:
                self._ffplay.terminate()
                try:
                    self._ffplay.wait(timeout=3)
                except Exception:
                    self._ffplay.kill()
            if self._video_thread:
                self._video_thread.join(timeout=5)
            self.proxy.stop()
            fh = getattr(self, "_audio_handle", None)
            if fh is not None:
                try:
                    fh.flush()
                    fh.close()
                except Exception:
                    pass

        print(self.stats.summary())
        if self.video_mode == "realtime" and down_dir:
            vid = down_dir / "video.m4s"
            aud = down_dir / "audio.m4s"
            slot = self.proxy.tee.get("audio") or {}
            if slot.get("written"):
                self.log.info(f"  音频轨已保存 {human_bytes(slot['written'])} -> {aud}")
            self.log.info(f"  正在合并 A/V -> {down_dir}/output.mp4")
            self._mux(aud, vid, down_dir / "output.mp4")
        return 0 if rc in (0, 1) else rc

    def _mux(self, audio_path: Path, video_path: Path, out: Path) -> None:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.log.warn("未找到 ffmpeg，保留原始音视频文件未合并")
            return
        have_a = audio_path.exists() and audio_path.stat().st_size > 0
        have_v = video_path.exists() and video_path.stat().st_size > 0
        if not (have_a or have_v):
            self.log.warn("没有可合并的流")
            return
        try:
            if have_a and have_v:
                cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(video_path),
                       "-i", str(audio_path), "-c", "copy", "-movflags", "+faststart",
                       str(out)]
            else:                                  # 只有视频轨：补一条静音音轨
                cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(video_path),
                       "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                       "-shortest", "-c:v", "copy", "-c:a", "aac",
                       "-movflags", "+faststart", str(out)]
            subprocess.run(cmd, check=True)
            size = out.stat().st_size
            self.log.info(C.green(f"  ✓ 已合并: {out}  ({human_bytes(size)})"))
            self.log.info(C.dim(f"    临时目录: {out.parent}"))
        except Exception as exc:
            self.log.warn(f"合并失败：{exc}")


# --------------------------------------------------------------------------
# 子命令
# --------------------------------------------------------------------------
def _fmt_count(n: Any) -> str:
    try:
        n = int(n)
    except Exception:
        return str(n or "")
    if n >= 100_000_000:
        return f"{n/100_000_000:.1f}亿"
    if n >= 10_000:
        return f"{n/10_000:.1f}万"
    return str(n)


def cmd_search(args, client: Client, log: Log) -> int:
    r = client.search(args.keyword, page=args.page, page_size=args.limit)
    data = r.get("data") or {}
    items = data.get("result") or []
    if r.get("code") != 0 or not items:
        if data.get("v_voucher"):
            log.error("搜索接口触发了 B 站风控（v_voucher）。稍后重试，或直接用 BV 号/链接播放。")
        else:
            log.error(f"搜索失败：{r.get('message') or '无结果'}")
        return 1
    print()
    print(C.bold(f"  搜索 “{args.keyword}”  "
                 f"共 {_fmt_count(data.get('numResults'))} 条，显示第 {args.page} 页"))
    print()
    for i, it in enumerate(items, 1):
        title = re.sub(r"<[^>]+>", "", it.get("title") or "").strip()
        bvid = it.get("bvid") or ""
        dur = it.get("duration") or ""
        print(f"  {C.cyan(f'{i:>2}')}. {title[:60]}")
        print(C.dim(f"      {bvid}  UP: {it.get('author') or '?'}  "
                    f"时长 {dur}  播放 {_fmt_count(it.get('play'))}  "
                    f"弹幕 {_fmt_count(it.get('video_review'))}"))
    print()
    print(C.dim(f"  播放：bilicli play {items[0].get('bvid')}"))
    return 0


def cmd_info(args, client: Client, log: Log) -> int:
    ref = parse_target(args.target)
    if ref["kind"] == "keyword":
        r = client.search(ref["keyword"], page=1, page_size=1)
        items = (r.get("data") or {}).get("result") or []
        if not items:
            log.error("没有找到匹配的视频")
            return 1
        ref = {"kind": "video", "bvid": items[0].get("bvid")}
        log.info(C.dim(f"  匹配到 {ref['bvid']}"))
    if ref["kind"] == "episode":
        r = client.playurl_pgc(ep_id=ref["ep_id"])
        d = r.get("data") or {}
        print()
        print(C.bold(f"  {d.get('title') or ref}"))
        print(C.dim(f"  剧集 ep{ref['ep_id']}  时长 {human_time(int(d.get('timelength') or 0)//1000)}"))
        return 0
    v = client.view(bvid=ref.get("bvid"), aid=ref.get("aid"))
    if v.get("code") != 0:
        log.error(f"获取失败：{v.get('message')}")
        return 1
    d = v["data"]
    st = d.get("stat") or {}
    print()
    print(C.bold(f"  {d.get('title')}"))
    print(C.dim(f"  {d.get('bvid')}  av{d.get('aid')}"))
    print(f"  UP: {((d.get('owner') or {}).get('name'))}   "
          f"时长 {human_time(int(d.get('duration') or 0))}   "
          f"分区 {d.get('tname')}")
    print(f"  播放 {_fmt_count(st.get('view'))}  "
          f"弹幕 {_fmt_count(st.get('danmaku'))}  "
          f"点赞 {_fmt_count(st.get('like'))}  "
          f"投币 {_fmt_count(st.get('coin'))}  "
          f"收藏 {_fmt_count(st.get('favorite'))}")
    print(C.dim(f"  {d.get('pubdate') and time.strftime('%Y-%m-%d %H:%M', time.localtime(int(d['pubdate'])))}"))
    desc = (d.get("desc") or "").strip().replace("\n", " ")
    if desc:
        print(C.dim(f"  简介: {desc[:160]}"))
    pages = d.get("pages") or []
    if len(pages) > 1:
        print(f"\n  分P（{len(pages)} 个）:")
        for i, p in enumerate(pages, 1):
            print(f"    P{i}  {human_time(int(p.get('duration') or 0))}  {p.get('part')}")
    print()
    print(C.dim(f"  播放：bilicli play {d.get('bvid')}"))
    return 0


def cmd_play(args, client: Client, log: Log) -> int:
    ref = parse_target(args.target)
    if ref["kind"] == "keyword":
        r = client.search(ref["keyword"], page=1, page_size=1)
        items = (r.get("data") or {}).get("result") or []
        if not items:
            log.error(f"没有找到 “{ref['keyword']}” 对应的视频，可先用 bilicli search")
            return 1
        ref = {"kind": "video", "bvid": items[0].get("bvid")}
        log.info(C.dim(f"  匹配到 {ref['bvid']}"))
    target = ref.get("bvid") or (f"ep{ref['ep_id']}" if ref.get("ep_id") else "")
    if not target:
        log.error("无法识别的视频标识")
        return 1

    media = resolve(client, target, quality=args.quality, pn=args.page,
                    prefer_codec=args.codec, max_height=args.max_height, log=log)
    for w in media.warnings:
        log.warn(w)

    # 清晰度回退提示
    if media.accept_quality:
        best_avail = max(media.accept_quality)
        if args.quality != "auto":
            want = QUALITY_ALIASES.get(args.quality, 0)
            if want and media.current_quality < want:
                log.warn(f"请求 {QUALITY_NAMES.get(want, want)}，实际拿到 "
                         f"{media.quality_label()}（未登录或该视频不提供更高清晰度）")

    if not args.quiet and media.video:
        v = media.pick_video(prefer=args.codec, max_height=args.max_height)
        if v:
            log.debug(f"选中视��轨 {v.width}x{v.height} {v.codec} "
                      f"{v.bandwidth//1000}kbps（可选 {len(media.video)} 条）")

    player = Player(
        client, media, log=log, volume=args.volume,
        browser_mode=(args.mode != "audio"),
        video_mode=args.mode, prefer_codec=args.codec,
        max_height=args.max_height, start_at=args.start, speed=args.speed,
        extra_args=args.player_arg,
    )
    return player.run()


def cmd_login(args, client: Client, log: Log) -> int:
    """导入登录凭据，解锁 1080P 等高清晰度。"""
    raw = getattr(args, "cookie", None)
    if raw:
        jar = parse_cookie_string(raw)
        if not jar.get("SESSDATA"):
            log.error("未识别到 SESSDATA，请检查输入")
            return 1
        if not save_cookies(jar, "手动输入", log):
            return 1
        log.info(C.dim(f"  已写入 {len(jar)} 个 Cookie"))
    else:
        jar = import_browser_cookies(log)
        if not jar:
            log.error("没能自动导入。可手动指定：\n"
                      "  bilicli login --cookie 'SESSDATA=xxx; bili_jct=yyy'\n"
                      "  （浏览器 F12 -> Application -> Cookies -> "
                      "https://www.bilibili.com 里复制）")
            return 1
    new = Client(impersonate=client.impersonate, log=log)
    if new.logged_in:
        log.info(C.green(f"  ✓ 已登录：{new.uname()}"))
        # 顺带验证高清晰度是否解锁
        try:
            v = new.view(bvid="BV1GJ411x7h7")
            cid = v["data"]["pages"][0]["cid"]
            d = (new.playurl(bvid="BV1GJ411x7h7", cid=cid, qn=80) or {}).get("data") or {}
            q = d.get("quality")
            log.info(C.dim(f"  可用清晰度: {', '.join(QUALITY_NAMES.get(x, str(x)) for x in (d.get('accept_quality') or [])[:5])}"))
            if q:
                log.info(C.green(f"  ✓ 当前取流清晰度 {QUALITY_NAMES.get(q, q)}"))
        except Exception as exc:
            log.debug(f"清晰度探测失败: {exc}")
        return 0
    log.warn("已导入 Cookie，但 B 站未识别为登录状态（SESSDATA 可能已过期）")
    return 1


def _read_firefox_cookies() -> Dict[str, str]:
    """Firefox 的 cookies.sqlite（无加密，可直读）。"""
    root = HOME / "Library/Application Support/Firefox/Profiles"
    if not root.exists():
        return {}
    wanted = {"SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "buvid3", "buvid4"}
    for prof in sorted(root.glob("*.default*")) + sorted(root.glob("*")):
        db = prof / "cookies.sqlite"
        if not db.exists():
            continue
        tmp = Path(tempfile.gettempdir()) / f"bili_ff_{os.getpid()}.sqlite"
        try:
            shutil.copy2(db, tmp)
            con = sqlite3.connect(tmp)
            try:
                rows = con.execute(
                    "SELECT name, value FROM moz_cookies WHERE host LIKE '%bilibili%'"
                ).fetchall()
            finally:
                con.close()
        except Exception:
            continue
        jar = {k: v for k, v in rows if k in wanted}
        if jar.get("SESSDATA"):
            return jar
    return {}


def _read_safari_cookies() -> Dict[str, str]:
    """Safari 的二进制 Cookie 库（需要终端具备完全磁盘访问权限）。"""
    path = HOME / "Library/Cookies/Cookies.binarycookies"
    if not path.exists():
        return {}
    try:
        blob = path.read_bytes()
    except Exception:
        return {}
    wanted = {"SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "buvid3", "buvid4"}
    jar: Dict[str, str] = {}
    if not blob.startswith(b"cook"):
        return {}
    try:
        n_pages = int.from_bytes(blob[4:8], "big")
        pos = 8
        page_sizes = [int.from_bytes(blob[pos + 4 * i: pos + 4 * i + 4], "big")
                      for i in range(n_pages)]
        pos += 4 * n_pages
        for size in page_sizes:
            page = blob[pos: pos + size]
            pos += size
            n_cookies = int.from_bytes(page[0:4], "little")
            offsets = [int.from_bytes(page[4 + 4 * i: 8 + 4 * i], "little")
                       for i in range(n_cookies)]
            for off in offsets:
                rec = page[off:]
                clen = int.from_bytes(rec[0:4], "little")
                domain = rec[16:16 + clen].decode("utf-8", "ignore")
                p = 16 + clen
                nlen = int.from_bytes(rec[p:p + 4], "little"); p += 4
                name = rec[p:p + nlen].decode("utf-8", "ignore"); p += nlen
                vlen = int.from_bytes(rec[p:p + 4], "little"); p += 4
                value = rec[p:p + vlen].decode("utf-8", "ignore")
                if "bilibili" in domain and name in wanted:
                    jar[name] = value
    except Exception:
        return {}
    return jar


def parse_cookie_string(raw: str) -> Dict[str, str]:
    """解析 `SESSDATA=xxx; bili_jct=yyy` 或纯 SESSDATA 值。"""
    out: Dict[str, str] = {}
    raw = (raw or "").strip()
    if not raw:
        return out
    if "=" not in raw:
        return {"SESSDATA": raw}
    for part in re.split(r"[;\n]", raw):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        out[k.strip()] = v.strip().strip('"')
    return out


def save_cookies(jar: Dict[str, str], source: str, log: Log) -> bool:
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        COOKIE_FILE.write_text(
            json.dumps({"cookies": jar, "from": source}, ensure_ascii=False, indent=1),
            "utf-8")
        os.chmod(COOKIE_FILE, 0o600)
        return True
    except Exception as exc:
        log.error(f"写入失败：{exc}")
        return False


def import_browser_cookies(log: Log) -> Dict[str, str]:
    """依次尝试 Firefox / Chromium 系 / Safari。"""
    for name, fn in (("Firefox", _read_firefox_cookies),
                     ("Chrome", None), ("Safari", _read_safari_cookies)):
        jar: Dict[str, str] = {}
        if name == "Chrome":
            jar = _read_chromium_cookies()
        else:
            jar = fn()  # type: ignore[misc]
        if jar.get("SESSDATA"):
            log.info(C.dim(f"  从 {name} 导��� {len(jar)} 个 Cookie"))
            if save_cookies(jar, name, log):
                return jar
    return {}


def _read_chromium_cookies() -> Dict[str, str]:
    bases = [
        HOME / "Library/Application Support/Google/Chrome",
        HOME / "Library/Application Support/Microsoft Edge",
        HOME / "Library/Application Support/BraveSoftware/Brave-Browser",
        HOME / "Library/Application Support/Chromium",
        HOME / "Library/Application Support/Vivaldi",
    ]
    wanted = {"SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "buvid3", "buvid4"}
    for base in bases:
        if not base.exists():
            continue
        for profile in sorted(base.glob("Profile *")) + [base / "Default"]:
            db = profile / "Cookies"
            if not db.exists():
                continue
            jar: Dict[str, str] = {}
            for attempt in ("uri", "copy"):
                try:
                    if attempt == "uri":
                        con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True)
                    else:
                        tmp = Path(tempfile.gettempdir()) / f"bili_ck_{os.getpid()}.db"
                        shutil.copy2(db, tmp)
                        con = sqlite3.connect(tmp)
                    try:
                        rows = con.execute(
                            "SELECT name, value FROM cookies WHERE host_key LIKE '%bilibili%'"
                        ).fetchall()
                    finally:
                        con.close()
                    jar = {k: v for k, v in rows if k in wanted}
                    break
                except Exception:
                    continue
            if jar.get("SESSDATA"):
                return jar
    return {}


def cmd_doctor(args, client: Client, log: Log) -> int:
    """自检：确认指纹、取流、播放器都正常。"""
    print()
    print(C.bold("  bilicli 自检"))
    print()
    ok = True

    # 1. 指纹
    try:
        r = client.s.get("https://tls.peet.ws/api/all", timeout=25).json()
        ja4 = (r.get("tls") or {}).get("ja4") or "?"
        akamai = ((r.get("http2") or {}).get("akamai_fingerprint")) or "?"
        ua = r.get("user_agent") or "?"
        h2 = (r.get("http2") or {}).get("akamai_fingerprint_hash") or ""
        chrome_like = ja4.startswith("t13d") and "h2" in ja4
        mark = C.green("✓") if chrome_like else C.yellow("!")
        print(f"  {mark} TLS 指纹 JA4 : {C.cyan(ja4)}")
        print(C.dim(f"      Akamai HTTP2 : {akamai}{'  hash ' + h2[:16] if h2 else ''}"))
        print(C.dim(f"      User-Agent   : {ua}"))
        print(C.dim("      → 上游看到的是标准 Chrome 客户端（TLS+HTTP2+头序 全部匹配）"))
    except Exception as exc:
        ok = False
        print(f"  {C.red('✗')} 指纹检测失败：{exc}")

    # 2. 设备指纹 Cookie
    ck = sorted(client.s.cookies.keys())
    need = {"buvid3", "buvid4"}
    have = need & set(ck)
    mark = C.green("✓") if have == need else C.yellow("!")
    print(f"  {mark} 设备 Cookie  : {', '.join(sorted(have)) or '无'}")
    if have != need:
        ok = False

    # 3. 取流
    try:
        v = client.view(bvid="BV1GJ411x7h7")
        cid = v["data"]["pages"][0]["cid"]
        r = client.playurl(bvid="BV1GJ411x7h7", cid=cid)
        d = r.get("data") or {}
        dash = d.get("dash") or {}
        print(f"  {C.green('✓')} 取流链路     : DASH 音频 {len(dash.get('audio') or [])} 条 / "
              f"视频 {len(dash.get('video') or [])} 条，当前 {QUALITY_NAMES.get(d.get('quality'), d.get('quality'))}")
        if not dash:
            ok = False
    except Exception as exc:
        ok = False
        print(f"  {C.red('✗')} 取流失败     : {exc}")

    # 4. CDN 分片（Range）
    try:
        t = client.view(bvid="BV1GJ411x7h7")
        cid = t["data"]["pages"][0]["cid"]
        d = client.playurl(bvid="BV1GJ411x7h7", cid=cid)["data"]["dash"]
        au = max(d["audio"], key=lambda a: a["bandwidth"])
        r = client.s.get(au["baseUrl"], headers={"range": "bytes=0-1023",
                                                 "accept": "*/*",
                                                 "referer": "https://www.bilibili.com/"},
                         timeout=20)
        good = r.status_code in (200, 206) and len(r.content) > 0
        mark = C.green("✓") if good else C.red("✗")
        print(f"  {mark} CDN 分片取流 : HTTP {r.status_code} {r.http_version} "
              f"{len(r.content)}B  {r.headers.get('content-range') or ''}")
        ok = ok and good
    except Exception as exc:
        ok = False
        print(f"  {C.red('✗')} CDN 分片失败 : {exc}")

    # 5. 播放器
    try:
        exe, _ = Player.find_player()
        print(f"  {C.green('✓')} 本地播放器   : {exe}")
    except Exception as exc:
        ok = False
        print(f"  {C.red('✗')} 播放器       : {exc}")

    # 6. 登录态
    if client.logged_in:
        print(f"  {C.green('✓')} 登录态       : {client.uname()}（1080P+ 可用）")
    else:
        print(f"  {C.yellow('!')} 登录态       : 未登录（通常上限 480P/360P）")
        print(C.dim("      执行 `bilicli login` 从本机浏览器导入 Cookie 即可解锁 1080P"))

    print()
    print(C.green("  全部通过：流量在运营商侧与浏览器观看 B 站视频一致。") if ok
          else C.yellow("  部分项目异常，见上方标记。"))
    print()
    return 0 if ok else 1


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="bilicli",
        description="命令行看 B 站：不显示画面，但网络流量与浏览器看视频一致。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  bilicli play BV1GJ411x7h7                  # 只听声音，后台拉视频轨伪装流量\n"
            "  bilicli play https://b23.tv/xxxxxx -q 1080p\n"
            "  bilicli play BV1xx411c7mD -p 3              # 第 3 个分P\n"
            "  bilicli play BV1xx411c7mD -m audio          # 只省流量：纯音频\n"
            "  bilicli play BV1xx411c7mD -m realtime       # 边播边存成 mp4\n"
            "  bilicli search 罗翔  -n 10\n"
            "  bilicli info BV1GJ411x7h7\n"
            "  bilicli login                              # 导入浏览器 Cookie 解锁 1080P\n"
            "  bilicli doctor                             # 自检指纹与播放链路\n"
        ),
    )
    p.add_argument("--version", action="version", version=f"bilicli {__version__}")
    p.add_argument("-v", "--verbose", action="store_true", help="输出调试信息")
    p.add_argument("--impersonate", default=os.environ.get("BILICLI_IMPERSONATE", "chrome"),
                   help="curl_cffi 浏览器指纹（默认 chrome，即最新 Chrome）")
    sub = p.add_subparsers(dest="command")

    sp = sub.add_parser("play", help="播放（默认只听声音 + 伪装视频流量）")
    sp.add_argument("target", help="BV 号 / av 号 / 视频链接 / b23.tv 短链 / 剧集 ep 号 / 关键词")
    sp.add_argument("-q", "--quality", default="auto",
                    choices=list(QUALITY_ALIASES.keys()),
                    help="清晰度（默认 auto；未登录通常最高 480P）")
    sp.add_argument("-p", "--page", type=int, default=1, help="分P 序号（从 1 开始）")
    sp.add_argument("-m", "--mode", default="stream", choices=["stream", "realtime", "audio"],
                    help="stream=模拟浏览器拉流(默认) realtime=同时保存为mp4 audio=纯音频")
    sp.add_argument("-vol", "--volume", type=int, default=100, help="音量 0-100（默认 100）")
    sp.add_argument("-ss", "--start", type=float, default=0.0, help="从第几秒开始")
    sp.add_argument("-r", "--speed", type=float, default=1.0, help="播放倍速")
    sp.add_argument("--codec", default="avc", choices=["avc", "av01", "hev1", "any"],
                    help="优先编码（默认 avc，最贴近网页默认）")
    sp.add_argument("--max-height", type=int, default=0, help="限制最大高度，如 720")
    sp.add_argument("--player-arg", action="append", default=[],
                    help="透传给播放器的额外参数（可多次）")
    sp.add_argument("--quiet", action="store_true", help="安静模式")

    ss = sub.add_parser("search", help="搜索视频")
    ss.add_argument("keyword")
    ss.add_argument("-n", "--limit", type=int, default=20, help="每页条数")
    ss.add_argument("-p", "--page", type=int, default=1)

    si = sub.add_parser("info", help="查看视频信息与分P")
    si.add_argument("target")

    sl = sub.add_parser("login", help="导入登录 Cookie（解锁 1080P 等高清晰度）")
    sl.add_argument("--cookie", default=None,
                    help="手动指定 Cookie 串，如 'SESSDATA=xxx; bili_jct=yyy'")
    sub.add_parser("doctor", help="自检指纹与播放链路")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0

    log = Log(verbose=getattr(args, "verbose", False),
              quiet=getattr(args, "quiet", False))
    try:
        client = Client(impersonate=args.impersonate, log=log)
    except Exception as exc:
        sys.stderr.write(f"初始化失败：{exc}\n")
        return 2

    handlers = {
        "play": cmd_play, "search": cmd_search, "info": cmd_info,
        "login": cmd_login, "doctor": cmd_doctor,
    }
    try:
        return handlers[args.command](args, client, log)
    except KeyboardInterrupt:
        print()
        return 130
    except Exception as exc:
        log.error(str(exc))
        if getattr(args, "verbose", False):
            import traceback
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
