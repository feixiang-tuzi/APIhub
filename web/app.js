/* ==========================================================================
   API Hub · 前端逻辑
   ========================================================================== */

const API = '';
const PALETTE = ['#4f8ef7', '#35c39c', '#9b8cf9', '#f8a06a', '#63b3ed',
                 '#f6ad55', '#68d391', '#b794f4', '#fc8181', '#4fd1c5'];

const state = {
  snapshots: [],
  sites: [],
  settings: {},
  view: 'overview',
  loading: false,
  timer: null,
  usageCny: false,
  hiddenSites: new Set(),
  modelSearch: '',
  onlyCommon: false,
  detailId: null,
  detailRange: null,       // 单站详情的时间范围（天），null = 跟随全局
  detailTest: {},          // 单站详情的模型连通性结果
  modelTest: {},
  layout: localStorage.getItem('apihub_layout') || 'card',   // card | list
  siteSearch: '',
  sortKey: 'custom',       // custom | name | balance | used | requests | models | note | status
  sortDir: 1,              // 1 升序 / -1 降序
  siteOrder: (() => {
    try { return JSON.parse(localStorage.getItem('apihub_site_order') || '[]'); }
    catch (e) { return []; }
  })(),                    // 自定义顺序（站点 id 数组）
  usageRange: null,        // 用量分析时间范围（天）
  testMode: localStorage.getItem('apihub_test_mode') || 'auto',  // auto | plain | stream
};

// 常用时间范围（天）→ 显示名（上限由后端 LOG_FETCH_DAYS 决定，默认 120）
const RANGE_OPTIONS = [
  { days: 1, label: '24 小时' },
  { days: 3, label: '3 天' },
  { days: 7, label: '7 天' },
  { days: 14, label: '14 天' },
  { days: 30, label: '30 天' },
  { days: 60, label: '60 天' },
  { days: 120, label: '120 天' },
];

/* ------------------------------ 工具 ------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtNum(n, d = 0) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtUsd(n, d = 2) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// 取站点的充值比（1 USD 额度 = 多少元人民币）：
// 站点手动填 > 站点 /api/status 自动识别 > 全局设置 > 默认 1
function cnyOf(s) {
  return Number(s?.usd_cny) || Number(state.settings.usd_cny) || 1;
}
// ¥X（主显示）—— 已按充值比换算
function fmtCny(usd, s) {
  if (usd == null || isNaN(usd)) return '—';
  const r = cnyOf(s);
  return '¥' + (usd * r).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// ≈ $Y（副显示）—— USD 原值
function fmtUsdSub(usd, d = 2) {
  if (usd == null || isNaN(usd)) return '';
  return '≈ $' + Number(usd).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtMoney(v) {
  if (v == null || isNaN(v)) return '—';
  return state.usageCny ? '¥' + (v * (state.settings.usd_cny || 1)).toFixed(2)
                        : '$' + Number(v).toFixed(3);
}

function fmtCompact(n) {
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + 'w';
  return fmtNum(n);
}

function timeAgo(ts) {
  if (!ts) return '从未';
  const d = Math.floor(Date.now() / 1000 - ts);
  if (d < 5) return '刚刚';
  if (d < 60) return d + ' 秒前';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  return Math.floor(d / 86400) + ' 天前';
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(18px)';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const txt = await res.text();
  try { return JSON.parse(txt); }
  catch (e) { throw new Error('响应解析失败：' + txt.slice(0, 120)); }
}

function siteColor(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function copyText(text, label) {
  const done = () => toast(label || '已复制到剪贴板', 'ok');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); }
    catch (e) { toast('复制失败，请手动选择', 'err'); }
    ta.remove();
  }
}

function modeLabel(mode) {
  return ({
    access_token: '完整数据',
    apikey_billing: 'Key 计费接口',
    gateway_usage: '网关用量接口',
    models_only: '仅模型列表',
  })[mode] || '未探测';
}

/* ------------------------------ 时间范围工具 ------------------------------ */
// 当前生效的全局统计天数（不超过后端 LOG_FETCH_DAYS 抓取上限）
function globalDays() {
  const d = Number(state.settings.usage_days) || 14;
  const cap = Number(state.settings.max_usage_days) || 120;
  return Math.min(d, cap);
}

// 用量分析页当前天数
function usageDays() {
  return state.usageRange || globalDays();
}

// 单站详情页当前天数
function detailDays() {
  return state.detailRange || globalDays();
}

// 从完整日序列里截取最后 n 天（数据可能只有更少，就返回全部）
function tailDays(days, n) {
  const list = days || [];
  if (!n || n <= 0 || list.length <= n) return list;
  return list.slice(list.length - n);
}

// 按天序列聚合出该时段的合计（quota / 请求数 / 模型明细）
function sliceUsage(s, n) {
  const byDay = tailDays(s.usage_by_day, n);
  const dates = new Set(byDay.map(d => d.date));
  const quota = byDay.reduce((a, d) => a + (d.quota || 0), 0);
  const requests = byDay.reduce((a, d) => a + (d.requests || 0), 0);
  // 模型明细：网关类接口给的是累计值，没法按天切，只能整体带上并标注
  const byModel = s.usage_by_model || [];
  return { byDay, dates, quota, requests, byModel, sliced: dates.size !== (s.usage_by_day || []).length };
}

/* ------------------------------ 加载 ------------------------------ */
async function loadConfig() {
  const cfg = await api('/api/config');
  state.sites = cfg.sites || [];
  state.settings = cfg.settings || {};
  const bd = document.getElementById('run-dir');
  if (bd && cfg.base_dir) bd.textContent = '程序目录：' + cfg.base_dir;
}

async function loadSnapshot() {
  const r = await api('/api/snapshot');
  state.snapshots = r.snapshots || [];
}

// 轮询快照直到后台探测结束：期间每 1.5s 拉一次，卡片陆续刷新，而不是干等全部完成
async function pollSnapshots(maxMs = 300000) {
  const t0 = Date.now();
  let refreshing = true;
  while (refreshing && Date.now() - t0 < maxMs) {
    const r = await api('/api/snapshot');
    state.snapshots = r.snapshots || [];
    renderAll();
    refreshing = !!r.refreshing;
    if (refreshing) await new Promise(res => setTimeout(res, 1500));
  }
  return !refreshing;
}

async function refreshAll(ids) {
  if (state.loading) return;
  state.loading = true;
  setLive('loading');
  $('#btn-refresh').disabled = true;
  try {
    // 探测在后台执行，接口立即返回；这里轮询渐进更新界面
    await api('/api/refresh', { method: 'POST', body: JSON.stringify({ ids: ids || null }) });
    await pollSnapshots();
    toast(ids ? '已刷新 1 个站点' : `已刷新 ${state.snapshots.length} 个站点`, 'ok');
  } catch (e) {
    toast('刷新失败：' + e.message, 'err');
  } finally {
    state.loading = false;
    $('#btn-refresh').disabled = false;
    setLive(state.timer ? 'on' : 'paused');
    $('#foot-status').textContent = '数据更新于 ' + new Date().toLocaleTimeString('zh-CN');
  }
}

function setLive(mode) {
  const d = $('#live-dot');
  d.className = 'dot-live' + (mode === 'loading' ? ' loading' : mode === 'paused' ? ' paused' : '');
}

/* ------------------------------ 顶部统计 ------------------------------ */
function renderStats() {
  const list = state.snapshots.filter(s => s.enabled !== false);
  let bal = 0, used = 0, req = 0, models = 0, low = 0, down = 0;
  let hasBal = false, hasUsed = false;
  const modelSet = new Set();

  list.forEach(s => {
    if (s.balance_usd != null) { bal += s.balance_usd; hasBal = true; }
    if (s.used_usd != null) { used += s.used_usd; hasUsed = true; }
    if (s.request_count) req += s.request_count;
    (s.models || []).forEach(m => modelSet.add(m));
    // 探测失败 或 读不到余额的 都算异常
    if (!s.ok || s.balance_usd == null) down++;
    const th = state.settings.low_balance_usd ?? 2;
    if (s.balance_usd != null && s.balance_usd < th) low++;
  });
  models = modelSet.size;

  const cny = state.settings.usd_cny || 1;
  const cards = [
    {
      label: '总余额', color: 'var(--mint)', soft: 'var(--mint-soft)',
      value: hasBal ? '¥' + (bal * cny).toFixed(2) : '—',
      foot: hasBal ? `≈ $${bal.toFixed(2)}` : '需要访问令牌或会话 Cookie',
    },
    {
      label: '累计已用', color: 'var(--primary)', soft: 'var(--primary-soft)',
      value: hasUsed ? '¥' + (used * cny).toFixed(2) : '—',
      foot: hasUsed ? `≈ $${used.toFixed(2)}` : '需要访问令牌或会话 Cookie',
    },
    {
      label: '可用模型', color: 'var(--lav)', soft: 'var(--lav-soft)',
      value: fmtNum(models),
      foot: `${list.length} 个站点合计`,
    },
    {
      label: '告警 / 异常', color: low || down ? 'var(--warn)' : 'var(--text-2)',
      soft: low || down ? 'var(--warn-soft)' : 'var(--line-soft)',
      value: `${low} / ${down}`,
      foot: low ? `低余额 ${low} 个 · 探测失败 ${down} 个` : '全部正常',
    },
  ];

  $('#stats').innerHTML = cards.map((c, i) => {
    // 总余额 / 累计已用 / 告警异常 点开去总览；可用模型去模型矩阵
    const goto = c.label === '可用模型' ? 'models' : 'overview';
    const title = goto === 'models' ? '点击查看模型矩阵' : '点击查看总览';
    return `
    <div class="stat clickable" data-goto="${goto}" title="${title}" style="--accent-soft:${c.soft}">
      <div class="stat-label"><span style="width:7px;height:7px;border-radius:50%;background:${c.color};display:inline-block"></span>${c.label}</div>
      <div class="stat-value">${esc(c.value)}</div>
      <div class="stat-foot">${esc(c.foot)}</div>
    </div>`;
  }).join('');
  // 统计卡是后续渲染的，bind() 里的 [data-goto] 委托抓不到，这里手动绑一次
  $$('#stats [data-goto]').forEach(el => {
    el.onclick = () => switchView(el.dataset.goto);
  });
}

/* ------------------------------ 站点详情（单站） ------------------------------ */
function siteById(id) {
  return state.snapshots.find(s => s.id === id) || null;
}

function openSiteDetail(id) {
  state.detailId = id;
  state.detailModelSearch = '';
  state.detailTest = {};              // 换站点时清掉上一个站点的测试结果
  state.hiddenSites = new Set();
  const s = siteById(id);
  if (s) $('#detail-title').textContent = s.name || '';
  const sub = $('#detail-sub');
  if (sub && s) {
    sub.textContent = `${(s.base_url || '').replace(/^https?:\/\//, '')} · ${modeLabel(s.mode)}`;
  }
  switchView('detail');
}

function renderDetail(id) {
  const s = siteById(id);
  const host = $('#detail-content');
  if (!s) { host.innerHTML = '<div class="tip-inline">站点不存在或已被删除</div>'; return; }

  $('#detail-title').textContent = s.name || '';
  $('#detail-sub').textContent = `${(s.base_url || '').replace(/^https?:\/\//, '')} · ${modeLabel(s.mode)}`;

  const th = state.settings.low_balance_usd ?? 2;
  const cny = state.settings.usd_cny || 1;
  const down = !s.ok;
  const isLow = s.balance_usd != null && s.balance_usd < th;
  const totalTokens = s.token_usage ? s.token_usage.total : null;

  const statCard = (k, v, sub2, cls) =>
    `<div class="d-stat ${cls || ''}"><div class="k">${k}</div><div class="v">${v}</div>${sub2 ? `<div class="s">${sub2}</div>` : ''}</div>`;

  const summary = `<div class="d-stats">
    ${statCard('余额', down ? '—' : s.balance_usd != null ? fmtCny(s.balance_usd, s) : '—',
      s.balance_usd != null && !down ? fmtUsdSub(s.balance_usd) : '', isLow ? 'low' : '')}
    ${statCard('已用', s.used_usd != null ? fmtCny(s.used_usd, s) : '—', s.used_usd != null ? fmtUsdSub(s.used_usd) : '')}
    ${statCard('请求数', s.request_count != null ? fmtCompact(s.request_count) : '—', null)}
    ${statCard('模型数', String(s.model_count || 0), null)}
    ${totalTokens ? statCard('累计 Tokens', fmtCompact(totalTokens),
      s.token_usage.cached ? `缓存命中 ${fmtCompact(s.token_usage.cached)}` : null) : ''}
  </div>`;

  const hasUsage = (s.usage_by_day || []).length;
  const hasModels = (s.models || []).length;

  const usageBlock = hasUsage ? `
    <div class="panel">
      <div class="panel-head">
        <div><h2>用量趋势</h2><p class="panel-sub" id="d-usage-sub"></p></div>
        <div class="panel-tools">
          <div class="range-pick">${rangePickerHtml('detail')}</div>
          <label class="switch"><input type="checkbox" id="d-usage-cny" ${state.usageCny ? 'checked' : ''}><span></span>显示为人民币</label>
        </div>
      </div>
      <div class="chart-box"><svg id="d-line-chart" viewBox="0 0 900 240" preserveAspectRatio="none"></svg></div>
    </div>
    <div class="two-col">
      <div class="panel">
        <div class="panel-head"><div><h2>模型消耗 Top</h2><p class="panel-sub" id="d-topmodel-sub">该站点所选时段内</p></div></div>
        <div class="bars" id="d-model-bars"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>每日明细</h2><p class="panel-sub" id="d-days-sub">按天展开</p></div></div>
        <div class="d-days" id="d-days"></div>
      </div>
    </div>` : `<div class="panel"><div class="tip-inline">该站点未提供用量数据${s.mode === 'models_only' ? '（只拿到模型列表，需要访问令牌或刷新令牌才能读用量）' : ''}</div></div>`;

  const modelsBlock = hasModels ? `
    <div class="panel">
      <div class="panel-head">
        <div><h2>可用模型</h2><p class="panel-sub" id="d-model-sub">共 ${s.models.length} 个</p></div>
        <div class="panel-tools">
          <div class="search">
            <svg viewBox="0 0 20 20" width="15" height="15"><circle cx="9" cy="9" r="5.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M13.2 13.2L17 17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            <input id="d-model-search" type="text" placeholder="搜索模型名">
          </div>
          <button class="btn primary sm" id="d-btn-test-all">
            <svg viewBox="0 0 20 20" width="14" height="14"><path d="M4 13.5l3.6-4 3 2.6L16 5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.4 5H16v3.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
            测试全部
          </button>
          <button class="btn ghost sm" id="d-btn-test-clear">清除</button>
        </div>
      </div>
      <div class="d-testbar">
        <div class="d-test-note" id="d-test-note">
          点任意模型可测试它在该站点能否调通；「测试全部」会逐个发一次最小请求（<code>max_tokens=1</code>）。
          有些模型只接受<b>流式请求</b>，程序会自动改用流式重试。测试会消耗极少量额度。
        </div>
        ${testModeHtml('detail')}
      </div>
      <div class="d-models" id="d-models"></div>
    </div>` : `<div class="panel"><div class="tip-inline">该站点没返回模型列表（可能关闭了 /v1/models，或 Key 被限制了模型范围）</div></div>`;

  const errBlock = (s.errors || []).length
    ? `<div class="sc-err" style="margin-bottom:14px">${esc((s.errors || []).join('；'))}</div>` : '';

  host.innerHTML = summary + errBlock + usageBlock + modelsBlock;

  // 交互
  const cnyBox = $('#d-usage-cny');
  if (cnyBox) cnyBox.onchange = (e) => { state.usageCny = e.target.checked; drawDetailChart(s); renderDetailBars(s); renderDetailDays(s); };
  const mSearch = $('#d-model-search');
  if (mSearch) mSearch.oninput = () => { state.detailModelSearch = mSearch.value; paintDetailModels(s); };
  bindRangePicker('detail', () => {
    const snap = siteById(state.detailId);
    if (!snap) return;
    drawDetailChart(snap); renderDetailBars(snap); renderDetailDays(snap);
  });
  bindTestMode('detail');
  const testAll = $('#d-btn-test-all');
  if (testAll) testAll.onclick = async () => {
    const pairs = (s.models || []).map(m => ({ site_id: s.id, model: m }));
    if (!pairs.length) { toast('没有可测试的模型', 'warn'); return; }
    testAll.disabled = true;
    const old = testAll.innerHTML;
    testAll.textContent = `测试中…（${pairs.length}）`;
    await runDetailTest(s.id, pairs);
    testAll.disabled = false;
    testAll.innerHTML = old;
  };
  const testClear = $('#d-btn-test-clear');
  if (testClear) testClear.onclick = () => {
    state.detailTest = {};
    paintDetailModels(s);
    $('#d-test-note').innerHTML = '已清除测试结果。点任意模型可单独测试，「测试全部」批量测试。';
    toast('已清除测试结果', 'ok');
  };

  if (hasModels) paintDetailModels(s);
  if (hasUsage) requestAnimationFrame(() => { drawDetailChart(s); renderDetailBars(s); renderDetailDays(s); });
}

/* ------------------------------ 单站模型连通性 ------------------------------ */
function detailTestKey(siteId, model) {
  return state.detailTest[siteId + '|' + model] || null;
}

function paintDetailModels(s) {
  const host = $('#d-models');
  if (!host) return;
  const q = (state.detailModelSearch || '').trim().toLowerCase();
  const hit = (s.models || []).filter(m => m.toLowerCase().includes(q));
  $('#d-model-sub').textContent = q ? `${hit.length} / ${s.models.length} 个` : `共 ${s.models.length} 个`;

  const testable = !!((s.api_key || '').trim()) || !!state.sites.find(x => x.id === s.id && x.api_key_masked);
  host.innerHTML = hit.length ? hit.map(m => {
    const r = detailTestKey(s.id, m);
    let stateHtml = '';
    let cls = 'd-chip';
    let title = '点击测试该模型是否可调通';
    if (r && r.pending) {
      stateHtml = '<span class="chip-state pending"><span class="tdot"></span></span>';
      title = '测试中…';
    } else if (r && r.ok) {
      const ms = r.ms || 0;
      const kind = ms < 1500 ? 'ok' : ms < 5000 ? 'mid' : 'slow';
      const label = ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
      stateHtml = `<span class="chip-state ${kind}" title="连通正常 · ${ms} ms${r.stream ? ' · 流式' : ''}">${label}</span>`;
      title = `连通正常 · ${ms} ms${r.stream ? ' · 流式请求' : ''}`;
      cls += ' tested';
    } else if (r) {
      const msg = (r.error || ('HTTP ' + (r.status || '?'))).slice(0, 140);
      stateHtml = '<span class="chip-state fail" title="' + esc(msg) + '">✕</span>';
      title = msg;
      cls += ' tested';
    }
    const click = testable ? `clickable" data-dtest="${esc(m)}` : '';
    return `<span class="${cls} ${click}" title="${esc(title)}">${esc(m)}${stateHtml}</span>`;
  }).join('') : '<div class="tip-inline">没有匹配的模型</div>';
  if (!$('#d-models')) return;
  host.querySelectorAll('[data-dtest]').forEach(el => {
    el.onclick = () => runDetailTest(s.id, [{ site_id: s.id, model: el.dataset.dtest }]);
  });
}

async function runDetailTest(siteId, pairs) {
  pairs.forEach(p => { state.detailTest[p.site_id + '|' + p.model] = { pending: true }; });
  const s = siteById(siteId);
  if (s) paintDetailModels(s);
  try {
    const r = await api('/api/test-models', {
      method: 'POST',
      body: JSON.stringify({ items: pairs, mode: state.testMode }),
    });
    if (r.error) {
      toast(r.error, 'err');
      pairs.forEach(p => delete state.detailTest[p.site_id + '|' + p.model]);
    } else {
      (r.results || []).forEach(x => { state.detailTest[x.site_id + '|' + x.model] = x; });
      const n = (r.results || []).length;
      const okN = (r.results || []).filter(x => x.ok).length;
      const note = $('#d-test-note');
      if (note) {
        const nStream = (r.results || []).filter(x => x.ok && x.stream).length;
        note.innerHTML = `测试完成：<b>${okN} / ${n}</b> 个模型可调通` +
          (nStream ? `（其中 <b>${nStream}</b> 个需要流式请求，已自动重试成功）` : '') +
          `。悬停 ✕ 可看失败原因。`;
      }
      toast(`连通性测试完成：${okN} / ${n} 通过`, okN === n ? 'ok' : 'warn');
    }
  } catch (e) {
    toast('测试失败：' + e.message, 'err');
    pairs.forEach(p => delete state.detailTest[p.site_id + '|' + p.model]);
  }
  const s2 = siteById(siteId);
  if (s2) paintDetailModels(s2);
}

function detailQpu(s) {
  return s.quota_per_usd || state.settings.quota_per_usd || 500000;
}

/* ------------------------------ 时间范围控件 ------------------------------ */
// scope: 'usage'（用量分析页） | 'detail'（单站详情页）
function currentRangeOf(scope) {
  return scope === 'detail' ? detailDays() : usageDays();
}

function rangePickerHtml(scope) {
  const cur = currentRangeOf(scope);
  const isPreset = RANGE_OPTIONS.some(o => o.days === cur);
  const chips = RANGE_OPTIONS.map(o =>
    `<button class="rp-chip ${o.days === cur ? 'active' : ''}" data-range="${o.days}">${o.label}</button>`
  ).join('');
  return `<span class="rp-label">时间范围</span>
    <div class="rp-chips" data-range-chips="${scope}">${chips}</div>
    <div class="rp-custom">
      <input type="number" min="1" max="${state.settings.max_usage_days || 120}" data-range-input="${scope}"
             value="${isPreset ? '' : cur}" placeholder="自定义">
      <span>天</span>
    </div>`;
}

function bindRangePicker(scope, onChange) {
  $$(`[data-range-chips="${scope}"] .rp-chip`).forEach(btn => {
    btn.onclick = () => {
      const d = Number(btn.dataset.range);
      if (!d) return;
      if (scope === 'detail') state.detailRange = d; else state.usageRange = d;
      // 重绘控件高亮 + 清空自定义输入
      $$(`[data-range-chips="${scope}"] .rp-chip`).forEach(b => b.classList.toggle('active', b === btn));
      const inp = $(`[data-range-input="${scope}"]`);
      if (inp) inp.value = '';
      onChange();
    };
  });
  const inp = $(`[data-range-input="${scope}"]`);
  if (inp) {
    inp.onchange = () => {
      let d = Number(inp.value);
      if (!d || d < 1) { inp.value = ''; return; }
      // 上限跟随探测抓取的天数（后端 LOG_FETCH_DAYS，默认 120）
      const cap = Number(state.settings.max_usage_days) || 120;
      d = Math.min(cap, Math.round(d));
      inp.value = d;
      if (scope === 'detail') state.detailRange = d; else state.usageRange = d;
      $$(`[data-range-chips="${scope}"] .rp-chip`).forEach(b => b.classList.remove('active'));
      onChange();
    };
  }
}

/* ------------------------------ 测试方式控件 ------------------------------ */
function testModeHtml(scope) {
  const modes = [
    { k: 'auto', t: '自动', d: '先普通请求，被拒时自动改用流式' },
    { k: 'plain', t: '仅普通', d: '只发普通请求' },
    { k: 'stream', t: '仅流式', d: '只发流式请求' },
  ];
  return `<div class="seg" data-test-mode="${scope}" title="选择连通性测试采用的请求方式">
    ${modes.map(m => `<button class="seg-btn ${state.testMode === m.k ? 'active' : ''}" data-mode="${m.k}" title="${m.d}">${m.t}</button>`).join('')}
  </div>`;
}

function bindTestMode(scope) {
  $$(`[data-test-mode="${scope}"] .seg-btn`).forEach(btn => {
    btn.onclick = () => {
      state.testMode = btn.dataset.mode;
      localStorage.setItem('apihub_test_mode', state.testMode);
      $$(`[data-test-mode="${scope}"] .seg-btn`).forEach(b => b.classList.toggle('active', b === btn));
      // 矩阵页与详情页的测试方式要一致
      $$('[data-test-mode]').forEach(w => {
        w.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.testMode));
      });
      $$('[data-test-mode]').forEach(w => { if (w.dataset.testMode !== scope) bindTestMode(w.dataset.testMode); });
      toast('测试方式：' + ({ auto: '自动（推荐）', plain: '仅普通请求', stream: '仅流式请求' })[state.testMode], 'ok');
    };
  });
}

function drawDetailChart(s) {
  const svg = $('#d-line-chart');
  if (!svg) return;
  const box = svg.parentElement;
  const W = Math.max(420, box.clientWidth || 900);
  const H = 240;
  const pad = { l: 56, r: 16, t: 16, b: 30 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const q = detailQpu(s);
  const days = tailDays(s.usage_by_day, detailDays());
  if (!days.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#8a9bad" font-size="13" font-family="inherit">暂无用量的数据</text>`;
    return;
  }
  const rangeSub = $('#d-usage-sub');
  if (rangeSub) {
    const total = days.reduce((a, d) => a + (d.quota || 0), 0);
    const reqs = days.reduce((a, d) => a + (d.requests || 0), 0);
    rangeSub.textContent = `最近 ${days.length} 天 · 合计 ${fmtUsd(total / q, 4)} · ${reqs} 次请求`;
  }
  const cv = state.usageCny ? (state.settings.usd_cny || 1) : 1;
  const pre = state.usageCny ? '¥' : '$';
  const vals = days.map(d => (d.quota || 0) / q * cv);
  const maxV = Math.max(0.0001, ...vals);
  const nice = niceScale(maxV, 4);
  const yMax = nice.max;
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = i => pad.l + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const y = v => pad.t + ih - (v / yMax) * ih;
  const color = siteColor(s.id);

  let out = '';
  nice.ticks.forEach(t => {
    const yy = y(t);
    out += `<line x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${W - pad.r}" y2="${yy.toFixed(1)}" stroke="#eef3f8" stroke-width="1"/>`;
    out += `<text x="${pad.l - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" fill="#a3b1c0" font-size="10.5" font-family="inherit">${pre}${t.toFixed(t >= 10 ? 0 : 2)}</text>`;
  });
  const step = Math.ceil(days.length / 9);
  days.forEach((d, i) => {
    if (i % step !== 0 && i !== days.length - 1) return;
    out += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="#a3b1c0" font-size="10.5" font-family="inherit">${d.date.slice(5)}</text>`;
  });
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  out += `<path d="M${pad.l},${pad.t + ih} L` + pts.join(' L') + ` L${W - pad.r},${pad.t + ih} Z" fill="${color}18"/>`;
  out += `<path d="M` + pts.join(' L') + `" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  vals.forEach((v, i) => {
    out += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="#fff" stroke="${color}" stroke-width="1.8"><title>${days[i].date}：${pre}${v.toFixed(4)} · ${days[i].requests || 0} 次</title></circle>`;
  });
  svg.innerHTML = out;
}

function renderDetailBars(s) {
  const host = $('#d-model-bars');
  if (!host) return;
  const q = detailQpu(s);
  const cv = state.usageCny ? (state.settings.usd_cny || 1) : 1;
  const pre = state.usageCny ? '¥' : '$';
  const rows = (s.usage_by_model || []).map(m => ({ model: m.model, usd: (m.quota || 0) / q, requests: m.requests }))
    .sort((a, b) => b.usd - a.usd).slice(0, 15);
  const max = Math.max(0.0001, ...rows.map(r => r.usd));
  const sub = $('#d-topmodel-sub');
  if (sub) {
    const covered = (s.usage_by_day || []).length;
    const sliced = detailDays() < covered;
    sub.textContent = sliced
      ? `全部历史（网关接口的模型明细不支持按天切分）`
      : `该站点所选时段内`;
  }
  host.innerHTML = rows.length ? rows.map((r, i) => {
    const c = PALETTE[i % PALETTE.length];
    return `<div class="bar-row">
      <div class="bar-top"><span class="bar-name" title="${esc(r.model)}">${esc(r.model)}</span>
      <span class="bar-val">${pre}${(r.usd * cv).toFixed(4)} · ${r.requests || 0}次</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${((r.usd / max) * 100).toFixed(1)}%;background:linear-gradient(90deg,${c},${c}aa)"></div></div>
    </div>`;
  }).join('') : '<div class="tip-inline">暂无模型用量明细</div>';
}

function renderDetailDays(s) {
  const host = $('#d-days');
  if (!host) return;
  const q = detailQpu(s);
  const cv = state.usageCny ? (state.settings.usd_cny || 1) : 1;
  const pre = state.usageCny ? '¥' : '$';
  const scope = tailDays(s.usage_by_day, detailDays());
  const days = [...scope].reverse().filter(d => (d.quota || 0) > 0 || (d.requests || 0) > 0);
  const sub = $('#d-days-sub');
  if (sub) sub.textContent = `所选 ${scope.length} 天`;
  host.innerHTML = days.length ? days.map(d =>
    `<div class="d-day"><span class="dd-date">${esc(d.date)}</span>
     <span class="dd-req">${d.requests || 0} 次</span>
     <span class="dd-cost">${pre}${(((d.quota || 0) / q) * cv).toFixed(4)}</span></div>`
  ).join('') : '<div class="tip-inline">所选时段内没有消耗</div>';
}

/* ------------------------------ 站点卡片 ------------------------------ */
// 当前应展示的站点（受搜索过滤 + 排序）
function overviewSites() {
  let list = state.snapshots.filter(s => s.enabled !== false);
  const q = (state.siteSearch || '').trim().toLowerCase();
  if (q) {
    list = list.filter(s =>
      (s.name || '').toLowerCase().includes(q) ||
      (s.base_url || '').toLowerCase().includes(q) ||
      (s.note || '').toLowerCase().includes(q) ||
      (s.site_name || '').toLowerCase().includes(q));
  }
  return sortSites(list);
}

// 把站点 id 顺序写回本地
function persistSiteOrder(ids) {
  state.siteOrder = ids.slice();
  try { localStorage.setItem('apihub_site_order', JSON.stringify(state.siteOrder)); } catch (e) {}
}

// 自定义顺序：已知顺序优先，未登记的排在后面（按名称）
function applyCustomOrder(list) {
  const idx = new Map(state.siteOrder.map((id, i) => [String(id), i]));
  return [...list].sort((a, b) => {
    const ia = idx.has(String(a.id)) ? idx.get(String(a.id)) : Infinity;
    const ib = idx.has(String(b.id)) ? idx.get(String(b.id)) : Infinity;
    if (ia !== ib) return ia - ib;
    return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
  });
}

// 某站点在某排序维度下的排序值
function sortValue(s, k) {
  const bal = s.balance_usd, used = s.used_usd;
  switch (k) {
    case 'balance': return bal == null ? -Infinity : bal;
    case 'used': return used == null ? -Infinity : used;
    case 'requests': return s.request_count || 0;
    case 'models': return s.model_count || 0;
    case 'note': return (s.note || '').toLowerCase();
    case 'status': {
      // 异常(不可达/凭证无效) 排前面，其次余额偏低，最后正常
      if (!s.ok) return 0;
      if (bal != null && bal < (state.settings.low_balance_usd ?? 2)) return 1;
      return 2;
    }
    case 'custom': return 0;
    default: return (s.name || '').toLowerCase();
  }
}

// 各排序字段的默认升降序（数值类默认降序更直观）
const SORT_DEFAULT_DIR = {
  name: 1, note: 1, custom: 1, status: 1,
  balance: -1, used: -1, requests: -1, models: -1,
};

// 排序（卡片与列表共用）
function sortSites(list) {
  const k = state.sortKey;
  if (k === 'custom') return applyCustomOrder(list);
  const d = state.sortDir;
  return [...list].sort((a, b) => {
    const x = sortValue(a, k), y = sortValue(b, k);
    if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * d;
    if (x === y) return (a.name || '').localeCompare(b.name || '');
    return (x - y) * d;
  });
}

// 单个站点的派生展示字段，卡片和列表共用
function siteView(s) {
  const th = state.settings.low_balance_usd ?? 2;
  const cny = state.settings.usd_cny || 1;
  const bal = s.balance_usd;
  const isLow = bal != null && bal < th;
  const down = !s.ok;
  const unreachable = down && s.reachable === false;
  const cls = unreachable ? 'down' : isLow ? 'low' : '';
  const dot = unreachable ? 'err' : down ? 'warn' : isLow ? 'warn' : 'ok';
  const total = (bal != null && s.used_usd != null) ? bal + s.used_usd : null;
  const pct = total && total > 0 ? Math.max(2, Math.min(100, (bal / total) * 100)) : 0;

  const tags = [];
  if (s.mode) {
    // 卡片上只关心「余额是怎么读到的」，其余（完整数据 / 网关用量接口 / 仅模型列表）都不显示
    let label = '';
    if (s.auth_used) label = s.auth_used;                       // 令牌 / Cookie
    else if (s.mode === 'gateway_usage') label = '网关用量接口';
    else label = modeLabel(s.mode);
    const cls = down ? 'danger' : s.auth_used ? 'blue' : 'lav';
    tags.push(`<span class="tag ${cls}">${esc(label)}</span>`);
  }
  // 站点版本号漏出的是站点内部构建号，没有参考价值，不展示
  if (s.group && s.group !== 'default') tags.push(`<span class="tag peach">${esc(s.group)}</span>`);
  if (s.tokens && s.tokens.length) tags.push(`<span class="tag mint">${s.tokens.length} 个令牌</span>`);

  // 无效 / 无法连接 / 无数据：短横线后跟一句原因，原因同时放悬停提示
  const balReason = unreachable ? '无法连接' : down ? '凭证无效' : bal == null ? '余额查询失败' : '';
  const balText = balReason
    ? `—<span class="sc-err-txt">${esc(balReason)}</span>`
    : fmtCny(bal, s);                                  // ¥ 主显示
  const balTip = balReason
    ? (balReason + ((s.errors || []).length ? '：' + s.errors.join('；') : ''))
    : (fmtCny(bal, s) + (fmtUsdSub(bal) ? '  ' + fmtUsdSub(bal) : ''));  // 悬停同时给 ¥ 和 ≈ $

  // 名称下方一行显示接口标识（原 URL 位置）
  const subHtml = tags.length ? tags.join('') : '<span class="t-sub">—</span>';
  const subTip = tags.map(t => t.replace(/<[^>]+>/g, '')).join(' · ');

  return {
    cls, dot, isLow, down, unreachable, pct, tags, cny, balText, balTip,
    // 无效或没有余额时不显示进度条（没有进度可言）
    barHidden: down || bal == null,
    subHtml, subTip,
    note: (s.note || '').trim(),
    noteHtml: (s.note || '').trim()
      ? `<div class="sc-note" title="${esc(s.note.trim())}">
           <svg viewBox="0 0 16 16" width="11" height="11"><path d="M3 2.6h7.4L13 5.2v8.2H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.4 7.4h5.2M5.4 9.9h3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
           <span>${esc(s.note.trim())}</span>
         </div>`
      : '',
    balClass: down ? 'err' : isLow ? 'low' : 'cur',
    // 副显示：≈ $X（USD 原值，按 quota_per_usd 换算得到，与站点充值比无关）
    cnyText: bal != null && !down ? fmtUsdSub(bal) : '',
    errHtml: (s.errors || []).length && !down ? `<div class="sc-err">${esc(s.errors[0])}</div>` : '',
  };
}

function cardActions(s) {
  return `
    <a class="icon-btn" data-act="open" data-id="${s.id}" href="${esc(s.base_url)}" target="_blank" rel="noopener" title="打开该站点平台">
      <svg viewBox="0 0 20 20" width="18" height="18"><path d="M11.6 3.6h4.8v4.8M16.4 3.6l-6.2 6.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.2 11.4v3.4A2.2 2.2 0 0113 17H5.6a2.2 2.2 0 01-2.2-2.2V7.4A2.2 2.2 0 015.6 5.2h3.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
    </a>
    <button class="icon-btn" data-act="debug" data-id="${s.id}" title="查看接口探测详情">
      <svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 8.6v4M10 6.2v.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
    </button>
    <button class="icon-btn" data-act="copy" data-id="${s.id}" title="复制 Base URL + Key">
      <svg viewBox="0 0 20 20" width="18" height="18"><rect x="7" y="7" width="9" height="10" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 7V5.2A2.2 2.2 0 0010.8 3H5.2A2.2 2.2 0 003 5.2v7.6A2.2 2.2 0 005.2 15H7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <button class="icon-btn" data-act="refresh" data-id="${s.id}" title="刷新此站点">
      <svg viewBox="0 0 20 20" width="18" height="18"><path d="M17 10a7 7 0 11-2.05-4.95" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17 2.6v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
}

function renderCards() {
  const grid = $('#site-grid');
  const wrap = $('#site-table-wrap');
  const list = overviewSites();
  const all = state.snapshots.filter(s => s.enabled !== false);
  $('#overview-empty').hidden = all.length > 0;

  const isList = state.layout === 'list';
  grid.hidden = isList || all.length === 0;
  if (wrap) wrap.hidden = !isList || all.length === 0;

  if (isList) {
    renderSiteTable(list);
  } else if (all.length) {
    const custom = state.sortKey === 'custom';
    grid.innerHTML = list.map(s => {
      const v = siteView(s);
      return `
      <div class="site-card ${v.cls}" style="--band:${siteColor(s.id)}" data-open="${s.id}" data-id="${s.id}" ${custom ? 'draggable="true"' : ''} title="点击查看该站点的模型与用量">
        ${custom ? `<span class="drag-handle" title="拖拽调整顺序"><svg viewBox="0 0 16 16" width="12" height="12"><circle cx="6" cy="4" r="1.2" fill="currentColor"/><circle cx="10" cy="4" r="1.2" fill="currentColor"/><circle cx="6" cy="8" r="1.2" fill="currentColor"/><circle cx="10" cy="8" r="1.2" fill="currentColor"/><circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="10" cy="12" r="1.2" fill="currentColor"/></svg></span>` : ''}
        <div class="sc-top">
          <div class="sc-name">
            <div class="sc-head">
              <span class="status-dot ${v.dot}"></span>
              <span class="sc-title" title="${esc(s.name)}">${esc(s.name)}</span>
            </div>
            <div class="sc-sub" title="${v.subTip ? esc(v.subTip) : ''}">${v.subHtml}</div>
          </div>
          <div class="sc-actions">${cardActions(s)}</div>
        </div>

        <div class="sc-balance">
          <div class="sc-amount ${v.balClass}" title="${esc(v.balTip)}">${v.balText}</div>
          ${v.cnyText ? `<div class="sc-cny">${v.cnyText}</div>` : ''}
          ${v.barHidden ? '' : `<div class="sc-bar"><span class="${v.isLow ? 'low' : ''}" style="width:${v.pct}%"></span></div>`}
        </div>

        ${v.noteHtml}
      </div>`;
    }).join('') || '<div class="tip-inline" style="padding:24px 4px">没有匹配的站点</div>';
  }

  $('#sites-sub').textContent = `共 ${all.length} 个站点`;
}

/* ------------------------------ 列表视图 ------------------------------ */
function renderSiteTable(list) {
  const table = $('#site-table');
  const rows = list;   // 已在 overviewSites() 里排好序
  const custom = state.sortKey === 'custom';
  const ar = (k) => state.sortKey === k
    ? `<span class="sort-ar">${state.sortDir > 0 ? '▲' : '▼'}</span>` : '<span class="sort-ar">↕</span>';
  const cls = (k) => `sortable${state.sortKey === k ? ' sorted' : ''}`;

  const head = `<thead><tr>
    ${custom ? '<th class="drag-cell"></th>' : ''}
    <th class="${cls('name')}" data-sort="name">站点 ${ar('name')}</th>
    <th class="num ${cls('balance')}" data-sort="balance">余额 ${ar('balance')}</th>
    <th class="num ${cls('used')}" data-sort="used">已用 ${ar('used')}</th>
    <th class="num ${cls('requests')}" data-sort="requests">请求数 ${ar('requests')}</th>
    <th class="num ${cls('models')}" data-sort="models">模型 ${ar('models')}</th>
    <th class="${cls('status')}" data-sort="status">状态 ${ar('status')}</th>
    <th class="${cls('note')}" data-sort="note">备注 ${ar('note')}</th>
    <th style="text-align:right">操作</th>
  </tr></thead>`;

  const body = `<tbody>${rows.map(s => {
    const v = siteView(s);
    const rowCls = v.unreachable ? 'row-down' : v.isLow ? 'row-low' : '';
    return `<tr class="${rowCls}" data-open="${s.id}" data-id="${s.id}" ${custom ? 'draggable="true"' : ''} title="点击查看该站点的模型与用量">
      ${custom ? `<td class="drag-cell"><span class="t-drag" title="拖拽调整顺序">
        <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="6" cy="4" r="1.2" fill="currentColor"/><circle cx="10" cy="4" r="1.2" fill="currentColor"/><circle cx="6" cy="8" r="1.2" fill="currentColor"/><circle cx="10" cy="8" r="1.2" fill="currentColor"/><circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="10" cy="12" r="1.2" fill="currentColor"/></svg>
      </span></td>` : ''}
      <td>
        <div class="st-cell">
          <span class="status-dot ${v.dot}"></span>
          <div class="st-main">
            <div class="st-name" title="${esc(s.name)}">${esc(s.name)}</div>
            <div class="st-host" title="${esc(s.base_url)}">${esc((s.base_url || '').replace(/^https?:\/\//, ''))}</div>
          </div>
        </div>
      </td>
      <td class="num">
        <div class="t-bal ${v.down ? 'err' : v.isLow ? 'low' : ''}">${v.balText}</div>
        ${v.cnyText ? `<div class="t-sub">${v.cnyText}</div>` : ''}
      </td>
      <td class="num">${s.used_usd != null ? fmtCny(s.used_usd, s) : '—'}<div class="t-sub">${s.used_usd != null ? fmtUsdSub(s.used_usd) : ''}</div></td>
      <td class="num">${s.request_count != null ? fmtCompact(s.request_count) : '—'}</td>
      <td class="num">${s.model_count || 0}</td>
      <td><div class="t-tags">${v.tags.slice(0, 2).join('') || '<span class="t-sub">—</span>'}</div></td>
      <td>${v.note
        ? `<div class="t-note" title="${esc(v.note)}">${esc(v.note)}</div>`
        : '<span class="t-sub">—</span>'}</td>
      <td>
        <div class="t-acts">${cardActions(s)}</div>
      </td>
    </tr>`;
  }).join('')}</tbody>`;

  table.innerHTML = head + body;
}

/* ------------------------------ 连通性测试 ------------------------------ */
function testKey(siteId, model) {
  const r = state.modelTest[siteId + '|' + model];
  return r || null;
}

function renderTestCell(siteId, model, available) {
  if (!available) return `<td><span class="yn no">·</span></td>`;
  const r = testKey(siteId, model);
  if (!r) {
    return `<td><button class="yn yes test-btn" data-test="${siteId}|${esc(model)}" title="点击测试该模型在此站点是否连通">
      <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.4l3 3 6-6.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button></td>`;
  }
  if (r.pending) {
    return `<td><span class="test-state pending" title="测试中"><span class="tdot"></span></span></td>`;
  }
  if (r.ok) {
    const ms = r.ms || 0;
    const cls = ms < 1500 ? 'fast' : ms < 5000 ? 'mid' : 'slow';
    const tip = `连通正常 · ${ms} ms${r.stream ? ' · 流式请求' : ''}`;
    return `<td><span class="test-state ok ${cls}" title="${tip}">${ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'}</span></td>`;
  }
  const msg = (r.error || ('HTTP ' + (r.status || '?'))).slice(0, 90);
  return `<td><span class="test-state fail" title="${esc(msg)}">✕</span></td>`;
}

async function runModelTest(pairs) {
  if (!pairs.length) return;
  pairs.forEach(p => { state.modelTest[p.site_id + '|' + p.model] = { pending: true }; });
  renderMatrix();
  try {
    const r = await api('/api/test-models', {
      method: 'POST',
      body: JSON.stringify({ items: pairs, mode: state.testMode }),
    });
    if (r.error) { toast(r.error, 'err'); pairs.forEach(p => delete state.modelTest[p.site_id + '|' + p.model]); }
    else {
      (r.results || []).forEach(x => { state.modelTest[x.site_id + '|' + x.model] = x; });
      const okN = (r.results || []).filter(x => x.ok).length;
      const nStream = (r.results || []).filter(x => x.ok && x.stream).length;
      toast(`连通性测试完成：${okN} / ${(r.results || []).length} 通过` +
        (nStream ? `（${nStream} 个需流式，已自动重试）` : ''),
        okN === (r.results || []).length ? 'ok' : 'warn');
    }
  } catch (e) {
    toast('测试失败：' + e.message, 'err');
    pairs.forEach(p => delete state.modelTest[p.site_id + '|' + p.model]);
  }
  renderMatrix();
}

function currentMatrixPairs() {
  // 按当前筛选条件，收集所有 站点×模型 组合
  const sites = state.snapshots.filter(s => (s.models || []).length && s.enabled !== false);
  const map = new Map();
  sites.forEach(s => (s.models || []).forEach(m => {
    if (!map.has(m)) map.set(m, new Set());
    map.get(m).add(s.id);
  }));
  let rows = Array.from(map.entries()).map(([m, set]) => ({ m, set }));
  if (state.onlyCommon) rows = rows.filter(r => r.set.size === sites.length);
  if (state.modelSearch) {
    const q = state.modelSearch.toLowerCase();
    rows = rows.filter(r => r.m.toLowerCase().includes(q));
  }
  const pairs = [];
  rows.forEach(r => sites.forEach(s => {
    if (r.set.has(s.id)) pairs.push({ site_id: s.id, model: r.m });
  }));
  return pairs;
}

/* ------------------------------ 模型矩阵 ------------------------------ */
function renderMatrix() {
  const sites = state.snapshots.filter(s => (s.models || []).length && s.enabled !== false);
  const table = $('#matrix');

  if (!sites.length) {
    table.innerHTML = '';
    $('#matrix-sub').textContent = '暂无模型数据';
    return;
  }

  // 模型 -> 出现的站点
  const map = new Map();
  sites.forEach(s => (s.models || []).forEach(m => {
    if (!map.has(m)) map.set(m, new Set());
    map.get(m).add(s.id);
  }));

  let rows = Array.from(map.entries()).map(([m, set]) => ({ m, set }));
  if (state.onlyCommon) rows = rows.filter(r => r.set.size === sites.length);
  if (state.modelSearch) {
    const q = state.modelSearch.toLowerCase();
    rows = rows.filter(r => r.m.toLowerCase().includes(q));
  }
  rows.sort((a, b) => b.set.size - a.set.size || a.m.localeCompare(b.m));

  $('#matrix-sub').textContent = `${rows.length} 个模型 · ${sites.length} 个站点（按覆盖站点数排序）`;

  const head = `<thead><tr><th class="corner">模型 \\ 站点</th>${
    sites.map(s => `<th title="${esc(s.name)}">${esc(s.name)}<div class="mcount">${(s.models || []).length}</div></th>`).join('')
  }</tr></thead>`;

  const body = `<tbody>${rows.map(r => `
    <tr>
      <td class="model-cell" title="${esc(r.m)}">${esc(r.m)}</td>
      ${sites.map(s => renderTestCell(s.id, r.m, r.set.has(s.id))).join('')}
    </tr>`).join('')}</tbody>`;

  table.innerHTML = head + body;
}

/* ------------------------------ 用量分析 ------------------------------ */
function visibleSites() {
  return state.snapshots.filter(s => !state.hiddenSites.has(s.id) && s.enabled !== false);
}

function renderUsageLegend() {
  const all = state.snapshots.filter(s => s.enabled !== false && (s.usage_by_day || []).length);
  $('#usage-legend').innerHTML = all.map(s => `
    <span class="lg ${state.hiddenSites.has(s.id) ? 'off' : ''}" data-id="${s.id}">
      <span class="sw" style="background:${siteColor(s.id)}"></span>${esc(s.name)}
    </span>`).join('') || '<span class="tip-inline">暂无站点用量数据（需要系统访问令牌）</span>';
}

function drawLineChart() {
  const svg = $('#line-chart');
  const box = svg.parentElement;
  const W = Math.max(420, box.clientWidth || 900);
  const H = 260;
  const pad = { l: 52, r: 16, t: 16, b: 30 };

  const sites = visibleSites().filter(s => (s.usage_by_day || []).length);
  const gqpu = state.settings.quota_per_usd || 500000;
  const qpuOf = s => s.quota_per_usd || gqpu;
  const days = usageDays();

  if (!sites.length) {
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#8a9bad" font-size="13" font-family="inherit">暂无可绘制的用量数据</text>`;
    return;
  }

  // 每个站点按当前时间范围截取，再按日期对齐
  const sliced = sites.map(s => ({ s, byDay: tailDays(s.usage_by_day, days) }));
  const allDates = new Set();
  sliced.forEach(x => x.byDay.forEach(d => allDates.add(d.date)));
  const dates = Array.from(allDates).sort();

  const series = sliced.map(({ s, byDay }) => {
    const q = qpuOf(s);
    const m = new Map(byDay.map(d => [d.date, d.quota / q]));
    return { id: s.id, name: s.name, color: siteColor(s.id), values: dates.map(d => m.get(d) || 0) };
  });

  // 标题上写清时间范围
  const span = Math.max(...sliced.map(x => x.byDay.length));
  const sub = $('#usage-sub');
  const maxDays = state.settings.max_usage_days || 120;
  if (sub) sub.textContent = `最近 ${Math.min(days, span)} 天各站点消耗（探测时已固定抓取 ${maxDays} 天历史，可在下方切换更短时段）`;

  const maxV = Math.max(0.0001, ...series.flatMap(s => s.values));
  const nice = niceScale(maxV, 4);
  const yMax = nice.max;

  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = i => pad.l + (dates.length === 1 ? iw / 2 : (i / (dates.length - 1)) * iw);
  const y = v => pad.t + ih - (v / yMax) * ih;

  let out = '';
  // 网格 + y 轴
  nice.ticks.forEach(t => {
    const yy = y(t);
    out += `<line x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${W - pad.r}" y2="${yy.toFixed(1)}" stroke="#eef3f8" stroke-width="1"/>`;
    out += `<text x="${pad.l - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" fill="#a3b1c0" font-size="10.5" font-family="inherit">${state.usageCny ? '¥' + (t * (state.settings.usd_cny || 1)).toFixed(1) : '$' + t.toFixed(2)}</text>`;
  });

  // x 轴标签
  const step = Math.ceil(dates.length / 8);
  dates.forEach((d, i) => {
    if (i % step !== 0 && i !== dates.length - 1) return;
    out += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="#a3b1c0" font-size="10.5" font-family="inherit">${d.slice(5)}</text>`;
  });

  // 面积 + 线
  series.forEach(s => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const area = `M${pad.l},${pad.t + ih} L` + pts.join(' L') + ` L${W - pad.r},${pad.t + ih} Z`;
    out += `<path d="${area}" fill="${s.color}" opacity="0.07"/>`;
    out += `<path d="M` + pts.join(' L') + `" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  });

  out += `<g id="hover-group"></g>`;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out;

  // 悬停提示
  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(255,255,255,.97);border:1px solid #e9eef5;border-radius:12px;padding:9px 12px;font-size:12px;box-shadow:0 10px 26px rgba(24,40,66,.14);opacity:0;transition:opacity .12s;z-index:5;white-space:nowrap';
  box.style.position = 'relative';
  const old = box.querySelector('.chart-tip');
  if (old) old.remove();
  tip.className = 'chart-tip';
  box.appendChild(tip);

  svg.onmousemove = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    let idx = Math.round(((px - pad.l) / iw) * (dates.length - 1));
    idx = Math.max(0, Math.min(dates.length - 1, idx));
    const g = svg.querySelector('#hover-group');
    let h = `<line x1="${x(idx).toFixed(1)}" y1="${pad.t}" x2="${x(idx).toFixed(1)}" y2="${pad.t + ih}" stroke="#cfdceb" stroke-width="1" stroke-dasharray="3 3"/>`;
    series.forEach(s => {
      h += `<circle cx="${x(idx).toFixed(1)}" cy="${y(s.values[idx]).toFixed(1)}" r="3.6" fill="#fff" stroke="${s.color}" stroke-width="2.2"/>`;
    });
    g.innerHTML = h;

    const cv = state.usageCny ? (state.settings.usd_cny || 1) : 1;
    const pre = state.usageCny ? '¥' : '$';
    const lines = series
      .map(s => ({ n: s.name, c: s.color, v: s.values[idx] * cv }))
      .sort((a, b) => b.v - a.v)
      .map(o => `<div style="display:flex;align-items:center;gap:6px;margin-top:3px">
        <span style="width:8px;height:8px;border-radius:3px;background:${o.c};display:inline-block"></span>
        <span style="flex:1;color:#55697f;max-width:150px;overflow:hidden;text-overflow:ellipsis">${esc(o.n)}</span>
        <b style="font-variant-numeric:tabular-nums">${pre}${o.v.toFixed(3)}</b></div>`).join('');
    tip.innerHTML = `<div style="font-weight:600;color:#22303f">${dates[idx]}</div>${lines}`;
    tip.style.opacity = '1';
    const left = Math.min(Math.max(x(idx) * (r.width / W) - 70, 4), r.width - 190);
    tip.style.left = left + 'px';
    tip.style.top = '8px';
  };
  svg.onmouseleave = () => { tip.style.opacity = '0'; const g = svg.querySelector('#hover-group'); if (g) g.innerHTML = ''; };
}

function niceScale(max, count) {
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  return { max: top, ticks };
}

function renderDonut() {
  const days = usageDays();
  const sites = visibleSites().filter(s => (s.usage_by_day || []).length);
  const svg = $('#donut');
  const listEl = $('#donut-list');

  if (!sites.length) {
    svg.innerHTML = `<circle cx="100" cy="100" r="66" fill="none" stroke="#eef3f8" stroke-width="20"/><text x="100" y="105" text-anchor="middle" fill="#a3b1c0" font-size="12" font-family="inherit">暂无数据</text>`;
    listEl.innerHTML = '';
    return;
  }

  // 按当前时间范围重新汇总（不用快照里的累计值，否则切范围不变）
  const data = sites.map(s => {
    const q = s.quota_per_usd || state.settings.quota_per_usd || 500000;
    const sum = tailDays(s.usage_by_day, days).reduce((a, d) => a + (d.quota || 0), 0);
    return { id: s.id, name: s.name, v: sum / q, color: siteColor(s.id) };
  });
  const total = data.reduce((a, b) => a + b.v, 0) || 1;

  const R = 66, r = 46, cx = 100, cy = 100;
  let a0 = -Math.PI / 2;
  let out = `<circle cx="100" cy="100" r="56" fill="none" stroke="#f5f8fc" stroke-width="20"/>`;
  data.forEach(d => {
    const ang = (d.v / total) * Math.PI * 2;
    if (ang <= 0.0001) return;
    const a1 = a0 + ang;
    const large = ang > Math.PI ? 1 : 0;
    const p = (rad, a) => `${(cx + Math.cos(a) * rad).toFixed(2)},${(cy + Math.sin(a) * rad).toFixed(2)}`;
    out += `<path d="M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z" fill="${d.color}" opacity="0.92"/>`;
    a0 = a1;
  });

  const cv = state.usageCny ? (state.settings.usd_cny || 1) : 1;
  const pre = state.usageCny ? '¥' : '$';
  out += `<text x="100" y="96" text-anchor="middle" fill="#8a9bad" font-size="10.5" font-family="inherit">合计已用</text>`;
  out += `<text x="100" y="115" text-anchor="middle" fill="#22303f" font-size="16" font-weight="600" font-family="inherit">${pre}${(total * cv).toFixed(2)}</text>`;
  svg.innerHTML = out;

  listEl.innerHTML = data.sort((a, b) => b.v - a.v).map(d => `
    <div class="row">
      <span class="dot" style="background:${d.color}"></span>
      <span class="nm" title="${esc(d.name)}">${esc(d.name)}</span>
      <span class="vl">${pre}${(d.v * cv).toFixed(2)}</span>
      <span class="pc">${((d.v / total) * 100).toFixed(1)}%</span>
    </div>`).join('');
}

function renderModelBars() {
  const sites = visibleSites();
  const gqpu = state.settings.quota_per_usd || 500000;
  const agg = new Map();
  sites.forEach(s => {
    const q = s.quota_per_usd || gqpu;
    (s.usage_by_model || []).forEach(m => {
      const cur = agg.get(m.model) || { model: m.model, usd: 0, requests: 0 };
      cur.usd += m.quota / q; cur.requests += m.requests;
      agg.set(m.model, cur);
    });
  });
  const rows = Array.from(agg.values()).sort((a, b) => b.usd - a.usd).slice(0, 20);
  const max = Math.max(0.0001, ...rows.map(r => r.usd));

  const cv = state.usageCny ? (state.settings.usd_cny || 1) : 1;
  const pre = state.usageCny ? '¥' : '$';

  $('#topmodel-sub').textContent = `${visibleSites().length} 个站点 · 累计全部历史（模型明细不支持按天切分）· Top ${rows.length}`;
  $('#model-bars').innerHTML = rows.length ? rows.map((r, i) => {
    const color = PALETTE[i % PALETTE.length];
    return `
    <div class="bar-row">
      <div class="bar-top">
        <span class="bar-name" title="${esc(r.model)}">${esc(r.model)}</span>
        <span class="bar-val">${pre}${(r.usd * cv).toFixed(3)} · ${r.requests}次</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${((r.usd / max) * 100).toFixed(1)}%;background:linear-gradient(90deg,${color},${color}aa)"></div></div>
    </div>`;
  }).join('') : '<div class="tip-inline">暂无模型用量明细</div>';
}

/* ------------------------------ 站点管理 ------------------------------ */
function renderSiteList() {
  const list = state.sites;
  $('#sites-sub').textContent = `共 ${list.length} 个站点`;
  $('#site-list').innerHTML = list.length ? list.map(s => `
    <div class="site-row">
      <span class="status-dot ok" style="background:${siteColor(s.id)};box-shadow:0 0 0 3px ${siteColor(s.id)}22"></span>
      <div class="sr-main">
        <div class="sr-name">${esc(s.name)} ${s.enabled === false ? '<span class="tag">已停用</span>' : ''}</div>
        <div class="sr-url">${esc(s.base_url)} · Key ${esc(s.api_key_masked || '未填')} · 令牌 ${esc(s.access_token_masked || '未填')}${s.session_masked ? ' · Cookie ' + esc(s.session_masked) : ''}${s.user_id ? ' · UID ' + esc(s.user_id) : ''}</div>
      </div>
      <button class="icon-btn" data-edit="${s.id}" title="编辑">
        <svg viewBox="0 0 20 20" width="15" height="15"><path d="M13.6 3.4l3 3-8.6 8.6-3.7.7.7-3.7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
      </button>
      <button class="icon-btn" data-del="${s.id}" title="删除">
        <svg viewBox="0 0 20 20" width="15" height="15"><path d="M4.5 6h11M8 6V4.6A1.6 1.6 0 019.6 3h.8A1.6 1.6 0 0112 4.6V6m-6 0l.7 9.4A1.6 1.6 0 008.3 17h3.4a1.6 1.6 0 001.6-1.6L15 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>`).join('') : '<div class="tip-inline">还没有站点，点右上角「添加站点」开始。</div>';
}

function renderSettings() {
  const s = state.settings;
  const cny = $('#set-cny');
  if (cny) cny.value = s.usd_cny ?? 1;
  const low = $('#set-low');
  if (low) low.value = s.low_balance_usd ?? 2;
  const to = $('#set-timeout');
  if (to) to.value = s.timeout ?? 15;
  // 用量分析页的时间范围控件（带常用选项 + 自定义）
  const pick = $('#usage-range-pick');
  if (pick && !pick.dataset.bound) {
    pick.innerHTML = rangePickerHtml('usage');
    bindRangePicker('usage', () => { drawLineChart(); renderDonut(); renderModelBars(); });
    pick.dataset.bound = '1';
  }
}

/* ---------------------- 智能识别：从粘贴文本中提取凭证 ---------------------- */

// 常见的中转站字段名（用于 JSON / 键值对解析）
const SMART_FIELD_HINTS = {
  url: ['base_url', 'baseurl', 'base-url', 'api_base', 'apibase', 'api_base_url',
        'openai_base_url', 'endpoint', 'host', 'url', 'server', '地址', '接口地址',
        'baseuri', 'apiurl', 'api_url', 'domain'],
  key: ['api_key', 'apikey', 'api-key', 'key', 'token', 'secret', 'sk',
        'access_key', 'auth', '密钥', '令牌', 'apisecret', 'api_secret',
        'openai_api_key'],
  name: ['name', 'site', 'site_name', 'sitename', 'label', 'title', 'alias',
         'remark', 'note', '名称', '备注', '站点'],
  uid: ['user_id', 'userid', 'uid', 'user', 'id', '用户id', '用户编号'],
  token: ['access_token', 'accesstoken', 'system_token', 'api_token',
          'personal_token', '系统访问令牌', '访问令牌'],
  session: ['session', 'cookie', 'new_api_refresh', 'refresh_token', 'refreshtoken',
            'newapirefresh'],
};

// 中站网关常见的 Key 前缀
const KEY_PREFIX_RE = /\b(sk|sess|pat|api|key|tok|bearer)[-_][A-Za-z0-9_\-.]{12,}/gi;
const BARE_KEY_RE = /\b[A-Za-z0-9_\-]{28,}\b/g;

function _normFieldName(k) {
  return String(k).toLowerCase().replace(/[\s"']/g, '').replace(/[–—]/g, '-');
}

// 判断一段字符串是不是「像密钥」
function _looksLikeKey(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim().replace(/^bearer\s+/i, '');
  if (t.length < 12 || /\s/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^\/|^\{|^\[/.test(t)) return false;
  return /[A-Za-z0-9]/.test(t) && /^[A-Za-z0-9_\-.:+/=]+$/.test(t);
}

// 规范化 base_url：去掉查询串、接口尾巴和多余的 /v1
function _normUrl(u) {
  if (!u) return '';
  let t = String(u).trim().replace(/^["'`]+|["'`,;)<>]+$/g, '');
  if (!/^https?:\/\//i.test(t)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(t)) t = 'https://' + t;
    else return '';
  }
  // 去掉查询串与锚点（可能含 key 参数，由调用方另行提取）
  t = t.split('#')[0].split('?')[0];
  // 去掉已带的具体接口后缀
  t = t.replace(/\/(v1\/)?(chat\/completions|completions|models|usage|messages|responses|embeddings)\/?$/i, '');
  // 去掉末尾的 /v1（添加时程序会自动规范化，统一存裸域名）
  t = t.replace(/\/v1\/?$/i, '');
  t = t.replace(/\/+$/, '');
  return t;
}

// 从任意文本里兜底找 URL（裸域名也算）
function _findUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s"'`,;|)\]}<]+/i);
  if (m) return _normUrl(m[0]);
  // 没有协议头时，找形如 api.xxx.com / xxx.ai 的裸域名
  const bare = String(text).match(/(?:^|[\s"'`,;=:])((?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(?:\.[a-z]{2,})?)(?=[\s"'`,;/?#]|$)/im);
  if (bare) return _normUrl(bare[1]);
  return '';
}

// 从任意文本里兜底找 Key
function _findKey(text) {
  const t = String(text);
  KEY_PREFIX_RE.lastIndex = 0;
  const m1 = t.match(KEY_PREFIX_RE);
  if (m1 && m1.length) return m1.sort((a, b) => b.length - a.length)[0];
  const m2 = t.match(/bearer\s+([A-Za-z0-9_\-.:]{16,})/i);
  if (m2) return m2[1];
  const m3 = t.match(BARE_KEY_RE);
  if (m3 && m3.length) return m3.sort((a, b) => b.length - a.length)[0];
  return '';
}

/**
 * 智能解析：把用户粘贴的任意文本（curl / JSON / .env / YAML / 纯文本）
 * 解析成 { base_url, api_key, name, user_id, access_token, session }
 */
function smartParse(raw) {
  const text = String(raw || '').trim();
  const out = { base_url: '', api_key: '', name: '', user_id: '',
                access_token: '', session: '', _found: [] };
  if (!text) return out;

  // ---- 1) 尝试 JSON ----
  let json = null;
  const jStart = text.indexOf('{'), jEnd = text.lastIndexOf('}');
  if (jStart >= 0 && jEnd > jStart) {
    try { json = JSON.parse(text.slice(jStart, jEnd + 1)); } catch (e) { json = null; }
  }
  // 平铺成 key/value 列表（支持一层嵌套）
  const pairs = [];
  const pushPair = (k, v) => {
    if (v == null) return;
    if (typeof v === 'object') { Object.keys(v).forEach(k2 => pushPair(k2, v[k2])); return; }
    pairs.push([String(k), String(v)]);
  };
  if (json && typeof json === 'object') Object.keys(json).forEach(k => pushPair(k, json[k]));

  // ---- 2) 键值对文本（.env / YAML / k: v / k=v / k="v" / -k v） ----
  const kvRe = /(?:^|[\s,;{|(\[])(?:["']?)([A-Za-z_][A-Za-z0-9_\- ]{0,40})(?:["']?)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s,;|)}\]]+))/g;
  let m;
  while ((m = kvRe.exec(text)) !== null) {
    const k = m[1].trim();
    const v = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();
    if (k && v) pairs.push([k, v]);
  }

  // ---- 3) 匹配字段 ----
  for (const [rawK, rawV] of pairs) {
    const k = _normFieldName(rawK);
    const v = rawV.trim();
    if (!v) continue;
    const hit = (list) => list.some(x => k === x || k.replace(/[_-]/g, '') === x.replace(/[_-]/g, ''));

    if (!out.name && hit(SMART_FIELD_HINTS.name) && !_looksLikeKey(v) && !/^https?:\/\//i.test(v)) {
      out.name = v;
    } else if (!out.base_url && hit(SMART_FIELD_HINTS.url) && /^https?:\/\//i.test(v)) {
      out.base_url = _normUrl(v);
    } else if (!out.user_id && hit(SMART_FIELD_HINTS.uid) && /^\d{1,12}$/.test(v)) {
      out.user_id = v;
    } else if (!out.session && hit(SMART_FIELD_HINTS.session) && _looksLikeKey(v)) {
      out.session = v.replace(/^bearer\s+/i, '');
    } else if (!out.access_token && hit(SMART_FIELD_HINTS.token) && _looksLikeKey(v)) {
      out.access_token = v.replace(/^bearer\s+/i, '');
    } else if (!out.api_key && hit(SMART_FIELD_HINTS.key) && _looksLikeKey(v)) {
      out.api_key = v.replace(/^bearer\s+/i, '');
    }
  }

  // ---- 4) 兜底：正则抓 URL / Key ----
  // Authorization: Bearer xxx 优先当作 api_key
  const bearer = text.match(/authorization\s*:\s*bearer\s+([A-Za-z0-9_\-.]{12,})/i);
  if (bearer && !out.api_key) out.api_key = bearer[1];
  if (!out.base_url) out.base_url = _findUrl(text);
  if (!out.api_key) {
    // 从 URL 中剥离可能的 key 参数
    const u = text.match(/[?&](?:key|api[-_]?key|token)=([A-Za-z0-9_\-.]{12,})/i);
    if (u) out.api_key = u[1];
  }
  if (!out.api_key) out.api_key = _findKey(text);
  if (!out.api_key && out.session) { /* 只有 session 也能用 */ }

  // ---- 5) 兜底：名称取域名 ----
  if (!out.name && out.base_url) {
    out.name = out.base_url.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  }

  // ---- 6) 记录命中项 ----
  if (out.base_url) out._found.push('Base URL');
  if (out.api_key) out._found.push('API Key');
  if (out.access_token) out._found.push('访问令牌');
  if (out.session) out._found.push('会话/刷新令牌');
  if (out.user_id) out._found.push('用户 ID');
  if (out.name) out._found.push('名称');
  return out;
}

function smartBoxHtml() {
  return `
    <div class="field full smart-box">
      <textarea id="f-smart" placeholder="粘贴配置 / curl / 密钥段落，自动识别并填入下方"></textarea>
      <div class="smart-foot">
        <button class="btn ghost" type="button" id="f-smart-run">识别并填入</button>
        <button class="btn ghost" type="button" id="f-smart-clear">清空</button>
        <span class="smart-hint" id="f-smart-hint"></span>
      </div>
    </div>`;
}

function bindSmartBox() {
  const run = $('#f-smart-run');
  const box = $('#f-smart');
  const hint = $('#f-smart-hint');
  if (!run || !box) return;

  const apply = () => {
    const r = smartParse(box.value);
    if (!r.base_url && !r.api_key && !r.session && !r.access_token) {
      hint.className = 'smart-hint err';
      hint.textContent = '没识别到有效信息，请检查粘贴内容';
      return;
    }
    const setVal = (sel, v) => {
      const el = $(sel);
      if (!el || !v) return false;
      el.value = v;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 900);
      return true;
    };
    setVal('#f-url', r.base_url);
    setVal('#f-key', r.api_key);
    setVal('#f-token', r.access_token);
    setVal('#f-session', r.session);
    setVal('#f-uid', r.user_id);
    if (r.name && !$('#f-name').value.trim()) setVal('#f-name', r.name);

    hint.className = 'smart-hint ok';
    hint.textContent = '已识别填入：' + r._found.join('、');
  };

  run.onclick = apply;
  $('#f-smart-clear').onclick = () => {
    box.value = ''; hint.textContent = ''; hint.className = 'smart-hint';
  };
  // Ctrl/Cmd + Enter 快捷识别
  box.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); }
  });
  // 粘贴后自动识别
  box.addEventListener('paste', () => { setTimeout(apply, 60); });
}

function siteForm(site) {
  const s = site || {};
  // 编辑态：已有值的敏感字段默认「闭眼」掩码显示，点右侧眼睛可查看
  const secret = (id, val, ph, hint) => {
    const has = !!(val || '').trim();
    return `<label class="field${hint ? ' full' : ''}">
      <span class="label">${hint || ''}</span>
      <span class="pw-wrap">
        <input type="text" class="secret" id="${id}" value="${esc(val || '')}" placeholder="${ph}" autocomplete="off" spellcheck="false" autocapitalize="off">
        <button class="pw-eye${has ? '' : ' hidden'}" type="button" data-eye="${id}" title="查看内容" aria-label="查看内容">
          <svg class="eye-off" viewBox="0 0 20 20" width="16" height="16"><path d="M3 10s2.6-4.4 7-4.4S17 10 17 10s-2.6 4.4-7 4.4S3 10 3 10z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="1.9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.6 3.6l12.8 12.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <svg class="eye-on hidden" viewBox="0 0 20 20" width="16" height="16"><path d="M3 10s2.6-4.4 7-4.4S17 10 17 10s-2.6 4.4-7 4.4S3 10 3 10z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="1.9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
      </span>
    </label>`;
  };
  return `
  <h3>${s.id ? '编辑站点' : '添加中转站'}</h3>
  <p class="modal-sub">Base URL + API Key 即可。余额读不到时，再补访问令牌或会话 Cookie。</p>
  <div class="form">
    ${smartBoxHtml()}
    <label class="field full">
      <span class="label">名称</span>
      <input type="text" id="f-name" value="${esc(s.name || '')}" placeholder="随便起，方便辨认">
    </label>
    <label class="field full">
      <span class="label">Base URL</span>
      <input type="text" id="f-url" value="${esc(s.base_url || '')}" placeholder="https://your-relay.com">
      <span class="hint">带不带 /v1 都行，程序会自动规范化</span>
    </label>
    ${secret('f-key', s.api_key, s.id ? '留空则不修改' : 'sk-xxxxxxxx', 'API Key <em>sk- 开头</em>')}

    <div class="field full test-box" id="f-testbox">
      <div class="tst-head">
        <svg viewBox="0 0 20 20" width="15" height="15"><path d="M8.4 11.6l3.2-3.2" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M7.6 12.4l-1.4 1.4a2.9 2.9 0 01-4.1-4.1l2.9-2.9a2.9 2.9 0 014.1 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12.4 7.6l1.4-1.4a2.9 2.9 0 014.1 4.1l-2.9 2.9a2.9 2.9 0 01-4.1 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        先测一测 <em>不保存，直接用上面的 URL + Key 试连通</em>
      </div>
      <div class="tst-foot">
        <button class="btn ghost" type="button" id="f-conn">
          <svg viewBox="0 0 20 20" width="14" height="14" style="vertical-align:-2px"><path d="M10 2.6a7.4 7.4 0 107.4 7.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M17.4 4v4h-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
          测试连通
        </button>
        <span class="tst-result" id="f-conn-result">检查地址是否可达、Key 是否有效、能读到多少模型</span>
      </div>
      <div class="tst-detail" id="f-conn-detail" hidden></div>
    </div>

    <details class="field full cred-help">
      <summary class="ch-title">通过 URL + Key 无法获取余额时，需要填写下方访问令牌或会话 Cookie <em class="ch-fold">展开</em></summary>
      <div class="ch-grid">
        <div class="ch-item">
          <div class="ch-name"><i>A</i>访问令牌 <span class="ch-tag">推荐</span></div>
          <div class="ch-body">站点 → 头像 → <b>个人设置</b> → <b>安全设置</b> → 生成「系统访问令牌」。<br>
          各站叫法不同：<b>访问令牌 / 系统令牌 / AccessToken / 个人令牌</b>。</div>
        </div>
        <div class="ch-item">
          <div class="ch-name"><i>B</i>会话 Cookie <span class="ch-tag alt">找不到 A 就用这个</span></div>
          <div class="ch-body">登录后 <b>F12</b> → <b>Application</b> → <b>Cookies</b> → 复制 <b>session</b> 的值。<br>
          没有 session、只有 <b>new_api_refresh</b> 的站，复制它的值即可（程序会自动续期）。</div>
        </div>
      </div>

      <div class="form cred-fields">
        ${secret('f-token', s.access_token, s.id ? '留空则不修改' : '粘贴访问令牌', '访问令牌 <em>选填</em>')}
        ${secret('f-session', s.session, s.id ? '留空则不修改' : '粘贴 session 或 new_api_refresh', '会话 Cookie <em>选填</em>')}
        <label class="field full">
          <span class="label">用户 ID <em>多数站点要求填</em></span>
          <input type="text" id="f-uid" value="${esc(s.user_id || '')}" placeholder="个人设置里能看到，例如 4004">
        </label>
        <label class="field full">
          <span class="label">充值比 <em>¥ / $，选填</em></span>
          <input type="number" id="f-cny" step="0.1" min="0.1" value="${s.usd_cny != null ? esc(s.usd_cny) : ''}" placeholder="留空用全局或自动识别">
          <span class="hint">1 美元额度 = 多少元人民币。留空则优先用站点 <code>/api/status</code> 自动识别，再退到全局设置</span>
        </label>
      </div>
    </details>

    <label class="field full">
      <span class="label">备注</span>
      <input type="text" id="f-note" value="${esc(s.note || '')}" placeholder="选填，例如：充值送 20%">
    </label>
    <label class="switch full"><input type="checkbox" id="f-enabled" ${s.enabled !== false ? 'checked' : ''}><span></span>启用该站点</label>
    <label class="switch full"><input type="checkbox" id="f-insecure" ${s.insecure_ssl ? 'checked' : ''}><span></span>跳过 HTTPS 证书校验 <em style="font-weight:400;color:var(--muted)">自签证书报 SSL 错误时才勾选</em></label>
  </div>
  <div class="modal-foot sticky">
    <button class="btn ghost" data-close>取消</button>
    <button class="btn ghost" id="f-test">保存并探测</button>
    <button class="btn primary" id="f-save">保存</button>
  </div>`;
}

// 「闭眼 / 睁眼」切换敏感字段的显示
// 注意：凭证框故意用 type=text + CSS 圆点遮罩（-webkit-text-security），
// 若改成 type=password，浏览器会把保存表单当登录，每次保存都弹「是否保存密码」
function bindEyeToggles(scope) {
  $$('[data-eye]', scope || document).forEach(btn => {
    btn.classList.remove('hidden');
    btn.onclick = () => {
      const inp = $('#' + btn.dataset.eye);
      if (!inp) return;
      const show = !inp.classList.contains('reveal');
      inp.classList.toggle('reveal', show);
      btn.classList.toggle('on', show);
      btn.title = show ? '隐藏内容' : '查看内容';
      $$('.eye-off', btn).forEach(s => s.classList.toggle('hidden', show));
      $$('.eye-on', btn).forEach(s => s.classList.toggle('hidden', !show));
      inp.focus();
    };
  });
}

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-backdrop').classList.remove('hidden');
  $$('[data-close]', $('#modal')).forEach(b => b.onclick = closeModal);
}
function closeModal() { $('#modal-backdrop').classList.add('hidden'); $('#modal').innerHTML = ''; }

// 添加站点前先测「URL + Key」是否可用（不保存）
function bindConnTest() {
  const btn = $('#f-conn');
  if (!btn) return;
  const out = $('#f-conn-result');
  const detail = $('#f-conn-detail');

  const say = (cls, text) => {
    out.className = 'tst-result ' + cls;
    out.textContent = text;
  };

  btn.onclick = async () => {
    const url = $('#f-url').value.trim();
    if (!url) { say('err', '请先填 Base URL'); $('#f-url').focus(); return; }
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.textContent = '测试中…';
    say('pending', '正在连接…');
    detail.hidden = true;
    try {
      const r = await api('/api/test-conn', {
        method: 'POST',
        body: JSON.stringify({
          base_url: url,
          api_key: $('#f-key').value,
          access_token: $('#f-token').value,
          session: $('#f-session').value,
          user_id: $('#f-uid').value.trim(),
          insecure_ssl: $('#f-insecure').checked,
        }),
      });
      if (r.error) throw new Error(r.error);
      renderConnResult(r);
    } catch (e) {
      say('err', '测试失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  };

  function renderConnResult(r) {
    if (!r.reachable && !r.ok) {
      say('err', '❌ 连不上这个地址（' + (r.elapsed_ms || 0) + ' ms）——检查域名、协议头或是否需要跳过证书校验');
    } else if (!r.ok) {
      say('err', '❌ 能连上，但读不到数据——多半是 Key 无效或没权限');
    } else if (!r.model_count) {
      say('warn', '⚠️ 连通了，但没读到模型列表（Key 可能只能用于对话，或模型接口路径不同）');
    } else if (r.balance_usd == null) {
      say('warn', `⚠️ 可用（${r.mode_label}）· ${r.model_count} 个模型，但余额查询失败——展开下方，补填访问令牌或会话 Cookie（多数站还要填用户 ID）再测一次`);
    } else {
      say('ok', `✅ 完全可用（${r.mode_label}）· ${r.model_count} 个模型 · 余额 ${fmtUsd(r.balance_usd)} · ${r.elapsed_ms} ms`);
    }

    const chips = [];
    if (r.version) chips.push(['版本', r.version]);
    if (r.site_name && r.site_name !== r.base_url) chips.push(['站点名', r.site_name]);
    if (r.normalized_url && r.normalized_url !== r.base_url) chips.push(['规范化地址', r.normalized_url]);
    if (r.auth_used) chips.push(['生效凭证', r.auth_used]);
    if (r.model_count) chips.push(['模型数', r.model_count]);
    if (r.balance_usd != null) chips.push(['余额', fmtUsd(r.balance_usd)]);
    if (r.used_usd != null) chips.push(['已用', fmtUsd(r.used_usd)]);
    if (r.request_count != null) chips.push(['请求数', fmtNum(r.request_count)]);

    const modelLine = (r.models || []).length
      ? `<div class="tst-models">${r.models.map(m => `<code>${esc(m)}</code>`).join('')}${
          r.model_count > r.models.length ? `<span class="tst-more">等 ${r.model_count} 个</span>` : ''}</div>`
      : '';
    const errLine = (r.errors || []).length
      ? `<div class="tst-err">${r.errors.map(e => esc(e)).join('<br>')}</div>`
      : '';

    detail.innerHTML = `
      ${chips.length ? `<div class="tst-chips">${chips.map(([k, v]) =>
        `<span><i>${esc(k)}</i>${esc(v)}</span>`).join('')}</div>` : ''}
      ${modelLine}
      ${errLine}`;
    detail.hidden = false;
  }
}

async function saveSiteForm(id, closeAfter) {
  const payload = {
    name: $('#f-name').value.trim(),
    base_url: $('#f-url').value.trim(),
    api_key: $('#f-key').value,
    access_token: $('#f-token').value,
    session: $('#f-session').value,
    user_id: $('#f-uid').value.trim(),
    note: $('#f-note').value.trim(),
    enabled: $('#f-enabled').checked,
    insecure_ssl: $('#f-insecure').checked,
  };
  const cnyVal = $('#f-cny') ? $('#f-cny').value.trim() : '';
  payload.usd_cny = cnyVal ? Number(cnyVal) : null;   // 留空表示用全局或自动识别
  if (id) payload.id = id;
  if (!payload.base_url) { toast('Base URL 不能为空', 'err'); return; }
  if (!payload.name) payload.name = payload.base_url.replace(/^https?:\/\//, '').split('/')[0];

  const btn = $('#f-save');
  btn.disabled = true;
  try {
    const r = await api('/api/sites', { method: 'POST', body: JSON.stringify(payload) });
    if (r.error) throw new Error(r.error);
    await loadConfig();
    renderAll();
    if (closeAfter) closeModal();
    btn.disabled = false;
    toast('已保存，正在后台探测…', 'ok');
    // 探测在后台线程进行，这里轮询快照：卡片陆续更新，完成后通知探测结果
    (async () => {
      try {
        await pollSnapshots();
        const snap = state.snapshots.find(s => s.id === r.id);
        if (snap && snap.ok) {
          toast(`探测成功（${modeLabel(snap.mode)}，${snap.model_count} 个模型）`, 'ok');
        } else if (snap) {
          toast('探测未完全成功，点卡片上的 ⓘ 看详情', 'warn');
        }
      } catch (e) { /* 保存本身已成功，轮询异常不再打扰用户 */ }
    })();
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
    btn.disabled = false;
  }
}

function openSiteForm(id) {
  const site = id ? state.sites.find(s => s.id === id) : null;
  openModal(siteForm(site));
  bindSmartBox();
  bindConnTest();
  bindEyeToggles($('#modal'));
  $('#f-save').onclick = () => saveSiteForm(id, true);
  $('#f-test').onclick = () => saveSiteForm(id, false);
  // 列表接口出于安全只回掩码，编辑时再单独取一次明文填进输入框（仍是闭眼掩码显示）
  if (site) {
    api('/api/sites/' + site.id + '/credentials').then(r => {
      if (r.error) return;
      const put = (sel, v) => { const el = $(sel); if (el && v) el.value = v; };
      put('#f-key', r.api_key);
      put('#f-token', r.access_token);
      put('#f-session', r.session);
      bindEyeToggles($('#modal'));
    }).catch(() => {});
    // 充值比回填：state.sites 来自 /api/config（含 usd_cny 字段），编辑态填进输入框
    const cnyInput = $('#f-cny');
    if (cnyInput && site.usd_cny != null) cnyInput.value = site.usd_cny;
  }
}

function openDebug(id) {
  const s = state.snapshots.find(x => x.id === id);
  if (!s) return;
  const rows = Object.entries(s.debug || {}).map(([k, v]) =>
    `<div style="margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:#55697f">${esc(k)}</div>
      <pre style="margin:4px 0 0;font-family:var(--mono);font-size:11px;background:#fbfdff;border:1px solid var(--line);border-radius:10px;padding:9px 11px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto">${esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2))}</pre>
    </div>`).join('') || '<div class="tip-inline">没有探测记录，先刷新一次。</div>';

  openModal(`
    <h3>${esc(s.name)} · 接口探测详情</h3>
    <p class="modal-sub">识别结果：<b>${esc(modeLabel(s.mode))}</b>　耗时 ${s.elapsed_ms || 0} ms　探测于 ${timeAgo(s.probed_at)}</p>
    <div class="dbg-explain">
      <b>这里是什么？</b>程序为了读余额和用量，会向站点依次试几个接口（账户信息 / 计费 / 用量 / 模型列表），
      下面就是每个接口的<b>原始返回</b>。数据不对、或提示凭证无效时，看这里的返回就能知道站点到底回了什么。
      <div class="dbg-steps">
        <span>① 站点元信息 <code>status</code></span>
        <span>② 账户信息 <code>user_self</code></span>
        <span>③ 模型列表 <code>models</code></span>
        <span>④ 计费接口 <code>billing_*</code></span>
        <span>⑤ 用量接口 <code>gw_usage</code></span>
        <span>⑥ Cookie 自动续期 <code>session_renew</code></span>
        <span>⑦ 刷新令牌轮换 <code>token_rotation</code></span>
      </div>
    </div>
    ${(s.errors || []).length ? `<div class="sc-err" style="margin-bottom:12px">${esc(s.errors.join('；'))}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      ${s.quota != null ? `<span class="tag blue">quota ${fmtNum(s.quota)}</span>` : ''}
      <span class="tag mint">1 USD = ${fmtNum(s.quota_per_usd)} quota</span>
      <span class="tag lav">${s.model_count || 0} 模型</span>
      <span class="tag">${(s.tokens || []).length} 令牌</span>
      ${s.balance_usd != null ? `<span class="tag blue">余额 ${fmtUsd(s.balance_usd)}</span>` : ''}
      ${s.used_usd != null ? `<span class="tag">已用 ${fmtUsd(s.used_usd)}</span>` : ''}
      ${s.plan_name ? `<span class="tag lav">${esc(s.plan_name)}</span>` : ''}
      ${s.token_usage ? `<span class="tag">累计 ${fmtNum(s.token_usage.total)} tokens</span>` : ''}
    </div>
    <div class="dbg-rows">${rows}</div>
    <div class="modal-foot sticky">
      <button class="btn ghost" data-close>关闭</button>
      <button class="btn primary" id="dbg-refresh">重新探测</button>
    </div>`);
  $('#dbg-refresh').onclick = async () => {
    closeModal();
    await refreshAll([id]);
  };
}

/* ------------------------------ 拖拽排序 ------------------------------ */
// 同步排序控件的外观（自定义顺序时隐藏升/降序按钮）
function syncSortUI() {
  const key = $('#ov-sort-key'), dir = $('#ov-sort-dir');
  if (key && key.value !== state.sortKey) key.value = state.sortKey;
  if (dir) {
    dir.classList.toggle('hidden', state.sortKey === 'custom');
    dir.classList.toggle('desc', state.sortDir < 0);
    dir.title = state.sortDir > 0 ? '当前升序，点击改为降序' : '当前降序，点击改为升序';
  }
}

// 当前视图里所有可见元素的 data-id 顺序
function visibleOrderIds(container, sel) {
  return $$(sel, container).map(el => el.dataset.id);
}

// 把 fromId 移动到 toId 之前 / 之后，并持久化
function reorderSite(fromId, toId, after) {
  const list = visibleOrderIds(
    state.layout === 'list' ? $('#site-table') : $('#site-grid'),
    state.layout === 'list' ? 'tr[data-id]' : '[data-id]'
  );
  const ids = list.filter(id => id !== fromId);
  const at = ids.indexOf(toId);
  if (at < 0) return false;
  ids.splice(after ? at + 1 : at, 0, fromId);
  persistSiteOrder(ids);
  return true;
}

function bindDragSort() {
  const grids = [$('#site-grid'), $('#site-table-wrap')];
  grids.forEach(box => {
    if (!box || box.dataset.dragBound) return;
    box.dataset.dragBound = '1';
    let dragId = null;

    const clearMarks = () => {
      $$('.drop-before, .drop-after', box).forEach(el =>
        el.classList.remove('drop-before', 'drop-after'));
    };
    // 返回目标元素 + 是否落在后半区（决定插到前还是后）
    const hitTest = (e) => {
      const el = e.target.closest('[data-id]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const horiz = state.layout === 'card';
      const pos = horiz ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
      return { el, after: pos >= 0.5 };
    };

    box.addEventListener('dragstart', (e) => {
      if (state.sortKey !== 'custom') return;
      const el = e.target.closest('[data-id]');
      if (!el) return;
      dragId = el.dataset.id;
      el.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragId);
      } catch (err) {}
    });

    box.addEventListener('dragover', (e) => {
      if (state.sortKey !== 'custom' || !dragId) return;
      const hit = hitTest(e);
      if (!hit || hit.el.dataset.id === dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearMarks();
      hit.el.classList.add(hit.after ? 'drop-after' : 'drop-before');
    });

    box.addEventListener('dragleave', (e) => {
      if (!box.contains(e.relatedTarget)) clearMarks();
    });

    box.addEventListener('drop', (e) => {
      if (state.sortKey !== 'custom' || !dragId) return;
      const hit = hitTest(e);
      if (!hit || hit.el.dataset.id === dragId) return;
      e.preventDefault();
      if (reorderSite(dragId, hit.el.dataset.id, hit.after)) {
        dragId = null;
        renderCards();
        toast('顺序已更新', 'ok');
      }
    });

    box.addEventListener('dragend', () => {
      $$('.dragging', box).forEach(el => el.classList.remove('dragging'));
      clearMarks();
      dragId = null;
    });
  });
}

/* ------------------------------ 渲染调度 ------------------------------ */
function renderAll() {
  renderStats();
  renderCards();
  renderMatrix();
  renderUsageLegend();
  renderSettings();
  if (state.view === 'usage') { drawLineChart(); renderDonut(); renderModelBars(); }
  if (state.view === 'detail' && state.detailId) renderDetail(state.detailId);
  renderSiteList();
}

function switchView(v) {
  state.view = v;
  try { history.replaceState(null, '', '#' + v); } catch (e) {}
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  ['overview', 'models', 'usage', 'sites', 'detail'].forEach(k => {
    const el = $('#view-' + k);
    if (el) el.classList.toggle('hidden', k !== v);
  });
  if (v === 'usage') requestAnimationFrame(() => { drawLineChart(); renderDonut(); renderModelBars(); });
  if (v === 'models') renderMatrix();
  if (v === 'detail' && state.detailId) {
    renderDetail(state.detailId);
    const cur = siteById(state.detailId);
    const ob = $('#btn-detail-open');
    if (ob) ob.onclick = () => { if (cur && cur.base_url) window.open(cur.base_url, '_blank', 'noopener'); };
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */
function bind() {
  $$('.tab').forEach(t => t.onclick = () => switchView(t.dataset.view));
  $$('[data-goto]').forEach(b => b.onclick = () => switchView(b.dataset.goto));

  $('#btn-refresh').onclick = () => refreshAll(null);
  $('#btn-detail-back').onclick = () => switchView('overview');

  const sel = $('#auto-refresh');
  sel.value = localStorage.getItem('apihub_interval') || '300';
  sel.onchange = () => {
    localStorage.setItem('apihub_interval', sel.value);
    setupTimer(Number(sel.value));
  };
  setupTimer(Number(sel.value));

  // ---- 总览：卡片 / 列表切换 ----
  $$('#ov-layout .seg-btn').forEach(btn => {
    btn.onclick = () => {
      state.layout = btn.dataset.layout;
      localStorage.setItem('apihub_layout', state.layout);
      $$('#ov-layout .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderCards();
    };
  });
  $$('#ov-layout .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === state.layout));

  const sSearch = $('#site-search');
  if (sSearch) {
    sSearch.oninput = () => { state.siteSearch = sSearch.value; renderCards(); };
  }

  // ---- 总览：排序控件 ----
  const sortKey = $('#ov-sort-key');
  const sortDir = $('#ov-sort-dir');
  if (sortKey) {
    sortKey.value = state.sortKey;
    state.sortDir = SORT_DEFAULT_DIR[state.sortKey] ?? 1;
    sortKey.onchange = () => {
      state.sortKey = sortKey.value;
      state.sortDir = SORT_DEFAULT_DIR[state.sortKey] ?? 1;
      syncSortUI();
      renderCards();
      if (state.sortKey === 'custom') toast('现在可以拖拽卡片调整顺序', 'ok');
    };
  }
  if (sortDir) {
    sortDir.onclick = () => {
      state.sortDir = -state.sortDir;
      syncSortUI();
      renderCards();
    };
  }
  syncSortUI();
  bindDragSort();

  // ---- 总览卡片/列表 点击委托（两者共用） ----
  const onOverviewClick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) {
      // 卡片/行右上角的操作区（含平台跳转 ↗）不进入详情页
      if (e.target.closest('.sc-actions') || e.target.closest('.t-acts')) return;
      const card = e.target.closest('[data-open]');
      if (card) openSiteDetail(card.dataset.open);
      return;
    }
    const { act, id } = btn.dataset;
    if (act === 'open') return;  // 交给浏览器新标签打开，不进详情页
    if (act === 'refresh') {
      btn.classList.add('spin');
      await refreshAll([id]);
      btn.classList.remove('spin');
    } else if (act === 'debug') {
      openDebug(id);
    } else if (act === 'copy') {
      const r = await api('/api/sites/' + id + '/credentials');
      if (r.error) { toast('读取失败', 'err'); return; }
      const base = (r.base_url || '').replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
      const text = `${base}\n${r.api_key || ''}`;
      copyText(text, '已复制 Base URL 与 API Key');
    }
  };
  $('#site-grid').addEventListener('click', onOverviewClick);
  const tableWrap = $('#site-table-wrap');
  if (tableWrap) {
    tableWrap.addEventListener('click', (e) => {
      // 表头排序
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir = -state.sortDir;
        else { state.sortKey = k; state.sortDir = SORT_DEFAULT_DIR[k] ?? 1; }
        syncSortUI();
        renderCards();
        return;
      }
      onOverviewClick(e);
    });
  }

  // 模型矩阵
  $('#model-search').oninput = (e) => { state.modelSearch = e.target.value.trim(); renderMatrix(); };
  $('#only-common').onchange = (e) => { state.onlyCommon = e.target.checked; renderMatrix(); };

  // 连通性测试
  $('#matrix').addEventListener('click', (e) => {
    const b = e.target.closest('[data-test]');
    if (!b) return;
    const [siteId, ...rest] = b.dataset.test.split('|');
    runModelTest([{ site_id: siteId, model: rest.join('|') }]);
  });
  $('#btn-test-all').onclick = async () => {
    const pairs = currentMatrixPairs();
    if (!pairs.length) { toast('当前没有可测试的模型', 'warn'); return; }
    const btn = $('#btn-test-all');
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.textContent = `测试中…（${pairs.length}）`;
    await runModelTest(pairs);
    btn.disabled = false;
    btn.innerHTML = old;
  };
  $('#btn-test-clear').onclick = () => {
    state.modelTest = {};
    renderMatrix();
    toast('已清除测试结果', 'ok');
  };
  bindTestMode('matrix');

  // 用量图例 = 站点显隐
  $('#usage-legend').addEventListener('click', (e) => {
    const el = e.target.closest('.lg');
    if (!el) return;
    const id = el.dataset.id;
    if (state.hiddenSites.has(id)) state.hiddenSites.delete(id);
    else if (visibleSites().length > 1) state.hiddenSites.add(id);
    else { toast('至少保留一个站点', 'warn'); return; }
    renderUsageLegend(); drawLineChart(); renderDonut(); renderModelBars();
  });

  $('#usage-cny').onchange = (e) => {
    state.usageCny = e.target.checked;
    drawLineChart(); renderDonut(); renderModelBars();
  };

  // 用量分析页的时间范围（在 renderSettings 里首次注入）
  const pick = $('#usage-range-pick');
  if (pick) {
    pick.innerHTML = rangePickerHtml('usage');
    bindRangePicker('usage', () => { drawLineChart(); renderDonut(); renderModelBars(); });
  }

  // 站点管理
  $('#btn-add-site').onclick = () => openSiteForm(null);
  $('#site-list').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return openSiteForm(ed.dataset.edit);
    const dl = e.target.closest('[data-del]');
    if (dl) {
      const s = state.sites.find(x => x.id === dl.dataset.del);
      if (!confirm(`确定删除站点「${s ? s.name : ''}」？该操作只影响本地配置。`)) return;
      await api('/api/sites/' + dl.dataset.del + '/delete', { method: 'POST' });
      await loadConfig();
      await loadSnapshot();
      renderAll();
      toast('已删除', 'ok');
    }
  });

  // 设置
  $('#btn-save-settings').onclick = async () => {
    const payload = {
      usd_cny: Number($('#set-cny').value) || 1,
      low_balance_usd: Number($('#set-low').value) || 0,
      timeout: Number($('#set-timeout').value) || 15,
    };
    await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
    await loadConfig();
    renderAll();
    toast('设置已保存，刷新后生效', 'ok');
  };

  // 只有「按下」和「松开」都在遮罩空白处 才关闭。
  // 避免在输入框里按下、把鼠标拖到框外松开时误关（拖选文字等场景）。
  const bd = $('#modal-backdrop');
  let downOnBackdrop = false;
  bd.addEventListener('mousedown', (e) => { downOnBackdrop = (e.target === bd); });
  bd.addEventListener('mouseup', (e) => {
    if (downOnBackdrop && e.target === bd) closeModal();
    downOnBackdrop = false;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (state.view === 'usage') drawLineChart();
      if (state.view === 'detail' && state.detailId) {
        const s = siteById(state.detailId);
        if (s) drawDetailChart(s);
      }
    }, 180);
  });
}

function setupTimer(sec) {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (sec > 0) {
    state.timer = setInterval(() => { refreshAll(null); }, sec * 1000);
    setLive('on');
  } else {
    setLive('paused');
  }
}

/* ------------------------------ 启动 ------------------------------ */
(async function init() {
  bind();
  const h = location.hash.slice(1);
  if (['overview', 'models', 'usage', 'sites'].includes(h)) switchView(h);
  else if (h === 'sites/new') { switchView('sites'); openSiteForm(null); }
  else if (h.indexOf('site=') === 0) openSiteDetail(h.slice(5));
  try {
    await Promise.all([loadConfig(), loadSnapshot()]);
  } catch (e) {
    toast('无法连接本地服务：' + e.message, 'err');
  }
  // 恢复上次的展示方式
  $$('#ov-layout .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === state.layout));
  renderAll();
  $('#foot-status').textContent = state.snapshots.length
    ? '数据更新于 ' + new Date().toLocaleTimeString('zh-CN')
    : '等待首次刷新';
})();
