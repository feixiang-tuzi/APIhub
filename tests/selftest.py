#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""API Hub 自测：在进程内起一个模拟中转站，跑通全部探测链路。"""
import os
import sys
import threading
import urllib.request

# 控制台编码兜底：英文版 Windows（cp1252）下 print 中文会 UnicodeEncodeError，
# 导致 CI 在 windows-latest 矩阵上整组失败。强制 UTF-8 并允许替换字符。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

# 本机回环直连，绕过系统代理
urllib.request.proxy_bypass = lambda host: True
os.environ["no_proxy"] = "127.0.0.1,localhost"

from http.server import ThreadingHTTPServer  # noqa: E402

import mock_relay  # noqa: E402
import server  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  [OK]   " if cond else "  [FAIL] ") + name + ("  -> " + str(extra) if extra else ""))


def main():
    mock = ThreadingHTTPServer(("127.0.0.1", mock_relay.PORT), mock_relay.H)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    settings = dict(server.DEFAULT_SETTINGS)
    settings["timeout"] = 8
    settings["usage_days"] = 14

    print("\n=== 1. 工具函数 ===")
    check("normalize_base 去掉 /v1", server.normalize_base("https://a.com/v1") == ("https://a.com", "https://a.com/v1"))
    check("normalize_base 保留路径", server.normalize_base("https://a.com/api/") == ("https://a.com/api", "https://a.com/api/v1"))
    check("normalize_base 自动补协议", server.normalize_base("a.com")[0] == "https://a.com")
    check("mask_key 脱敏", server.mask_key("sk-1234567890abcdef") == "sk-123********cdef", server.mask_key("sk-1234567890abcdef"))
    check("build_cookie 纯值补前缀", server.build_cookie("abc123") == "session=abc123")
    check("build_cookie 保留键值对", server.build_cookie("session=abc123") == "session=abc123")
    check("build_cookie 保留完整串", server.build_cookie("a=1; b=2") == "a=1; b=2")
    check("build_cookie 空值", server.build_cookie("") == "")

    print("\n=== 0b. 会话 Cookie 复制错了的识别 ===")
    check("识别 new_api_has_session 标记", server.session_looks_wrong("new_api_has_session=1") is not None,
          server.session_looks_wrong("new_api_has_session=1"))
    check("识别纯值 1", server.session_looks_wrong("1") is not None)
    check("识别过短内容", server.session_looks_wrong("abc") is not None)
    check("正常长会话不误报", server.session_looks_wrong("MTc3MTY4OTk0fDIwMjYtMTAtMTR8aXB8MTcyLjA%3D") is None)
    check("空值不报", server.session_looks_wrong("") is None)
    check("auth_attempts 仅令牌", [l for l, _ in server.auth_attempts({"access_token": "t"})] == ["令牌", "令牌"],
          [l for l, _ in server.auth_attempts({"access_token": "t"})])
    check("auth_attempts 仅 Cookie", [l for l, _ in server.auth_attempts({"session": "s", "user_id": "1"})] == ["Cookie", "Cookie"],
          [l for l, _ in server.auth_attempts({"session": "s", "user_id": "1"})])
    check("auth_attempts 两者都有按序", [l for l, _ in server.auth_attempts({"access_token": "t", "session": "s", "user_id": "1"})][:2] == ["令牌", "令牌"],
          [l for l, _ in server.auth_attempts({"access_token": "t", "session": "s", "user_id": "1"})])

    print("\n=== 2. 完整凭证站点（access_token + sk key）===")
    site_full = {
        "id": "t-full", "name": "模拟站·完整", "base_url": "http://127.0.0.1:%d" % mock_relay.PORT,
        "api_key": "sk-mock-abcdefghijklmn", "access_token": "mocktoken-xyz", "user_id": "4004",
        "enabled": True,
    }
    s = server.probe_site(site_full, settings)
    check("探测成功", s["ok"] is True)
    check("模式 = access_token", s["mode"] == "access_token", s["mode"])
    check("读到站点版本", s["version"] == "v0.8.12-mock", s["version"])
    check("quota 解析正确", s["quota"] == 21430000, s["quota"])
    check("余额换算 USD 正确", abs(s["balance_usd"] - 42.86) < 0.001, s["balance_usd"])
    check("已用换算 USD 正确", abs(s["used_usd"] - 118.4) < 0.001, s["used_usd"])
    check("请求数", s["request_count"] == 3521)
    check("模型列表 8 个", s["model_count"] == 8, s["model_count"])
    check("令牌列表 2 个", len(s["tokens"]) == 2, len(s["tokens"]))
    check("用量按天补齐 14 天", len(s["usage_by_day"]) == 14, len(s["usage_by_day"]))
    check("用量按模型有数据", len(s["usage_by_model"]) == 4, [m["model"] for m in s["usage_by_model"]])
    check("近 14 天消耗有值", (s["range_used_usd"] or 0) > 0, round(s["range_used_usd"] or 0, 2))
    check("无错误", not s["errors"], s["errors"])
    total_req = sum(d["requests"] for d in s["usage_by_day"])
    check("日志聚合请求数 = 180", total_req == 180, total_req)

    print("\n=== 3. 仅 sk- Key 站点（走兼容计费接口）===")
    site_key = dict(site_full, id="t-key", name="模拟站·仅Key", access_token="", user_id="")
    s2 = server.probe_site(site_key, settings)
    check("探测成功", s2["ok"] is True)
    check("模式 = apikey_billing", s2["mode"] == "apikey_billing", s2["mode"])
    check("余额 = hard_limit_usd", abs(s2["balance_usd"] - 33.5) < 0.001, s2["balance_usd"])
    check("已用 = total_usage/100", abs(s2["used_usd"] - 118.425) < 0.001, s2["used_usd"])
    check("仍有模型列表", s2["model_count"] == 8, s2["model_count"])
    check("给出了提示信息", any("令牌" in e for e in s2["errors"]), s2["errors"])

    print("\n=== 4. 无有效凭证（只给坏 Key）===")
    site_bad = dict(site_full, id="t-bad", name="模拟站·坏Key", access_token="", user_id="", api_key="bad-key")
    s3 = server.probe_site(site_bad, settings)
    check("判定为不可用", s3["ok"] is False, s3["ok"])
    check("模型为空", s3["model_count"] == 0)
    check("记录为可达但无数据", s3["reachable"] is True and len(s3["errors"]) >= 1, s3["errors"])

    print("\n=== 5. 站点完全打不通 ===")
    site_dead = dict(site_full, id="t-dead", name="死站", base_url="http://127.0.0.1:1", api_key="sk-x", access_token="t")
    s4 = server.probe_site(site_dead, settings)
    check("未抛异常且标记失败", s4["ok"] is False)
    check("标记为不可达", s4["reachable"] is False)
    check("debug 有错误记录", any("error" in str(v).lower() for v in s4["debug"].values()))

    print("\n=== 6. 只有会话 Cookie（站点没有访问令牌时的兜底）===")
    site_cookie = dict(site_full, id="t-cookie", name="模拟站·Cookie",
                       access_token="", session="mocksess-abc", user_id="4004")
    s5 = server.probe_site(site_cookie, settings)
    check("探测成功", s5["ok"] is True)
    check("模式 = access_token", s5["mode"] == "access_token", s5["mode"])
    check("标注使用了 Cookie", s5["auth_used"] == "Cookie", s5.get("auth_used"))
    check("余额读取正确", abs(s5["balance_usd"] - 42.86) < 0.001, s5["balance_usd"])
    check("令牌列表可读", len(s5["tokens"]) == 2, len(s5["tokens"]))
    check("用量日志可读", len(s5["usage_by_day"]) == 14, len(s5["usage_by_day"]))

    print("\n=== 7. 未填任何账户凭证 ===")
    site_none = dict(site_full, id="t-none", name="模拟站·只填Key", access_token="", session="", user_id="")
    s6 = server.probe_site(site_none, settings)
    check("仍能拿到模型", s6["model_count"] == 8, s6["model_count"])
    check("提示需要凭证", any("访问令牌" in e for e in s6["errors"]), s6["errors"])

    print("\n=== 8. 自研网关站点（只有 /v1/*，靠 sk- Key 的 /v1/usage）===")
    mock_gw = ThreadingHTTPServer(("127.0.0.1", mock_relay.GW_PORT), mock_relay.GatewayH)
    threading.Thread(target=mock_gw.serve_forever, daemon=True).start()

    site_gw = {
        "id": "t-gw", "name": "示例网关站", "base_url": "https://gw.example.com",
        "api_key": "sk-gw-abcdefghijklmn", "access_token": "", "session": "", "user_id": "",
        "enabled": True,
    }
    site_gw["base_url"] = "http://127.0.0.1:%d" % mock_relay.GW_PORT
    s7 = server.probe_site(site_gw, settings)
    check("探测成功", s7["ok"] is True)
    check("模式 = gateway_usage", s7["mode"] == "gateway_usage", s7["mode"])
    check("余额读取正确", abs(s7["balance_usd"] - 12.60642469) < 1e-6, s7["balance_usd"])
    check("已用 = usage.total.actual_cost", 0 < s7["used_usd"] < 1, s7["used_usd"])
    check("请求数", s7["request_count"] == 139, s7["request_count"])
    check("套餐/计划名", s7["plan_name"] == "钱包余额", s7["plan_name"])
    check("模型列表 3 个", s7["model_count"] == 3, s7["model_count"])
    check("按模型用量 3 条且降序",
          [m["model"] for m in s7["usage_by_model"]][0] == "gpt-6.1-sol"
          and s7["usage_by_model"][0]["quota"] > s7["usage_by_model"][1]["quota"],
          [(m["model"], m["quota"]) for m in s7["usage_by_model"]])
    check("按天用量补齐为连续日期且含今天", len(s7["usage_by_day"]) == 6
          and s7["usage_by_day"][-1]["date"] == server.datetime.now().strftime("%Y-%m-%d"),
          [d["date"] for d in s7["usage_by_day"]])
    check("天数与模型数对得上（补零日 requests=0）",
          sum(d["requests"] for d in s7["usage_by_day"]) == 30,
          [d["requests"] for d in s7["usage_by_day"]])
    check("quota 按换算比折算", s7["usage_by_day"][-1]["quota"] > 0
          and abs(s7["usage_by_day"][0]["quota"] / s7["quota_per_usd"] - 0.32097174) < 1e-6,
          s7["usage_by_day"][0])
    check("近 N 天消耗有值", (s7["range_used_usd"] or 0) > 0, s7["range_used_usd"])
    check("token 汇总解析", s7["token_usage"]["total"] == 9104109, s7["token_usage"])
    check("无错误（不需要访问令牌）", not s7["errors"], s7["errors"])
    check("debug 含 gw_usage 原始返回", "gw_usage" in s7["debug"], list(s7["debug"].keys()))

    print("\n=== 9. 网关站点凭证错误 ===")
    site_gw_bad = dict(site_gw, id="t-gw-bad", api_key="sk-wrong-key")
    s8 = server.probe_site(site_gw_bad, settings)
    check("判定为不可用", s8["ok"] is False, s8["ok"])
    check("主机可达（401 也算可达）", s8["reachable"] is True)
    check("未误用网关数据", s8["balance_usd"] is None, s8["balance_usd"])
    check("给了排查提示", any("无效" in e for e in s8["errors"]), s8["errors"])

    print("\n=== 10. Cookie 复制错了 / 无限额度占位 ===")
    site_wrongcookie = dict(site_full, id="t-wc", name="模拟站·错Cookie",
                            session="1", access_token="", user_id="4004")
    s9 = server.probe_site(site_wrongcookie, settings)
    check("探测结果给出改法提示", any("session" in e for e in s9["errors"]), s9["errors"])

    site_unlim = dict(site_full, id="t-unlim", name="模拟站·无限", access_token="",
                      session="", user_id="", api_key="sk-mock-unlimited")
    s10 = server.probe_site(site_unlim, settings)
    check("余额不被误显示为 1 亿", s10["balance_usd"] is None, s10["balance_usd"])
    check("debug 记录了忽略原因", "billing_note" in s10["debug"], s10["debug"].get("billing_note"))

    print("\n=== 11. 刷新令牌轮换（sub2api / 新版 new-api 系）===")
    import mock_relay as _m
    _m.ROTATION.update({"seq": 0, "current_rt": "rt-mock-0", "jwt": ""})
    _m.SESSION_RENEW["expired"] = False
    site_rot = dict(site_full, id="t-rot", name="模拟站·轮换", access_token="",
                    session="rt-mock-0", user_id="4004", api_key="")
    s11 = server.probe_site(site_rot, settings)
    check("探测成功", s11["ok"] is True, s11["errors"])
    check("模式 = access_token", s11["mode"] == "access_token", s11["mode"])
    check("标注使用了 Cookie", s11["auth_used"] == "Cookie", s11.get("auth_used"))
    check("余额换算正确", abs(s11["balance_usd"] - 62.8318) < 0.001, s11["balance_usd"])
    check("请求数", s11["request_count"] == 777, s11["request_count"])
    check("旧令牌已被轮换", site_rot["session"] != "rt-mock-0", site_rot["session"])
    # 凭证被换新 → 会打上落盘标记（新版走会话续期的 _renewed，旧版走 _rotated）
    check("标记了需要落盘", site_rot.get("_rotated") is True or site_rot.get("_renewed") is True,
          {k: v for k, v in site_rot.items() if k.startswith("_")})
    check("令牌列表可继续用 JWT 读", len(s11["tokens"]) == 2, len(s11["tokens"]))
    check("用量日志可读", len(s11["usage_by_day"]) == 14, len(s11["usage_by_day"]))
    site_rot.pop("_rotated", None)  # 手动清掉，避免影响后续断言
    site_rot.pop("_renewed", None)

    print("\n=== 12. 轮换后的新令牌可复用 ===")
    s11b = server.probe_site(site_rot, settings)  # site_rot.session 已是新令牌
    check("二次探测成功", s11b["ok"] is True, s11b["errors"])
    check("再次轮换", site_rot["session"] not in ("rt-mock-0", ""), site_rot["session"])

    print("\n=== 13. 失效的刷新令牌 ===")
    site_rot_bad = dict(site_rot, id="t-rot-bad", session="rt-already-used", api_key="")
    s12 = server.probe_site(site_rot_bad, settings)
    check("轮换未成功（不是 access_token 模式）", s12["mode"] != "access_token", s12["mode"])
    check("debug 记录轮换被拒", "token_rotation" in s12["debug"], list(s12["debug"].keys()))

    print("\n=== 13b. 会话 Cookie 过期后自动续期 ===")
    import mock_relay as _m2
    _m2.ROTATION.update({"seq": 0, "current_rt": "rt-mock-0", "jwt": ""})
    _m2.SESSION_RENEW.update({"expired": True, "seq": 0})
    # 用户粘的是完整 Cookie（含 session + new_api_refresh），session 已过期，
    # 程序应拿 refresh 换新 session 并回写
    expired_cookie = ("session=mocksess-expired-long-value-abcdefgh; "
                      "new_api_refresh=rt-mock-0")
    site_exp = dict(site_full, id="t-exp", name="模拟站·过期Cookie",
                    access_token="", api_key="", session=expired_cookie, user_id="4004")
    s13 = server.probe_site(site_exp, settings)
    check("过期后仍能自动续期成功", s13["ok"] is True, s13["errors"])
    check("续期后拿到完整数据", s13["mode"] == "access_token", s13["mode"])
    check("标注使用了 Cookie", s13.get("auth_used") == "Cookie", s13.get("auth_used"))
    # 续期接口返回的是站点账号本身的数据（quota 31415900 → $62.8318）
    check("余额读取正确", abs(s13["balance_usd"] - 62.8318) < 0.001, s13["balance_usd"])
    check("debug 记录了续期过程", "session_renew" in s13["debug"], list(s13["debug"].keys()))
    check("新 session 已回写配置", site_exp["session"] != expired_cookie, site_exp["session"])
    check("标记了需要落盘", site_exp.pop("_renewed", False) is True)
    _m2.SESSION_RENEW["expired"] = False

    print("\n=== 14. 模型连通性测试 ===")
    # 原来会调 server.refresh_all()，但那会去探测真实配置里的所有站点（网络慢时拖死自测）。
    # 这里只需要填充 CURRENT_SETTINGS，直接赋值即可。
    server.CURRENT_SETTINGS = dict(server.DEFAULT_SETTINGS)
    # 自测站点不在真实配置里，直接注入索引
    server.SITE_INDEX.clear()
    server.SITE_INDEX.update({
        "t-full": dict(site_full, session=""),
        "t-none": dict(site_full, id="t-none", session=""),
        "t-dead": dict(site_dead, session=""),
    })
    r = server.test_models({"items": [
        {"site_id": "t-full", "model": "gpt-4o"},
        {"site_id": "t-full", "model": "demo-broken-model"},
        {"site_id": "t-full", "model": "gpt-4o"},
        {"site_id": "t-none", "model": "gpt-4o-mini"},
        {"site_id": "no-such-site", "model": "gpt-4o"},
        {"site_id": "t-full", "model": "o3-stream-only"},
    ]})
    check("接口返回成功", r.get("ok") is True)
    res = {x["model"] + "@" + str(x["site_id"]): x for x in r["results"]}
    good = res.get("gpt-4o@t-full")
    bad = res.get("demo-broken-model@t-full")
    nos = res.get("gpt-4o@no-such-site")
    so = res.get("o3-stream-only@t-full")
    check("正常模型判定连通", good and good["ok"] is True, good and good["error"])
    check("记录了耗时", good and good["ms"] >= 0, good and good["ms"])
    check("无效模型判定失败并带原因", bad and bad["ok"] is False and "does not exist" in (bad["error"] or ""),
          bad and bad["error"])
    check("不存在的站点不报错而是返回失败项", nos and nos["ok"] is False and nos["error"], nos and nos["error"])
    check("只支持流式的模型自动重试后判定连通", so and so["ok"] is True, so and so["error"])
    check("流式通过的项标记了 stream", so and so.get("stream") is True, so and so.get("stream"))
    check("结果条数与请求一致", len(r["results"]) == 6, len(r["results"]))
    check("空 items 被拒", server.test_models({"items": []}).get("ok") is False)
    check("URL 无效站点返回失败", server.test_models({"items": [
        {"site_id": "t-dead", "model": "gpt-4o"}]})["results"][0]["ok"] is False)

    # 强制只用流式 / 只用非流式
    r2 = server.test_models({"items": [{"site_id": "t-full", "model": "o3-stream-only"}], "mode": "plain"})
    check("限定非流式时只支持流式的模型会失败", r2["results"][0]["ok"] is False, r2["results"][0].get("error"))
    r3 = server.test_models({"items": [{"site_id": "t-full", "model": "gpt-4o"}], "mode": "stream"})
    check("限定流式时普通模型也判连通", r3["results"][0]["ok"] is True, r3["results"][0].get("error"))

    print("\n=== 15. 编辑站点不丢凭证（回归：曾把 session 无条件清空）===")
    # 用一个临时配置文件，避免污染真实 config.json；并屏蔽后台探测（域名是假的，会白等）
    _orig_cfg_path = server.CONFIG_PATH
    _orig_start_refresh = server.start_refresh
    server.CONFIG_PATH = os.path.join(server.DATA_DIR, "_selftest_cfg.json")
    server.start_refresh = lambda ids=None: None

    class _FakeHandler:
        def send_json(self, obj, code=200):
            return obj

    _h = _FakeHandler()
    try:
        server.write_config({"settings": dict(server.DEFAULT_SETTINGS), "sites": []})
        server.Handler.upsert_site(_h, {
            "name": "凭证站", "base_url": "https://cred.example.com",
            "api_key": "sk-orig", "access_token": "tok-orig",
            "session": "session=ORIG", "user_id": "4004",
        })
        _sid = server.read_config()["sites"][0]["id"]

        # ① 只改备注（新前端行为：不提交空凭证）
        server.Handler.upsert_site(_h, {
            "id": _sid, "name": "凭证站", "base_url": "https://cred.example.com",
            "user_id": "4004", "note": "只改备注", "enabled": True,
        })
        _s = server.read_config()["sites"][0]
        check("只改备注：session 不丢", _s["session"] == "session=ORIG", repr(_s["session"]))
        check("只改备注：api_key 不丢", _s["api_key"] == "sk-orig", repr(_s["api_key"]))
        check("只改备注：access_token 不丢", _s["access_token"] == "tok-orig", repr(_s["access_token"]))

        # ② 旧前端行为：显式提交空串，后端也必须兜住（留空 = 不修改）
        server.Handler.upsert_site(_h, {
            "id": _sid, "name": "凭证站", "base_url": "https://cred.example.com",
            "api_key": "", "access_token": "", "session": "",
            "user_id": "4004", "enabled": True,
        })
        _s = server.read_config()["sites"][0]
        check("提交空串：session 被兜住", _s["session"] == "session=ORIG", repr(_s["session"]))
        check("提交空串：api_key 被兜住", _s["api_key"] == "sk-orig", repr(_s["api_key"]))

        # ③ 确实要换凭证时仍能写入
        server.Handler.upsert_site(_h, {
            "id": _sid, "name": "凭证站", "base_url": "https://cred.example.com",
            "session": "session=NEW", "user_id": "4004", "enabled": True,
        })
        _s = server.read_config()["sites"][0]
        check("新凭证能正常写入", _s["session"] == "session=NEW", repr(_s["session"]))
        check("普通字段可正常修改", _s["note"] == "只改备注", repr(_s["note"]))
    finally:
        try:
            os.remove(server.CONFIG_PATH)
        except OSError:
            pass
        server.CONFIG_PATH = _orig_cfg_path
        server.start_refresh = _orig_start_refresh

    print("  通过 %d 项，失败 %d 项" % (len(PASS), len(FAIL)))
    if FAIL:
        print("  失败项：", FAIL)
    print("=" * 46)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
