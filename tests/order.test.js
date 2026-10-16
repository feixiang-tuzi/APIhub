/* 自定义排序回归测试
 *
 * 背景：卡片/表格行内部的「打开↗ / 刷新 / 调试 / 复制」按钮也带有 data-id，
 *       而 reorderSite 收集顺序时曾用 [data-id] 通配选择器，把这些嵌套元素
 *       一并收进来 → 顺序数组出现大量重复项 → 刷新后自定义排列被「重置」。
 *
 * 这里做两层防护：
 *   1) 功能层：persistSiteOrder 必须去重；applyCustomOrder 必须与快照数组顺序无关。
 *   2) 源码层：reorderSite 必须使用 .site-card[data-id] / tr[data-id]，不得回退到裸 [data-id]。
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

const start = src.indexOf('// 把站点 id 顺序写回本地');
const end = src.indexOf('// 单个站点的派生展示字段');
if (start < 0 || end < 0) throw new Error('未找到排序代码段');
const code = src.slice(start, end);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  [OK]   ${name}${extra ? '  -> ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
};

function makeApi(initial) {
  const state = { siteOrder: initial || [], sortKey: 'custom', sortDir: 1, settings: {} };
  const store = {};
  const localStorage = { setItem: (k, v) => { store[k] = v; }, getItem: k => (k in store ? store[k] : null) };
  const fn = new Function('state', 'localStorage', code + '\nreturn { persistSiteOrder, applyCustomOrder, sortSites };');
  return { api: fn(state, localStorage), state, store };
}

const mk = ids => ids.map(id => ({ id, name: 'site_' + id, enabled: true, balance_usd: 1, used_usd: 1 }));

console.log('\n=== 自定义排序回归 ===');

// 1) persistSiteOrder 必须去重
{
  const { api, state, store } = makeApi();
  api.persistSiteOrder(['a', 'a', 'b', 'a', 'c', 'b']);
  ok('persistSiteOrder 去重', JSON.stringify(state.siteOrder) === JSON.stringify(['a', 'b', 'c']),
    JSON.stringify(state.siteOrder));
  ok('localStorage 落盘无重复', JSON.parse(store['apihub_site_order']).length === 3);
}

// 2) 自定义顺序与快照数组顺序无关（刷新重排不改变展示顺序）
{
  const { api } = makeApi(['c', 'a', 'd', 'b']);
  const want = 'c,a,d,b';
  const r1 = api.sortSites(mk(['a', 'b', 'c', 'd'])).map(s => s.id).join(',');
  const r2 = api.sortSites(mk(['d', 'c', 'b', 'a'])).map(s => s.id).join(',');
  ok('自定义顺序稳定（正序输入）', r1 === want, r1);
  ok('自定义顺序稳定（乱序输入）', r2 === want, r2);
}

// 3) 未登记站点排在末尾，不干扰已登记顺序
{
  const { api } = makeApi(['c', 'a']);
  const r = api.sortSites(mk(['a', 'zzz', 'c', 'bbb'])).map(s => s.id).join(',');
  ok('未登记站点排末尾', r === 'c,a,bbb,zzz', r);
}

// 4) 源码层守卫：reorderSite 不得使用裸 [data-id] 收集顺序
{
  const seg = src.slice(src.indexOf('function reorderSite'), src.indexOf('function bindDragSort'));
  ok("reorderSite 使用 .site-card[data-id]", seg.includes("'.site-card[data-id]'"));
  ok("reorderSite 使用 tr[data-id]", seg.includes("'tr[data-id]'"));
  ok('reorderSite 不含裸 [data-id] 收集', !seg.includes("'[data-id]'"));
}

console.log(`\n自定义排序：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
