#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
API Hub —— 多中转站聚合面板（本地版）

零第三方依赖，仅使用 Python 标准库。
- 通过 Base URL + 凭证，聚合多个 AI 中转站（New API / One API 系）的
  余额、用量、模型列表、令牌、调用日志等信息。
- 自动探测可用接口：优先「系统访问令牌」，退化为「sk- Key + 兼容计费接口」，
  最后退化为「仅模型列表」。
- 仅监听 127.0.0.1，配置保存在同目录 config.json。

用法:
    python server.py            # 启动并自动打开浏览器
    python server.py --port 8800
    python server.py --no-open  # 不自动打开浏览器
"""

import argparse
import gzip
import io
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
import uuid
import webbrowser
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# 路径与常量
# --------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
DATA_DIR = os.path.join(BASE_DIR, "data")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
CACHE_PATH = os.path.join(DATA_DIR, "snapshot.json")

DEFAULT_QUOTA_PER_USD = 500000  # New API 默认 1 USD = 500000 quota
DEFAULT_USD_CNY = 7.2          # 默认充值比：1 美元额度 = 7.2 元人民币（仅当站点未在 /api/status 暴露时使用）
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
# 探测时一次性抓取的历史天数上限；界面上的「时间范围」切换都从这里取子集
LOG_FETCH_DAYS = 120

DEFAULT_SETTINGS = {
    "quota_per_usd": DEFAULT_QUOTA_PER_USD,
    "usd_cny": DEFAULT_USD_CNY,
    "low_balance_usd": 2.0,
    "timeout": 15,
    "insecure_ssl": False,
    "concurrency": 8,
    "usage_days": 14,
    "max_usage_days": LOG_FETCH_DAYS,
}

CONFIG_LOCK = threading.Lock()
CACHE = {}  # site_id -> snapshot dict
CACHE_LOCK = threading.Lock()

# 供连通性测试等需要"随时查站点/设置"的场景使用（每次刷新配置时更新）
SITE_INDEX = {}  # site_id -> site dict
CURRENT_SETTINGS = dict(DEFAULT_SETTINGS)


# --------------------------------------------------------------------------
# 配置读写
# --------------------------------------------------------------------------
def read_config():
    if not os.path.exists(CONFIG_PATH):
        return {"settings": dict(DEFAULT_SETTINGS), "sites": []}
    try:
        with io.open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return {"settings": dict(DEFAULT_SETTINGS), "sites": []}
    settings = dict(DEFAULT_SETTINGS)
    settings.update(cfg.get("settings") or {})
    sites = cfg.get("sites") or []
    return {"settings": settings, "sites": sites}


def write_config(cfg):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


def save_cache():
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with CACHE_LOCK:
            snap = dict(CACHE)
        with io.open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False)
    except Exception:
        pass


def load_cache():
    global CACHE
    if os.path.exists(CACHE_PATH):
        try:
            with io.open(CACHE_PATH, "r", encoding="utf-8") as f:
                CACHE = json.load(f) or {}
        except Exception:
            CACHE = {}


# --------------------------------------------------------------------------
# HTTP 工具
# --------------------------------------------------------------------------
def http_get(url, headers=None, timeout=15, insecure=False):
    """返回 (status, text, headers)。失败时抛出异常。"""
    h = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip",
    }
    if headers:
        h.update({k: v for k, v in headers.items() if v is not None})
    req = urllib.request.Request(url, headers=h, method="GET")
    ctx = None
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding", "").lower().find("gzip") >= 0:
            try:
                raw = gzip.decompress(raw)
            except Exception:
                pass
        text = raw.decode("utf-8", "replace")
        hdrs = dict(resp.headers)
        try:
            multi = resp.headers.get_all("Set-Cookie")
            if multi:
                hdrs["Set-Cookie"] = "\n".join(multi)
        except Exception:
            pass
        return resp.status, text, hdrs


def http_post_json(url, headers=None, body=None, timeout=15, insecure=False):
    """POST JSON，返回 (status, text, headers)。失败抛出异常。"""
    h = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip",
        "Content-Type": "application/json",
    }
    if headers:
        h.update({k: v for k, v in headers.items() if v is not None})
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(url, headers=h, method="POST", data=data)
    ctx = None
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding", "").lower().find("gzip") >= 0:
            try:
                raw = gzip.decompress(raw)
            except Exception:
                pass
        text = raw.decode("utf-8", "replace")
        hdrs = dict(resp.headers)
        try:
            multi = resp.headers.get_all("Set-Cookie")
            if multi:
                hdrs["Set-Cookie"] = "\n".join(multi)
        except Exception:
            pass
        return resp.status, text, hdrs


def http_post_json_stream(url, headers=None, body=None, timeout=15, insecure=False,
                          max_bytes=16384, idle_seconds=6.0):
    """POST JSON 并以流式（SSE）读取响应。

    有些中转站/模型只接受 stream=true，非流式请求会直接报错。这里发 stream=true，
    边读边判断：收到有效数据块就立即返回，不必等流结束。

    关键：不能一直阻塞在 read 上——SSE 流中间可能长时间不吐新内容，
    所以要给"两次数据之间"设一个空闲上限（idle_seconds），超时就用手上已有的内容判断。
    返回 (status, text, headers)。
    """
    h = {
        "User-Agent": UA,
        "Accept": "text/event-stream, application/json, */*",
        "Accept-Encoding": "identity",   # 流式下不解压，避免半包 gzip 无法解码
        "Content-Type": "application/json",
    }
    if headers:
        h.update({k: v for k, v in headers.items() if v is not None})
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(url, headers=h, method="POST", data=data)
    ctx = None
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    buf = []
    got = 0
    status = None
    hdrs = {}
    resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)
    try:
        status = resp.status
        hdrs = dict(resp.headers)
        try:
            multi = resp.headers.get_all("Set-Cookie")
            if multi:
                hdrs["Set-Cookie"] = "\n".join(multi)
        except Exception:
            pass

        # 用后台线程读，主线程只等有限时间 → 避免卡在 read 上不可控
        stop = threading.Event()
        chunks = []
        total = [0]

        def reader():
            try:
                while not stop.is_set() and total[0] < max_bytes:
                    b = resp.read(256)
                    if not b:
                        break
                    chunks.append(b)
                    total[0] += len(b)
            except Exception:
                pass

        th = threading.Thread(target=reader, daemon=True)
        th.start()
        deadline = time.time() + timeout
        last_len = 0
        idle_from = time.time()
        while time.time() < deadline:
            time.sleep(0.05)
            blob = b"".join(chunks)
            if b"[DONE]" in blob or b'"choices"' in blob or b'"delta"' in blob:
                break
            if total[0] != last_len:
                last_len = total[0]
                idle_from = time.time()
            elif total[0] and (time.time() - idle_from) > idle_seconds:
                break          # 有一段时间没有新数据，用已有的判断
        stop.set()
        buf = chunks[:]
        got = total[0]
    finally:
        try:
            resp.close()
        except Exception:
            pass

    raw = b"".join(buf)
    if "gzip" in (hdrs.get("Content-Encoding", "") or "").lower():
        try:
            raw = gzip.decompress(raw)
        except Exception:
            pass
    return status, raw.decode("utf-8", "replace"), hdrs


def _err_body(e, limit=2000):
    """读取 HTTPError 的响应体（自动解压 gzip）。"""
    try:
        raw = e.read()
        if "gzip" in (e.headers.get("Content-Encoding", "") or ""):
            try:
                raw = gzip.decompress(raw)
            except Exception:
                pass
        return raw.decode("utf-8", "replace")[:limit]
    except Exception:
        return ""


def safe_json(text):
    try:
        return json.loads(text)
    except Exception:
        return None


def normalize_base(base):
    """把用户输入的 base url 规范化为 (root, v1)。

    支持 https://x.com 、https://x.com/v1 、https://x.com/v1/ 等写法。
    """
    b = (base or "").strip().rstrip("/")
    if not b:
        return "", ""
    if not re.match(r"^https?://", b, re.I):
        b = "https://" + b
    if b.lower().endswith("/v1"):
        root = b[:-3].rstrip("/")
    else:
        root = b
    return root, root + "/v1"


def now_ts():
    return int(time.time())


# --------------------------------------------------------------------------
# 各站点信息抓取
# --------------------------------------------------------------------------
def _truncate(obj, n=1500):
    try:
        s = json.dumps(obj, ensure_ascii=False)
    except Exception:
        s = str(obj)
    return s if len(s) <= n else s[:n] + " ...(truncated)"


def build_cookie(raw):
    """把用户粘贴的内容规范化为 Cookie 头。

    支持三种粘贴方式：完整 Cookie 串、`session=xxx`、只有 xxx。
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    if "=" not in raw:
        return "session=" + raw
    return raw


def session_looks_wrong(raw):
    """检查会话 Cookie 是否疑似复制错了。

    常见错误：把标记 Cookie（new_api_has_session=1）当成了会话本体。
    真正要复制的是名字叫 session 的那一条长值；
    或新版界面站的 new_api_refresh 刷新令牌（值可能较短，不做长度校验）。
    """
    v = (raw or "").strip()
    if not v:
        return None
    # 完整 Cookie 串里带 new_api_refresh（刷新令牌）→ 视为有效，不校验长度
    if "new_api_refresh=" in v:
        return None
    if v.lower().startswith("session="):
        v = v.split("=", 1)[1].strip()
    if "has_session" in v.lower() or v == "1":
        return "复制到的是标记 Cookie（如 new_api_has_session=1），不是会话本体"
    if len(v) < 20:
        return "内容过短，疑似没复制全"
    return None


def auth_attempts(site):
    """按优先级生成候选鉴权头，返回 [(说明, headers), ...]。"""
    out = []
    token = (site.get("access_token") or "").strip()
    uid = str(site.get("user_id") or "").strip()
    if token:
        h = {"Authorization": token}
        if uid:
            h["New-Api-User"] = uid
        out.append(("令牌", h))
        h2 = {"Authorization": "Bearer " + token}
        if uid:
            h2["New-Api-User"] = uid
        out.append(("令牌", h2))
    cookie = build_cookie(site.get("session"))
    if cookie:
        h = {"Cookie": cookie}
        if uid:
            h["New-Api-User"] = uid
        out.append(("Cookie", h))
        if uid:
            out.append(("Cookie", {"Cookie": cookie}))
    return out


def parse_set_cookie(headers, name):
    """从响应头里提取某个 Set-Cookie 的值（多条已用换行拼接）。"""
    raw = ""
    for k, v in (headers or {}).items():
        if k.lower() == "set-cookie":
            raw += "\n" + str(v)
    m = re.search(re.escape(name) + r"=([^;\n]*)", raw)
    if m:
        try:
            return urllib.parse.unquote(m.group(1))
        except Exception:
            return m.group(1)
    return None


def try_token_rotation(root, site, st, debug):
    """sub2api / 新版 new-api 的「刷新令牌轮换」登录方式。

    这类站没有经典 session Cookie，而是浏览器存 new_api_refresh 刷新令牌，
    前端 POST /api/user/auth/refresh 换短期 JWT。把刷新令牌填到
    「会话 Cookie」框里即可；站点每次会轮换新令牌，程序自动回写，
    一次填写长期可用。成功返回 (user_dict, 请求头)，失败返回 (None, None)。
    """
    rt = (site.get("session") or "").strip()
    if not rt:
        return None, None
    # 这类站会校验 Origin/Referer，伪装成站内请求
    hdrs = {"Origin": root, "Referer": root + "/"}
    if "=" in rt or ";" in rt:
        hdrs["Cookie"] = build_cookie(rt)
    else:
        hdrs["Cookie"] = "new_api_refresh=" + rt
    try:
        status, text, headers = http_post_json(
            root + "/api/user/auth/refresh", hdrs, {}, st["timeout"], st["insecure_ssl"]
        )
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = _err_body(e)
        except Exception:
            pass
        debug["token_rotation"] = _truncate({"status": e.code, "body": body}, 400)
        return None, None
    except Exception as e:
        debug["token_rotation"] = "error: %s" % e
        return None, None

    j = safe_json(text)
    debug["token_rotation"] = _truncate(
        {"status": status, "body": j if j is not None else text}, 600
    )
    if not isinstance(j, dict):
        return None, None
    d = j.get("data") if isinstance(j.get("data"), dict) else j
    token = d.get("accessToken") or d.get("access_token")
    if not token:
        return None, None

    # 响应体 / Set-Cookie 可能带新的刷新令牌（一次性轮换），回写保证下次可用
    new_rt = None
    sess = d.get("session")
    if isinstance(sess, dict):
        new_rt = sess.get("refreshToken") or sess.get("refresh_token")
    if not new_rt:
        new_rt = parse_set_cookie(headers, "new_api_refresh")
    if new_rt and new_rt != rt:
        site["session"] = new_rt
        site["_rotated"] = True

    auth = {"Authorization": "Bearer " + token}
    uid = str(site.get("user_id") or "").strip()
    if uid:
        auth["New-Api-User"] = uid

    # 轮换响应里可能已带用户信息
    u = d.get("user")
    if isinstance(u, dict) and ("quota" in u or "used_quota" in u):
        data = dict(u)
        data["_auth_label"] = "Cookie"
        return data, auth
    # 否则拿 JWT 再读一次 /api/user/self
    try:
        status2, text2, _ = http_get(root + "/api/user/self", auth, st["timeout"], st["insecure_ssl"])
        j2 = safe_json(text2)
        debug["user_self_rot"] = _truncate(
            {"status": status2, "body": j2 if j2 is not None else text2}
        )
        if j2 and j2.get("success") and isinstance(j2.get("data"), dict):
            data = dict(j2["data"])
            data["_auth_label"] = "Cookie"
            return data, auth
    except Exception as e:
        debug["user_self_rot"] = "error: %s" % e
    return None, None


def try_session_renew(root, site, st, debug):
    """会话 Cookie 过期后自动续期。

    普通 session Cookie 是有有效期的，过期后站点会返回「未登录」。
    很多 new-api 系站点会带一个长期有效的 new_api_refresh 刷新令牌，
    且刷新时会把新 session 放进 Set-Cookie —— 这里就是抓住它并回写配置，
    让用户不必手动重贴 Cookie。成功返回 (user_dict, headers)，失败 (None, None)。
    """
    rt = (site.get("session") or "").strip()
    if not rt:
        return None, None
    # 刷新令牌可能单独填，也可能混在完整 Cookie 串里
    if "new_api_refresh=" in rt:
        refresh_val = parse_set_cookie({"Set-Cookie": rt}, "new_api_refresh")
    elif "=" not in rt:
        refresh_val = rt
    else:
        refresh_val = ""

    hdrs = {"Origin": root, "Referer": root + "/"}
    cookie = build_cookie(rt)
    if refresh_val and "new_api_refresh=" not in cookie:
        cookie = (cookie + "; " if cookie else "") + "new_api_refresh=" + refresh_val
    if cookie:
        hdrs["Cookie"] = cookie

    try:
        status, text, headers = http_post_json(
            root + "/api/user/auth/refresh", hdrs, {}, st["timeout"], st["insecure_ssl"]
        )
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = _err_body(e)
        except Exception:
            pass
        debug["session_renew"] = _truncate({"status": e.code, "body": body}, 400)
        return None, None
    except Exception as e:
        debug["session_renew"] = "error: %s" % e
        return None, None

    j = safe_json(text)
    debug["session_renew"] = _truncate(
        {"status": status, "body": j if j is not None else text}, 600
    )
    if not isinstance(j, dict):
        return None, None
    d = j.get("data") if isinstance(j.get("data"), dict) else j
    token = d.get("accessToken") or d.get("access_token")

    # 关键：从 Set-Cookie 抓新的 session，回写配置 —— 这就是「自动续期」
    new_sess = parse_set_cookie(headers, "session")
    if new_sess and new_sess != rt:
        site["session"] = new_sess
        site["_renewed"] = True
    new_rt = parse_set_cookie(headers, "new_api_refresh")
    if new_rt and new_rt != refresh_val:
        # 有刷新令牌就把刷新令牌存起来（长期有效），优先存它
        site["session"] = new_rt
        site["_renewed"] = True

    if not token and not new_sess:
        return None, None

    if token:
        auth = {"Authorization": "Bearer " + token}
        uid = str(site.get("user_id") or "").strip()
        if uid:
            auth["New-Api-User"] = uid
        u = d.get("user")
        if isinstance(u, dict) and ("quota" in u or "used_quota" in u):
            data = dict(u)
            data["_auth_label"] = "Cookie"
            return data, auth
        try:
            status2, text2, _ = http_get(root + "/api/user/self", auth, st["timeout"], st["insecure_ssl"])
            j2 = safe_json(text2)
            debug["user_self_renew"] = _truncate(
                {"status": status2, "body": j2 if j2 is not None else text2}
            )
            if j2 and j2.get("success") and isinstance(j2.get("data"), dict):
                data = dict(j2["data"])
                data["_auth_label"] = "Cookie"
                return data, auth
        except Exception as e:
            debug["user_self_renew"] = "error: %s" % e

    # 没有 accessToken，但拿到了新 session —— 用新 session 再试一次经典方式
    if new_sess:
        for label, h in auth_attempts(site):
            try:
                status3, text3, _ = http_get(root + "/api/user/self", h, st["timeout"], st["insecure_ssl"])
                j3 = safe_json(text3)
                if j3 and j3.get("success") and isinstance(j3.get("data"), dict):
                    data = dict(j3["data"])
                    data["_auth_label"] = "Cookie"
                    return data, h
            except Exception:
                continue
    return None, None


def fetch_user_self(root, site, st, debug):
    """尝试读取账户信息。成功返回 (data, headers)，失败返回 (None, None)。"""
    attempts = auth_attempts(site)
    if not attempts:
        return None, None
    last_err = None
    cookie_failed = False
    for label, hdrs in attempts:
        try:
            status, text, _ = http_get(root + "/api/user/self", hdrs, st["timeout"], st["insecure_ssl"])
        except urllib.error.HTTPError as e:
            last_err = "HTTP %s" % e.code
            if label == "Cookie":
                cookie_failed = True
            try:
                body = _err_body(e)
                debug["user_self"] = _truncate({"尝试": label, "status": e.code, "body": body})
            except Exception:
                pass
            continue
        except Exception as e:
            last_err = str(e)
            debug["user_self"] = "error: %s" % e
            continue
        j = safe_json(text)
        debug["user_self"] = _truncate(
            {"尝试": label, "status": status, "body": j if j is not None else text}
        )
        if j and j.get("success") and isinstance(j.get("data"), dict):
            data = dict(j["data"])
            data["_auth_label"] = label
            return data, hdrs
        # 站点明确回「未登录」类错误 → 记下，稍后尝试自动续期
        if label == "Cookie" and isinstance(j, dict):
            msg = str(j.get("message") or "").lower()
            if not j.get("success") and ("未登录" in msg or "unauthor" in msg
                                         or "invalid" in msg or "expire" in msg
                                         or "session" in msg):
                cookie_failed = True
    debug["user_self_error"] = last_err

    # Cookie 失效 → 先试自动续期（新 session 会写回配置）
    if cookie_failed or (site.get("session") or "").strip():
        data, hdrs = try_session_renew(root, site, st, debug)
        if data:
            return data, hdrs

    # 经典方式都没过 → 试试「刷新令牌轮换」（sub2api / 新版 new-api 系）
    return try_token_rotation(root, site, st, debug)


def fetch_status(root, st, debug):
    try:
        status, text, _ = http_get(root + "/api/status", None, st["timeout"], st["insecure_ssl"])
        j = safe_json(text)
        debug["status"] = _truncate(j if j is not None else text, 800)
        if j and isinstance(j.get("data"), dict):
            return j["data"]
    except Exception as e:
        debug["status"] = "error: %s" % e
    return None


def fetch_models(v1, key, st, debug):
    if not key:
        return []
    try:
        status, text, _ = http_get(
            v1 + "/models",
            {"Authorization": "Bearer " + key},
            st["timeout"],
            st["insecure_ssl"],
        )
        j = safe_json(text)
        if j and isinstance(j.get("data"), list):
            ids = []
            for it in j["data"]:
                if isinstance(it, dict) and it.get("id"):
                    ids.append(str(it["id"]))
                elif isinstance(it, str):
                    ids.append(it)
            debug["models"] = "ok, %d models" % len(ids)
            return sorted(set(ids))
        debug["models"] = _truncate(j if j is not None else text, 400)
    except urllib.error.HTTPError as e:
        debug["models"] = "HTTP %s" % e.code
    except Exception as e:
        debug["models"] = "error: %s" % e
    return []


def fetch_billing(v1, key, st, debug):
    """OpenAI 兼容计费接口。返回 (balance_usd, used_usd) 或 (None, None)。"""
    if not key:
        return None, None
    hdrs = {"Authorization": "Bearer " + key}
    balance = None
    used = None
    try:
        status, text, _ = http_get(v1 + "/dashboard/billing/subscription", hdrs, st["timeout"], st["insecure_ssl"])
        j = safe_json(text)
        debug["billing_subscription"] = _truncate(j if j is not None else text, 600)
        if j:
            for k in ("hard_limit_usd", "system_hard_limit_usd", "soft_limit_usd"):
                v = j.get(k)
                if isinstance(v, (int, float)):
                    # 部分站用 1e8 这种占位值表示"无限额度"，不能当余额展示
                    if v >= 10_000_000:
                        debug["billing_note"] = (
                            "hard_limit_usd = %s，疑似无限额度的占位值，已忽略" % v
                        )
                        break
                    balance = float(v)
                    break
    except Exception as e:
        debug["billing_subscription"] = "error: %s" % e
    try:
        end = datetime.now().strftime("%Y-%m-%d")
        start = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")
        url = "%s/dashboard/billing/usage?start_date=%s&end_date=%s" % (v1, start, end)
        status, text, _ = http_get(url, hdrs, st["timeout"], st["insecure_ssl"])
        j = safe_json(text)
        debug["billing_usage"] = _truncate(j if j is not None else text, 600)
        if j and isinstance(j.get("total_usage"), (int, float)):
            used = float(j["total_usage"]) / 100.0  # cents -> USD
    except Exception as e:
        debug["billing_usage"] = "error: %s" % e
    return balance, used


def fetch_gateway_usage(v1, key, st, debug):
    """自研 AI 网关的 /v1/usage 接口。

    这类网关没有 New API 的 /api/user/self，但用同一个 sk- Key 就能读到
    余额、按天用量、按模型用量。返回原始 dict，失败返回 None。
    """
    if not key:
        return None
    try:
        status, text, _ = http_get(
            v1 + "/usage",
            {"Authorization": "Bearer " + key},
            st["timeout"],
            st["insecure_ssl"],
        )
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = _err_body(e)
        except Exception:
            pass
        debug["gw_usage"] = _truncate({"status": e.code, "body": body}, 400)
        return None
    except Exception as e:
        debug["gw_usage"] = "error: %s" % e
        return None

    j = safe_json(text)
    debug["gw_usage"] = _truncate(j if j is not None else text, 900)
    if not isinstance(j, dict) or j.get("isValid") is False:
        return None
    if j.get("balance") is None and j.get("remaining") is None:
        return None
    return j


def gateway_fields(gw):
    """把 /v1/usage 的返回归一化为通用字段（金额本身即 USD）。"""

    def num(v):
        try:
            return float(v)
        except Exception:
            return 0.0

    def cost_of(d):
        # actual_cost 是实际扣费；部分网关只给 cost
        c = num(d.get("actual_cost"))
        if c <= 0:
            c = num(d.get("cost"))
        return c

    bal = gw.get("balance")
    if bal is None:
        bal = gw.get("remaining")
    usage = gw.get("usage") if isinstance(gw.get("usage"), dict) else {}
    total = usage.get("total") if isinstance(usage.get("total"), dict) else {}

    by_day = []
    for d in gw.get("daily_usage") or []:
        if not isinstance(d, dict) or not d.get("date"):
            continue
        by_day.append(
            {
                "date": str(d["date"]),
                "usd": cost_of(d),
                "requests": int(num(d.get("requests"))),
                "tokens": int(num(d.get("total_tokens"))),
            }
        )
    by_day.sort(key=lambda x: x["date"])

    by_model = []
    for m in gw.get("model_stats") or []:
        if not isinstance(m, dict) or not m.get("model"):
            continue
        by_model.append(
            {
                "model": str(m["model"]),
                "usd": cost_of(m),
                "requests": int(num(m.get("requests"))),
                "prompt_tokens": int(num(m.get("input_tokens"))),
                "completion_tokens": int(num(m.get("output_tokens"))),
            }
        )
    by_model.sort(key=lambda x: -x["usd"])

    used = num(total.get("actual_cost")) or num(total.get("cost"))
    if used <= 0:
        used = sum(d["usd"] for d in by_day)

    return {
        "balance_usd": num(bal) if bal is not None else None,
        "used_usd": used,
        "request_count": int(num(total.get("requests"))),
        "plan_name": gw.get("planName"),
        "token_usage": {
            "prompt": int(num(total.get("input_tokens"))),
            "completion": int(num(total.get("output_tokens"))),
            "cached": int(num(total.get("cache_read_tokens"))),
            "total": int(num(total.get("total_tokens"))),
        },
        "by_day": by_day,
        "by_model": by_model,
    }


def gateway_reject_reason(debug):
    """从 /v1/usage 的返回判断 Key 是否被站点拒绝，用于给出准确提示。"""
    v = debug.get("gw_usage")
    if v is None:
        return None
    txt = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    if "INVALID_API_KEY" in txt or "API_KEY_REQUIRED" in txt or '"status": 401' in txt or '"status": 403' in txt:
        return "API Key 无效或已被站点禁用"
    if '"isValid": false' in txt or '"isValid":false' in txt:
        return "API Key 已失效（站点返回 isValid=false）"
    return None


def fetch_tokens(root, st, debug, hdrs):
    if not hdrs:
        return []
    for path in ("/api/token/?p=0&size=100", "/api/token/?p=0&page_size=100"):
        try:
            status, text, _ = http_get(root + path, hdrs, st["timeout"], st["insecure_ssl"])
            j = safe_json(text)
            if j and j.get("success") and isinstance(j.get("data"), list):
                out = []
                for t in j["data"][:100]:
                    if not isinstance(t, dict):
                        continue
                    out.append(
                        {
                            "name": t.get("name"),
                            "key": t.get("key"),
                            "status": t.get("status"),
                            "unlimited": bool(t.get("unlimited_quota")),
                            "remain_quota": t.get("remain_quota"),
                            "used_quota": t.get("used_quota"),
                            "expired_time": t.get("expired_time"),
                            "group": t.get("group"),
                        }
                    )
                debug["tokens"] = "ok, %d tokens" % len(out)
                return out
            debug["tokens"] = _truncate(j if j is not None else text, 400)
        except Exception as e:
            debug["tokens"] = "error: %s" % e
    return []


def fetch_logs(root, st, debug, hdrs, days=14):
    """拉取最近 N 天的调用日志，聚合为按天 / 按模型。"""
    if not hdrs:
        return [], []

    end = now_ts()
    start = end - days * 86400
    items = []
    for p in range(0, 5):
        url = "%s/api/log/self?p=%d&page_size=100&type=0&start_timestamp=%d&end_timestamp=%d" % (
            root, p, start, end,
        )
        try:
            status, text, _ = http_get(url, hdrs, st["timeout"], st["insecure_ssl"])
        except Exception as e:
            debug["logs"] = "error: %s" % e
            break
        j = safe_json(text)
        if j is None:
            debug["logs"] = "非 JSON 响应"
            break
        data = j.get("data")
        chunk = []
        if isinstance(data, list):
            chunk = data
        elif isinstance(data, dict):
            chunk = data.get("items") or data.get("records") or []
        if p == 0:
            debug["logs"] = _truncate(
                {"count": len(chunk), "sample": chunk[0] if chunk else None}, 700
            )
        if not chunk:
            break
        items.extend([x for x in chunk if isinstance(x, dict)])
        if len(chunk) < 100:
            break

    by_day = {}
    by_model = {}
    for it in items:
        ts = it.get("created_at") or it.get("timestamp")
        try:
            ts = int(ts)
        except Exception:
            continue
        day = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
        quota = it.get("quota") or 0
        try:
            quota = int(quota)
        except Exception:
            quota = 0
        model = it.get("model_name") or it.get("model") or "(未知)"
        d = by_day.setdefault(day, {"date": day, "quota": 0, "requests": 0})
        d["quota"] += abs(quota)
        d["requests"] += 1
        m = by_model.setdefault(
            model,
            {"model": model, "quota": 0, "requests": 0, "prompt_tokens": 0, "completion_tokens": 0},
        )
        m["quota"] += abs(quota)
        m["requests"] += 1
        try:
            m["prompt_tokens"] += int(it.get("prompt_tokens") or 0)
            m["completion_tokens"] += int(it.get("completion_tokens") or 0)
        except Exception:
            pass

    return sorted(by_day.values(), key=lambda x: x["date"]), sorted(
        by_model.values(), key=lambda x: -x["quota"]
    )


def probe_site(site, settings):
    """探测单个站点，返回快照 dict。"""
    st = settings
    qpu = site.get("quota_per_usd") or st["quota_per_usd"] or DEFAULT_QUOTA_PER_USD
    cny = site.get("usd_cny") or st["usd_cny"] or DEFAULT_USD_CNY

    snap = {
        "id": site.get("id"),
        "name": site.get("name") or site.get("base_url"),
        "base_url": site.get("base_url"),
        "enabled": site.get("enabled", True),
        "note": site.get("note") or "",
        "ok": False,
        "mode": None,
        "probed_at": now_ts(),
        "elapsed_ms": 0,
        "errors": [],
        "debug": {},
        "site_name": None,
        "version": None,
        "quota": None,
        "used_quota": None,
        "request_count": None,
        "group": None,
        "balance_usd": None,
        "used_usd": None,
        "quota_per_usd": qpu,
        "usd_cny": cny,
        "usd_cny_source": "global",   # global=用全局默认 / auto=从 /api/status 自动识别 / manual=用户手动填
        "models": [],
        "model_count": 0,
        "tokens": [],
        "usage_by_day": [],
        "usage_by_model": [],
        "range_used_usd": None,
        "plan_name": None,
        "token_usage": None,
    }

    root, v1 = normalize_base(site.get("base_url"))
    if not root:
        snap["errors"].append("Base URL 为空")
        return snap
    snap["root"] = root
    snap["v1"] = v1
    snap["reachable"] = False

    t0 = time.time()
    key = (site.get("api_key") or "").strip()
    print("  [probe] %s -> %s" % (snap["name"], root))

    # 会话 Cookie 明显复制错了时，提前给出行动提示
    sess_warn = session_looks_wrong(site.get("session"))
    if sess_warn:
        snap["errors"].append(
            "会话 Cookie 疑似有误：%s。请在浏览器 Cookies 列表里找名字叫 session 的那一条，复制它的完整长值" % sess_warn
        )

    # 1) 站点元信息
    status_data = fetch_status(root, st, snap["debug"])
    if status_data:
        snap["version"] = status_data.get("version")
        snap["site_name"] = status_data.get("system_name") or status_data.get("site_name")
        for k in ("quota_per_unit", "QuotaPerUnit"):
            v = status_data.get(k)
            if isinstance(v, (int, float)) and v > 0:
                qpu = int(v)
                snap["quota_per_usd"] = qpu
                break
        # 充值比（1 USD 额度 = N 元人民币）自动识别：
        # 兼容 one-api / new-api 的 price、stripe_unit_price，以及 done-hub / one-hub 的 PaymentUSDRate
        # 仅当站点没有手动填 usd_cny 时才采用自动识别值，避免覆盖用户设置
        if not (site.get("usd_cny") or "").strip():
            for k in ("price", "stripe_unit_price", "PaymentUSDRate", "payment_usd_rate"):
                v = status_data.get(k)
                if isinstance(v, (int, float)) and v > 0:
                    snap["usd_cny"] = float(v)
                    snap["usd_cny_source"] = "auto"
                    break

    # 2) 账户信息（访问令牌 或 会话 Cookie）
    user, auth_hdrs = fetch_user_self(root, site, st, snap["debug"])
    if user:
        snap["mode"] = "access_token"
        snap["ok"] = True
        snap["auth_used"] = user.get("_auth_label")
        snap["quota"] = user.get("quota")
        snap["used_quota"] = user.get("used_quota")
        snap["request_count"] = user.get("request_count")
        snap["group"] = user.get("group") or (user.get("group_ratio") and "default")
        if user.get("username"):
            snap["site_name"] = snap["site_name"] or snap["name"]
            snap["username"] = user.get("username")
        if not snap["site_name"]:
            snap["site_name"] = site.get("name")
    else:
        has_cred = bool((site.get("access_token") or "").strip()) or bool((site.get("session") or "").strip())
        snap["_cred_note"] = (
            "凭证无效：访问令牌 / 会话 Cookie 都未通过站点校验"
            if has_cred
            else "未填写访问令牌或会话 Cookie"
        )

    # 3) 模型列表
    snap["models"] = fetch_models(v1, key, st, snap["debug"])
    snap["model_count"] = len(snap["models"])

    # 4) 兼容计费接口（sk- Key）
    bal2, used2 = fetch_billing(v1, key, st, snap["debug"])
    if snap["quota"] is None and bal2 is not None:
        snap["balance_usd"] = bal2
        snap["used_usd"] = used2
        snap["mode"] = "apikey_billing"
        snap["ok"] = True

    # 4.5) 自研网关的 /v1/usage（同一个 sk- Key 就能拿到余额 + 用量明细）
    if snap["mode"] is None:
        gw = fetch_gateway_usage(v1, key, st, snap["debug"])
        if gw is not None:
            g = gateway_fields(gw)
            snap["mode"] = "gateway_usage"
            snap["ok"] = True
            snap["balance_usd"] = g["balance_usd"]
            snap["used_usd"] = g["used_usd"]
            snap["request_count"] = g["request_count"]
            snap["plan_name"] = g["plan_name"]
            snap["token_usage"] = g["token_usage"]
            snap["range_used_usd"] = g["used_usd"]
            qpuf = float(qpu) or float(DEFAULT_QUOTA_PER_USD)
            snap["usage_by_day"] = [
                {"date": d["date"], "quota": int(round(d["usd"] * qpuf)), "requests": d["requests"]}
                for d in g["by_day"]
            ]
            snap["usage_by_model"] = [
                {
                    "model": m["model"],
                    "quota": int(round(m["usd"] * qpuf)),
                    "requests": m["requests"],
                    "prompt_tokens": m["prompt_tokens"],
                    "completion_tokens": m["completion_tokens"],
                }
                for m in g["by_model"]
            ]

    if snap["mode"] is None and snap["models"]:
        snap["mode"] = "models_only"
        snap["ok"] = True

    # 余额/用量没拿到时，把凭证相关的提示补上
    cred = snap.get("_cred_note")
    if snap["mode"] == "models_only":
        snap["errors"].append(
            (cred + "，余额/用量也读不到（已尝试计费接口与 /v1/usage）")
            if cred
            else "仅能获取模型列表，余额/用量需要系统访问令牌或站点支持计费接口"
        )
    elif snap["mode"] == "apikey_billing" and cred:
        snap["errors"].append(cred + "，无法读取调用日志与令牌列表")
    elif snap["mode"] is None and cred:
        reason = gateway_reject_reason(snap["debug"])
        if reason:
            snap["errors"].append(reason + "，无法读取余额与用量")
        else:
            snap["errors"].append(
                cred + "，且站点不支持计费 / /v1/usage 接口，无法读取余额与用量"
            )

    # 归一化为 USD
    if snap["quota"] is not None:
        try:
            snap["balance_usd"] = float(snap["quota"]) / float(qpu)
        except Exception:
            pass
    if snap["used_quota"] is not None:
        try:
            snap["used_usd"] = float(snap["used_quota"]) / float(qpu)
        except Exception:
            pass

    # 5) 令牌列表 + 调用日志（需要账户级鉴权）
    if snap["mode"] == "access_token":
        snap["tokens"] = fetch_tokens(root, st, snap["debug"], auth_hdrs)
        days = int(st.get("usage_days") or 14)
        # 探测时多取一些历史（最多 LOG_FETCH_DAYS 天），界面上的「时间范围」才有得切换。
        # 前端仍默认只显示 usage_days 天。
        fetch_days = min(LOG_FETCH_DAYS, max(days, st.get("max_usage_days") or 0) or days)
        if fetch_days < LOG_FETCH_DAYS:
            fetch_days = LOG_FETCH_DAYS
        by_day, by_model = fetch_logs(root, st, snap["debug"], auth_hdrs, days=fetch_days)
        total = sum(x["quota"] for x in by_day)
        snap["usage_by_day"] = by_day
        snap["usage_by_model"] = by_model
        snap["range_used_usd"] = total / float(qpu) if qpu else None

        # 补齐缺失日期
        have = {d["date"] for d in snap["usage_by_day"]}
        filled = []
        for i in range(days - 1, -1, -1):
            day = (datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d")
            if day in have:
                filled.append(next(d for d in snap["usage_by_day"] if d["date"] == day))
            else:
                filled.append({"date": day, "quota": 0, "requests": 0})
        snap["usage_by_day"] = filled

    # 网关返回的是"有消耗的日期"，补齐为连续日期，折线图才不会断裂
    elif snap["mode"] == "gateway_usage" and snap["usage_by_day"]:
        have = {d["date"] for d in snap["usage_by_day"]}
        today = datetime.now().date()
        start = None
        for d in snap["usage_by_day"]:
            try:
                dt = datetime.strptime(d["date"], "%Y-%m-%d").date()
            except Exception:
                continue
            start = dt if start is None else min(start, dt)
        if start is None:
            start = today - timedelta(days=int(st.get("usage_days") or 14) - 1)
        if (today - start).days > 60:
            start = today - timedelta(days=60)
        filled = []
        cur = start
        while cur <= today:
            key_day = cur.strftime("%Y-%m-%d")
            if key_day in have:
                filled.append(next(d for d in snap["usage_by_day"] if d["date"] == key_day))
            else:
                filled.append({"date": key_day, "quota": 0, "requests": 0})
            cur += timedelta(days=1)
        snap["usage_by_day"] = filled

    snap["elapsed_ms"] = int((time.time() - t0) * 1000)

    # 主机是否可达（有 HTTP 响应即为可达，401/403 也算）
    reachable = bool(status_data) or bool(user) or bool(snap["models"])
    if not reachable:
        for v in snap["debug"].values():
            s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
            if s.startswith("HTTP ") or '"status": ' in s:
                reachable = True
                break
    snap["reachable"] = reachable
    if not snap["ok"] and reachable and not snap["errors"]:
        snap["errors"].append("主机可达，但没有取到有效数据，请检查密钥与用户 ID")
    snap.pop("_cred_note", None)
    return snap


def test_connection(creds, settings):
    """不保存、直接测试「Base URL + Key」是否可用。

    用于添加站点前先验证，省得保存完才发现填错。返回精简的报告：
      可达性 / Key 是否有效 / 拿到多少模型 / 能否读到余额 / 实际生效的接口方式
    """
    import time as _t
    site = {
        "id": "__probe__",
        "name": creds.get("base_url") or "待测站点",
        "base_url": creds.get("base_url"),
        "api_key": creds.get("api_key") or "",
        "access_token": creds.get("access_token") or "",
        "session": creds.get("session") or "",
        "user_id": creds.get("user_id") or "",
        "insecure_ssl": bool(creds.get("insecure_ssl")),
        "enabled": True,
    }
    st = dict(DEFAULT_SETTINGS)
    st.update(settings or {})
    t0 = _t.time()
    try:
        snap = probe_site(site, st)
    except Exception as e:
        return {"ok": False, "error": "测试失败：%s" % e}
    elapsed = int((_t.time() - t0) * 1000)

    root, _v1 = normalize_base(site.get("base_url") or "")
    issues = []
    # 站点本身回「未登录/无权」类错误时，还原成更好懂的提示
    for err in (snap.get("errors") or []):
        e = str(err)
        if "无效" in e or "密钥" in e or "未通过" in e:
            issues.append(e)
        elif "会话 Cookie 疑似有误" in e:
            issues.append(e)
    return {
        "ok": bool(snap.get("ok")),
        "reachable": snap.get("reachable"),
        "base_url": snap.get("base_url"),
        "normalized_url": root,
        "version": snap.get("version"),
        "site_name": snap.get("site_name"),
        "mode": snap.get("mode"),
        "mode_label": {
            "access_token": "完整数据", "apikey_billing": "Key 计费接口",
            "gateway_usage": "网关用量接口", "models_only": "仅模型列表",
        }.get(snap.get("mode")) or "未识别",
        "auth_used": snap.get("auth_used"),
        "model_count": snap.get("model_count") or 0,
        "models": (snap.get("models") or [])[:12],
        "balance_usd": snap.get("balance_usd"),
        "used_usd": snap.get("used_usd"),
        "request_count": snap.get("request_count"),
        "elapsed_ms": elapsed,
        "errors": issues or (snap.get("errors") or []),
    }


def test_one_model(item):
    """对单个 站点×模型 发一次最小 chat 请求，测连通性。

    不消耗什么额度（max_tokens=1），只关心：能不能连上、鉴权过不过、
    模型名是否有效、耗时多少。有些模型只接受流式请求，会自动改发 stream=true。
    """
    site_id = item.get("site_id")
    model = item.get("model")
    site = SITE_INDEX.get(site_id)
    st = CURRENT_SETTINGS
    out = {
        "site_id": site_id, "model": model, "ok": False, "ms": 0,
        "status": None, "error": None, "stream": False,
    }

    if not site:
        out["error"] = "站点不存在"
        return out
    key = (site.get("api_key") or "").strip()
    if not key:
        out["error"] = "没有填写 API Key，无法测试"
        return out
    _, v1 = normalize_base(site.get("base_url"))
    if not v1:
        out["error"] = "Base URL 无效"
        return out

    t0 = time.time()
    timeout = min(int(st.get("timeout") or 15), 30)
    mode = (item.get("mode") or "auto").lower()
    payload = {"model": model, "messages": [{"role": "user", "content": "hi"}]}

    # mode: auto（先非流式，失败再补一次流式）/ stream（只发流式）/ plain（只发非流式）
    attempts = []
    if mode == "stream":
        attempts = [("stream", True)]
    elif mode == "plain":
        attempts = [("plain", False)]
    else:
        attempts = [("plain", False), ("stream", True)]

    last_err = None
    for tag, is_stream in attempts:
        body = dict(payload)
        if is_stream:
            body["stream"] = True
            body["max_tokens"] = 1
        else:
            body["max_tokens"] = 1
        try:
            fn = http_post_json_stream if is_stream else http_post_json
            status, text, _ = fn(
                v1 + "/chat/completions",
                {"Authorization": "Bearer " + key},
                body,
                timeout,
                st.get("insecure_ssl"),
            )
            out["ms"] = int((time.time() - t0) * 1000)
            out["status"] = status
            out["stream"] = is_stream if tag == "stream" else out.get("stream", False)

            if is_stream:
                # SSE：以 data: 行的内容判断
                ok = ('"choices"' in text) or ('"delta"' in text) or ("[DONE]" in text)
                if ok:
                    out["ok"] = True
                    out["error"] = None
                    return out
                j = _sse_error(text)
                if j:
                    out["error"] = j
                    last_err = j
                    continue
                out["error"] = "流式返回中没有内容"
                last_err = out["error"]
                continue

            j = safe_json(text)
            if j and (j.get("choices") or j.get("id") or j.get("usage")):
                out["ok"] = True
                out["error"] = None
                return out
            if j and j.get("error"):
                err = j["error"]
                msg = err.get("message") if isinstance(err, dict) else str(err)
                out["error"] = msg
                last_err = msg
                # 该模型只支持流式时，自动补一次流式重试
                if _looks_like_stream_required(msg) and mode == "auto":
                    continue
                return out
            out["error"] = "返回格式非预期"
            last_err = out["error"]
        except urllib.error.HTTPError as e:
            out["ms"] = int((time.time() - t0) * 1000)
            out["status"] = e.code
            msg = _http_err_msg(e)
            out["error"] = msg or ("HTTP %s" % e.code)
            last_err = out["error"]
            # 400/404 里提示"必须用流式"时，也补一次流式
            if _looks_like_stream_required(msg) and mode == "auto" and not is_stream:
                continue
            if is_stream and mode == "stream":
                return out
            if not is_stream and mode == "auto":
                continue
            return out
        except Exception as e:
            out["ms"] = int((time.time() - t0) * 1000)
            msg = "%s: %s" % (type(e).__name__, str(e)[:120])
            out["error"] = msg
            last_err = msg
            if not is_stream and mode == "auto":
                continue  # 超时/断流 → 试流式
            return out

    if last_err:
        out["error"] = last_err
    return out


def _sse_error(text):
    """从 SSE 片段里抠出错误信息，没有则返回 None。"""
    for line in (text or "").splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        j = safe_json(payload)
        if isinstance(j, dict) and j.get("error"):
            err = j["error"]
            return err.get("message") if isinstance(err, dict) else str(err)
    return None


def _http_err_msg(e):
    """把 HTTPError 的响应体解析成可读错误。"""
    body = _err_body(e, 600)
    j = safe_json(body)
    if isinstance(j, dict):
        err = j.get("error")
        if isinstance(err, dict):
            return err.get("message") or err.get("type")
        if err:
            return str(err)
        return j.get("message") or j.get("code")
    return None


def _looks_like_stream_required(msg):
    """站点/模型要求必须用流式请求的常见措辞。"""
    if not msg:
        return False
    m = str(msg).lower()
    keys = [
        "stream",           # 英文
        "流式", "流式模式", "请使用流式",   # 中文
        "only support streaming", "streaming is required",
        "must be stream", "requires stream",
    ]
    return any(k in m for k in keys)



def test_models(body):
    """按 站点×模型 组合并发测试连通性。"""
    items = body.get("items") or []
    if not isinstance(items, list) or not items:
        return {"ok": False, "error": "没有要测试的项目"}
    mode = (body.get("mode") or "auto").lower()
    items = items[:200]  # 上限，避免误发太多请求
    results = []
    workers = max(1, min(int(CURRENT_SETTINGS.get("concurrency") or 8), len(items), 8))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(test_one_model, dict(it, mode=mode)): it for it in items}
        for f in futs:
            try:
                results.append(f.result(timeout=90))
            except Exception as e:
                it = futs[f]
                results.append({
                    "site_id": it.get("site_id"), "model": it.get("model"),
                    "ok": False, "ms": 0, "status": None, "error": str(e)[:120],
                    "stream": False,
                })
    return {"ok": True, "results": results}


def refresh_all(only_ids=None):
    # 注意：这里必须持有 CONFIG_LOCK 读取。否则与 upsert_site / delete_site 并发时，
    # 会读到旧快照，而下面的「凭证轮换落盘」又把整份旧 cfg 写回去，把刚新增/删除的站点覆盖掉
    # （曾经导致「站点管理里莫名少了一个站」）。
    with CONFIG_LOCK:
        cfg = read_config()
    settings = cfg["settings"]
    global CURRENT_SETTINGS
    CURRENT_SETTINGS = settings
    SITE_INDEX.clear()
    for s in cfg["sites"]:
        SITE_INDEX[s.get("id")] = s
    sites = [s for s in cfg["sites"] if s.get("enabled", True)]
    if only_ids:
        sites = [s for s in sites if s.get("id") in only_ids]
    if not sites:
        return []
    results = []
    workers = max(1, min(int(settings.get("concurrency") or 8), len(sites)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(probe_site, s, settings): s for s in sites}
        for f in futs:
            try:
                results.append(f.result(timeout=90))
            except Exception as e:
                s = futs[f]
                results.append(
                    {
                        "id": s.get("id"),
                        "name": s.get("name") or s.get("base_url"),
                        "base_url": s.get("base_url"),
                        "enabled": s.get("enabled", True),
                        "note": s.get("note") or "",
                        "ok": False,
                        "mode": None,
                        "probed_at": now_ts(),
                        "errors": [str(e)],
                        "models": [],
                        "model_count": 0,
                        "debug": {},
                    }
                )
    with CACHE_LOCK:
        for r in results:
            CACHE[r["id"]] = r
    save_cache()

    # 刷新令牌被站点轮换过、或 Cookie 自动续期拿到了新 session 的，落盘保证下次可用。
    # 落盘时重新读一份最新配置，只把这两个凭证字段写回去，
    # 绝不整份覆盖（否则会把用户并发新增的站点挤掉）。
    changed = [s for s in sites if s.pop("_rotated", None) or s.pop("_renewed", None)]
    if changed:
        with CONFIG_LOCK:
            fresh = read_config()
            by_id = {s.get("id"): s for s in fresh.get("sites") or []}
            n = 0
            for s in changed:
                tgt = by_id.get(s.get("id"))
                if tgt is None:
                    continue          # 期间已被删除，跳过
                tgt["session"] = s.get("session") or ""
                if s.get("access_token"):
                    tgt["access_token"] = s.get("access_token")
                n += 1
            if n:
                write_config(fresh)
                print("  [rotation] %d 个站点的凭证已自动更新并保存" % n)
    return results


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


def mask_key(k):
    if not k:
        return ""
    k = str(k)
    if len(k) <= 10:
        return k[:3] + "***"
    return k[:6] + "*" * 8 + k[-4:]


class Handler(BaseHTTPRequestHandler):
    server_version = "APIHub/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 静音

    # ---- 输出工具 ----
    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        if not os.path.isfile(path):
            self.send_error(404)
            return
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # ---- 路由 ----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        try:
            if path == "/api/config":
                cfg = read_config()
                out = dict(cfg)
                out["base_dir"] = BASE_DIR  # 页面标注运行目录，防多副本混淆
                out["sites"] = []
                for s in cfg["sites"]:
                    t = dict(s)
                    t["api_key_masked"] = mask_key(s.get("api_key"))
                    t["access_token_masked"] = mask_key(s.get("access_token"))
                    t["session_masked"] = mask_key(s.get("session"))
                    t.pop("api_key", None)
                    t.pop("access_token", None)
                    t.pop("session", None)
                    out["sites"].append(t)
                return self.send_json(out)

            if path == "/api/snapshot":
                with CACHE_LOCK:
                    data = list(CACHE.values())
                with_ids = qs.get("ids")
                if with_ids:
                    wanted = set(with_ids[0].split(","))
                    data = [d for d in data if d.get("id") in wanted]
                data.sort(key=lambda x: (x.get("name") or ""))
                return self.send_json({"snapshots": data, "server_time": now_ts()})

            if path == "/api/sites":
                cfg = read_config()
                sites = []
                for s in cfg["sites"]:
                    t = dict(s)
                    t["api_key_masked"] = mask_key(s.get("api_key"))
                    t["access_token_masked"] = mask_key(s.get("access_token"))
                    t["session_masked"] = mask_key(s.get("session"))
                    t.pop("api_key", None)
                    t.pop("access_token", None)
                    t.pop("session", None)
                    sites.append(t)
                return self.send_json({"sites": sites, "settings": cfg["settings"]})

            m = re.match(r"^/api/sites/([^/]+)/credentials$", path)
            if m:
                cfg = read_config()
                for s in cfg["sites"]:
                    if s.get("id") == m.group(1):
                        return self.send_json({
                            "id": s.get("id"),
                            "base_url": s.get("base_url"),
                            "api_key": s.get("api_key") or "",
                            "access_token": s.get("access_token") or "",
                            "session": s.get("session") or "",
                            "user_id": s.get("user_id") or "",
                        })
                return self.send_json({"error": "site not found"}, 404)

            if path == "/api/health":
                # base_dir 用于在页面上标明「本页面由哪个文件夹的程序提供」，
                # 避免本机多份副本共存时混淆数据来源
                return self.send_json({"ok": True, "time": now_ts(), "base_dir": BASE_DIR})

            # ---- 静态文件 ----
            if path == "/" or path == "":
                return self.send_file(os.path.join(WEB_DIR, "index.html"))
            safe = os.path.normpath(path.lstrip("/")).replace("\\", "/")
            if safe.startswith(".."):
                return self.send_error(403)
            return self.send_file(os.path.join(WEB_DIR, safe))
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.read_body()

        try:
            if path == "/api/sites":
                return self.upsert_site(body)

            m = re.match(r"^/api/sites/([^/]+)/delete$", path)
            if m:
                return self.delete_site(m.group(1))

            m = re.match(r"^/api/sites/([^/]+)/refresh$", path)
            if m:
                res = refresh_all([m.group(1)])
                return self.send_json({"ok": True, "snapshots": res})

            if path == "/api/settings":
                with CONFIG_LOCK:
                    cfg = read_config()
                    incoming = body or {}
                    # 只接受已知字段，避免把界面已移除的旧键写回去
                    for k in list(incoming.keys()):
                        if k not in DEFAULT_SETTINGS:
                            incoming.pop(k, None)
                    cfg["settings"].update(incoming)
                    write_config(cfg)
                return self.send_json({"ok": True, "settings": cfg["settings"]})

            if path == "/api/refresh":
                ids = body.get("ids")
                res = refresh_all(ids)
                return self.send_json({"ok": True, "snapshots": res})

            if path == "/api/test-models":
                return self.send_json(test_models(body))

            if path == "/api/test-conn":
                base_url = (body.get("base_url") or "").strip()
                if not base_url:
                    return self.send_json({"ok": False, "error": "请先填 Base URL"}, 400)
                with CONFIG_LOCK:
                    cfg = read_config()
                st = dict(DEFAULT_SETTINGS)
                st.update(cfg.get("settings") or {})
                res = test_connection({
                    "base_url": base_url,
                    "api_key": body.get("api_key") or "",
                    "access_token": body.get("access_token") or "",
                    "session": body.get("session") or "",
                    "user_id": body.get("user_id") or "",
                    "insecure_ssl": bool(body.get("insecure_ssl")),
                }, st)
                return self.send_json(res)

            if path == "/api/sites/reorder":
                return self.send_json({"ok": True})

            if path == "/api/clear-cache":
                with CACHE_LOCK:
                    CACHE.clear()
                save_cache()
                return self.send_json({"ok": True})

            if path == "/api/config/import":
                cfg = read_config()
                new = body.get("config") or {}
                if isinstance(new.get("sites"), list):
                    cfg["sites"] = new["sites"]
                if isinstance(new.get("settings"), dict):
                    cfg["settings"].update(new["settings"])
                with CONFIG_LOCK:
                    write_config(cfg)
                return self.send_json({"ok": True})

            return self.send_json({"error": "not found"}, 404)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        m = re.match(r"^/api/sites/([^/]+)$", parsed.path)
        if m:
            return self.delete_site(m.group(1))
        return self.send_json({"error": "not found"}, 404)

    # ---- 业务 ----
    def upsert_site(self, body):
        with CONFIG_LOCK:
            cfg = read_config()
            site = body or {}
            sid = site.get("id")
            fields = [
                "name", "base_url", "quota_per_usd", "usd_cny",
                "enabled", "note", "user_id", "insecure_ssl", "session",
            ]
            if not sid:
                sid = uuid.uuid4().hex[:10]
                site["id"] = sid
                site["created_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                cfg["sites"].append({
                    "id": sid,
                    "name": (site.get("name") or "").strip() or "未命名站点",
                    "base_url": (site.get("base_url") or "").strip(),
                    "api_key": (site.get("api_key") or "").strip(),
                    "access_token": (site.get("access_token") or "").strip(),
                    "session": (site.get("session") or "").strip(),
                    "user_id": str(site.get("user_id") or "").strip(),
                    "quota_per_usd": site.get("quota_per_usd") or None,
                    "usd_cny": site.get("usd_cny") or None,
                    "enabled": site.get("enabled", True),
                    "note": site.get("note") or "",
                    "insecure_ssl": bool(site.get("insecure_ssl")),
                    "created_at": site["created_at"],
                })
            else:
                found = None
                for s in cfg["sites"]:
                    if s.get("id") == sid:
                        found = s
                        break
                if not found:
                    return self.send_json({"error": "site not found"}, 404)
                for k in fields:
                    if k in body:
                        found[k] = body[k]
                # 密钥：为空表示不修改
                if body.get("api_key"):
                    found["api_key"] = body["api_key"].strip()
                if body.get("access_token"):
                    found["access_token"] = body["access_token"].strip()
                if body.get("session"):
                    found["session"] = body["session"].strip()
                if "user_id" in body:
                    found["user_id"] = str(body.get("user_id") or "").strip()
            write_config(cfg)
        res = refresh_all([sid])
        return self.send_json({"ok": True, "id": sid, "snapshots": res})

    def delete_site(self, sid):
        with CONFIG_LOCK:
            cfg = read_config()
            cfg["sites"] = [s for s in cfg["sites"] if s.get("id") != sid]
            write_config(cfg)
        with CACHE_LOCK:
            CACHE.pop(sid, None)
        save_cache()
        return self.send_json({"ok": True})


def main():
    ap = argparse.ArgumentParser(description="API Hub - 多中转站聚合面板")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    url = "http://127.0.0.1:%d/" % args.port

    # 防重复启动：若端口已有实例在监听（Windows 下 SO_REUSEADDR 允许二次绑定，
    # 会导致两个实例静默共用端口、页面连到错误实例），则只打开页面，不再启动。
    try:
        with socket.create_connection(("127.0.0.1", args.port), timeout=0.5):
            print("[提示] API Hub 已在运行，不重复启动。页面地址：%s" % url)
            if not args.no_open:
                webbrowser.open(url)
            return
    except OSError:
        pass

    load_cache()
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        write_config({"settings": dict(DEFAULT_SETTINGS), "sites": []})

    cfg = read_config()
    n = len([s for s in cfg["sites"] if s.get("enabled", True)])

    print("=" * 58)
    print("  API Hub - 多中转站聚合面板")
    print("=" * 58)
    print("  地址   : %s" % url)
    print("  配置   : %s" % CONFIG_PATH)
    print("  站点数 : %d" % n)
    print("  关闭   : 在本窗口按 Ctrl+C")
    print("=" * 58)

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True

    if n:
        def bg():
            time.sleep(0.6)
            print("\n[启动] 正在刷新 %d 个站点的数据..." % n)
            refresh_all()
            print("[启动] 刷新完成\n")
        threading.Thread(target=bg, daemon=True).start()

    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
