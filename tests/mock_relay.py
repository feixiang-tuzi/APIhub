#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地模拟 New API 中转站，仅用于开发自测。"""
import json
import random
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

random.seed(7)
QUOTA_PER_UNIT = 500000
PORT = 9911

# 刷新令牌轮换的当前状态（每次成功轮换都会更新）
ROTATION = {"seq": 0, "current_rt": "rt-mock-0", "jwt": ""}
# 模拟 session Cookie 过期 + 自动续期：expired=True 时经典 session 失效，只能靠刷新令牌换新 session
SESSION_RENEW = {"expired": False, "seq": 0}


def make_logs(n=180):
    out = []
    models = ["gpt-4o", "claude-3-7-sonnet", "deepseek-chat", "gpt-4o-mini"]
    now = time.time()
    for i in range(n):
        ts = int(now - random.uniform(0, 13) * 86400)
        out.append({
            "created_at": ts,
            "type": 2,
            "model_name": random.choice(models),
            "quota": random.randint(20000, 900000),
            "prompt_tokens": random.randint(200, 9000),
            "completion_tokens": random.randint(100, 4000),
            "token_name": "default",
            "use_time": random.randint(1, 20),
        })
    out.sort(key=lambda x: -x["created_at"])
    return out


LOGS = make_logs()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        auth = self.headers.get("Authorization", "")
        uid = self.headers.get("New-Api-User", "")
        cookie = self.headers.get("Cookie", "")
        authed = (
            ("mocktoken" in auth)
            or ("session=mocksess" in cookie)
            or (ROTATION["jwt"] and auth == "Bearer " + ROTATION["jwt"])
        )
        # 模拟「会话 Cookie 已过期」：只有带 new_api_refresh 时才允许续期
        if SESSION_RENEW["expired"] and "session=mocksess" in cookie:
            authed = False

        if p.path == "/api/status":
            return self._json({"success": True, "data": {
                "version": "v0.8.12-mock", "system_name": "Mock Relay",
                "quota_per_unit": QUOTA_PER_UNIT}})

        if p.path == "/api/user/self":
            if not authed:
                return self._json({"success": False,
                                   "message": "未登录或登录已过期，请重新登录"}, 401)
            return self._json({"success": True, "message": "", "data": {
                "id": int(uid or 1), "username": "tester", "display_name": "测试账号",
                "quota": 21430000, "used_quota": 59200000, "request_count": 3521,
                "group": "default"}})

        if p.path == "/api/token/":
            if not authed:
                return self._json({"success": False, "message": "unauthorized"}, 401)
            return self._json({"success": True, "data": [
                {"name": "default", "key": "sk-abc****1234", "status": 1,
                 "unlimited_quota": False, "remain_quota": 21430000,
                 "used_quota": 59200000, "expired_time": -1, "group": "default"},
                {"name": "unlimited", "key": "sk-def****5678", "status": 1,
                 "unlimited_quota": True, "remain_quota": 0,
                 "used_quota": 100000, "expired_time": -1, "group": "vip"}]})

        if p.path == "/api/log/self":
            if not authed:
                return self._json({"success": False, "message": "unauthorized"}, 401)
            qs = urllib.parse.parse_qs(p.query)
            page = int(qs.get("p", ["0"])[0])
            size = int(qs.get("page_size", ["100"])[0])
            start = int(qs.get("start_timestamp", ["0"])[0])
            end = int(qs.get("end_timestamp", [str(int(time.time()))])[0])
            f = [x for x in LOGS if start <= x["created_at"] <= end]
            return self._json({"success": True, "data": f[page * size:(page + 1) * size]})

        if p.path == "/v1/models":
            if not auth.startswith("Bearer sk-"):
                return self._json({"error": {"message": "invalid key"}}, 401)
            ids = ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet", "claude-3-7-sonnet",
                   "deepseek-chat", "deepseek-reasoner", "gemini-2.0-flash",
                   "o3-stream-only"]
            return self._json({"object": "list", "data": [{"id": i, "object": "model"} for i in ids]})

        if p.path == "/v1/dashboard/billing/subscription":
            if not auth.startswith("Bearer sk-"):
                return self._json({"error": {"message": "invalid api key"}}, 401)
            if "unlim" in auth:  # 仿"无限额度"站点：返回 1e8 占位值
                return self._json({"object": "billing_subscription",
                                   "hard_limit_usd": 100000000,
                                   "soft_limit_usd": 100000000,
                                   "system_hard_limit_usd": 100000000})
            return self._json({"object": "billing_subscription", "hard_limit_usd": 33.5,
                               "soft_limit_usd": 20.0, "system_hard_limit_usd": 33.5})

        if p.path == "/v1/dashboard/billing/usage":
            if not auth.startswith("Bearer sk-"):
                return self._json({"error": {"message": "invalid api key"}}, 401)
            return self._json({"object": "list", "total_usage": 11842.5})

        return self._json({"error": "not found", "path": p.path}, 404)

    def _sse(self, model):
        """以 SSE 形式返回一个最小 chat 流。"""
        chunks = [
            {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "model": model,
             "choices": [{"index": 0, "delta": {"role": "assistant", "content": "h"},
                          "finish_reason": None}]},
            {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "model": model,
             "choices": [{"index": 0, "delta": {"content": "i"}, "finish_reason": "stop"}]},
        ]
        payload = "".join("data: %s\n\n" % json.dumps(c, ensure_ascii=False) for c in chunks)
        payload += "data: [DONE]\n\n"
        b = payload.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    # ----- 连通性测试：chat/completions -----
    def do_POST(self):
        p = urllib.parse.urlparse(self.path)
        if p.path not in ("/v1/chat/completions", "/api/user/auth/refresh"):
            return self._json({"error": "not found", "path": p.path}, 404)

        if p.path == "/v1/chat/completions":
            auth = self.headers.get("Authorization", "")
            if not auth.startswith("Bearer sk-"):
                return self._json({"error": {"message": "invalid api key"}}, 401)
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except Exception:
                return self._json({"error": {"message": "bad json"}}, 400)
            model = body.get("model") or ""
            # 模拟：模型名带 "broken" 视为不可用
            if "broken" in model or "deprecated" in model:
                return self._json({"error": {"message": "The model `%s` does not exist" % model,
                                             "type": "invalid_request_error"}}, 404)
            # 模拟：只支持流式的模型（如 o 系列推理模型），非流式直接被拒
            if "stream-only" in model and not body.get("stream"):
                return self._json({"error": {"message": "This model only supports streaming, "
                                                        "please set stream=true",
                                             "type": "invalid_request_error"}}, 400)
            if body.get("stream"):
                return self._sse(model)
            return self._json({
                "id": "chatcmpl-mock", "object": "chat.completion", "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })

        # 刷新令牌轮换
        cookie = self.headers.get("Cookie", "")
        rt = ""
        if "new_api_refresh=" in cookie:
            rt = cookie.split("new_api_refresh=", 1)[1].split(";", 1)[0].strip()
        if rt != ROTATION["current_rt"]:
            return self._json({"code": "AUTH_UNAUTHORIZED",
                               "message": "invalid refresh token", "success": False}, 401)

        # 一次性轮换：旧令牌作废，发新令牌
        ROTATION["seq"] += 1
        n = ROTATION["seq"]
        ROTATION["current_rt"] = "rt-mock-%d" % n
        jwt = "mockjwt-%d" % n
        ROTATION["jwt"] = jwt

        b = json.dumps({"success": True, "data": {
            "accessToken": jwt, "token_type": "Bearer",
            "accessExpiresAt": int(time.time()) + 3600,
            "user": {"id": 4004, "username": "rotater", "quota": 31415900,
                     "used_quota": 27182800, "request_count": 777, "group": "default"},
            "session": {"sid": "sid-%d" % n, "current": True},
        }}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie", "new_api_refresh=%s; Path=/api/user/auth; HttpOnly" % ROTATION["current_rt"])
        # 续期模式：同时下发新的 session（客户端应抓住它并回写）
        if SESSION_RENEW["expired"]:
            SESSION_RENEW["seq"] += 1
            self.send_header("Set-Cookie",
                             "session=mocksess-%d; Path=/; HttpOnly" % SESSION_RENEW["seq"])
            # 模拟真实站点：续期后经典 session 恢复有效
            SESSION_RENEW["expired"] = False
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


# --------------------------------------------------------------------------
# 第二种形态：自研 AI 网关
# 只有标准 /v1/* 接口，没有 New API 的 /api/*，也没有 dashboard/billing，
# 但用同一个 sk- Key 就能从 /v1/usage 拿到余额与用量明细。
# --------------------------------------------------------------------------
GW_PORT = 9912


def _gw_days():
    from datetime import datetime, timedelta

    today = datetime.now().date()
    out = []
    for ago, req, cost in ((5, 20, 0.32097174), (2, 9, 0.44795664), (0, 1, 0.05)):
        d = today - timedelta(days=ago)
        out.append({
            "date": d.strftime("%Y-%m-%d"), "requests": req,
            "input_tokens": 1000 * req, "output_tokens": 100 * req,
            "cache_read_tokens": 200 * req, "cache_write_tokens": 0,
            "total_tokens": 1300 * req, "cost": round(cost * 3, 8),
            "actual_cost": cost,
        })
    return out


GW_DAILY = _gw_days()


class GatewayH(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        auth = self.headers.get("Authorization", "")
        ok = auth.startswith("Bearer sk-gw")

        if p.path == "/v1/models":
            if not ok:
                return self._json({"code": "INVALID_API_KEY", "message": "Invalid API key"}, 401)
            ids = ["gpt-6.1-sol", "gpt-5.6-terra", "gpt-image-2.5-sunburst"]
            return self._json({"object": "list", "data": [{"id": i, "object": "model"} for i in ids]})

        if p.path == "/v1/usage":
            if not auth:
                return self._json({"code": "API_KEY_REQUIRED",
                                   "message": "API key is required in Authorization header"}, 401)
            if not ok:
                return self._json({"code": "INVALID_API_KEY", "message": "Invalid API key"}, 401)
            total_cost = round(sum(d["actual_cost"] for d in GW_DAILY), 8)
            return self._json({
                "balance": 12.60642469, "remaining": 12.60642469, "unit": "USD",
                "isValid": True, "mode": "unrestricted", "planName": "钱包余额",
                "daily_usage": GW_DAILY,
                "model_stats": [
                    {"model": "gpt-6.1-sol", "requests": 118, "input_tokens": 1940509,
                     "output_tokens": 41125, "cache_creation_tokens": 0,
                     "cache_read_tokens": 5791574, "total_tokens": 7773208,
                     "cost": 4.8714254, "actual_cost": 1.46142762},
                    {"model": "gpt-5.6-terra", "requests": 20, "input_tokens": 366244,
                     "output_tokens": 12277, "cache_creation_tokens": 0,
                     "cache_read_tokens": 950469, "total_tokens": 1328990,
                     "cost": 1.0699058, "actual_cost": 0.32097174},
                    {"model": "gpt-image-2.5-sunburst", "requests": 1, "input_tokens": 539,
                     "output_tokens": 1372, "cache_creation_tokens": 0,
                     "cache_read_tokens": 0, "total_tokens": 1911,
                     "cost": 0.3, "actual_cost": 0.3},
                ],
                "usage": {"total": {"requests": 139, "actual_cost": total_cost,
                                    "cost": 6.2413312, "input_tokens": 2307292,
                                    "output_tokens": 54774, "cache_read_tokens": 6742043,
                                    "cache_creation_tokens": 0, "total_tokens": 9104109},
                          "today": {"requests": 0, "actual_cost": 0},
                          "rpm": 0, "tpm": 0, "average_duration_ms": 20006.48},
            })

        if p.path == "/api/status" or p.path == "/api/user/self":
            return self._json({"error": "not found"}, 404)
        if p.path.startswith("/v1/dashboard/"):
            return self._json({"error": "not found"}, 404)
        return self._json({"error": "not found", "path": p.path}, 404)


if __name__ == "__main__":
    import threading

    print("mock New API relay on http://127.0.0.1:%d" % PORT)
    print("mock gateway       on http://127.0.0.1:%d" % GW_PORT)
    threading.Thread(
        target=ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever, daemon=True
    ).start()
    ThreadingHTTPServer(("127.0.0.1", GW_PORT), GatewayH).serve_forever()
