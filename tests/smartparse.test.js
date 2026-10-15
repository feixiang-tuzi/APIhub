/* 智能识别解析器单测：直接在 Node 里跑 app.js 中的 smartParse */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

// 截取 smartParse 相关代码片段并在沙箱里求值
const start = src.indexOf('/* ---------------------- 智能识别');
const end = src.indexOf('function smartBoxHtml()');
if (start < 0 || end < 0) throw new Error('未找到智能识别代码段');
const code = src.slice(start, end);

const sandbox = {};
const fn = new Function(code + '\nreturn { smartParse };');
const { smartParse } = fn();

const cases = [
  {
    name: 'JSON 标准格式',
    input: `{ "base_url": "https://api.example.com", "api_key": "sk-abcdef1234567890abcdef" }`,
    want: { base_url: 'https://api.example.com', api_key: 'sk-abcdef1234567890abcdef' },
  },
  {
    name: 'JSON 带 /v1',
    input: `{"baseUrl":"https://relay.abc.com/v1","apiKey":"sk-0123456789abcdef0123"}`,
    want: { base_url: 'https://relay.abc.com', api_key: 'sk-0123456789abcdef0123' },
  },
  {
    name: '环境变量 .env',
    input: `OPENAI_BASE_URL=https://gw.xyz.ai/v1
OPENAI_API_KEY=sk-zzz998877665544332211`,
    want: { base_url: 'https://gw.xyz.ai', api_key: 'sk-zzz998877665544332211' },
  },
  {
    name: 'curl 命令',
    input: `curl https://api.example.com/v1/chat/completions -H "Authorization: Bearer sk-demo0fake0key0for0test0only0abcd"`,
    want: { base_url: 'https://api.example.com', api_key: 'sk-demo0fake0key0for0test0only0abcd' },
  },
  {
    name: '纯文本 URL + Key',
    input: `https://relay.example.com
sk-7f3a9b2c1d4e5f60718293a4b5c6d7e8`,
    want: { base_url: 'https://relay.example.com', api_key: 'sk-7f3a9b2c1d4e5f60718293a4b5c6d7e8' },
  },
  {
    name: 'YAML 风格',
    input: `name: 主力站
base_url: https://main.relay.io
api_key: sk-aaaabbbbccccddddeeeeffff`,
    want: { base_url: 'https://main.relay.io', api_key: 'sk-aaaabbbbccccddddeeeeffff', name: '主力站' },
  },
  {
    name: '含访问令牌与用户 ID',
    input: `{"base_url":"https://newapi.demo.com","access_token":"abc123def456ghi789","user_id":"4004"}`,
    want: { base_url: 'https://newapi.demo.com', access_token: 'abc123def456ghi789', user_id: '4004' },
  },
  {
    name: 'URL 带 key 查询参数',
    input: `https://bare.relay.net/v1?key=sk-qqqqwwwwrrrreeeettttyyyy`,
    want: { base_url: 'https://bare.relay.net', api_key: 'sk-qqqqwwwwrrrreeeettttyyyy' },
  },
  {
    name: '无协议头域名自动补 https',
    input: `api.simplerelay.com
sk-11223344556677889900aabb`,
    want: { base_url: 'https://api.simplerelay.com', api_key: 'sk-11223344556677889900aabb' },
  },
  {
    name: 'session 刷新令牌',
    input: `{"base_url":"https://demo.newapi.app","new_api_refresh":"eyJhbGciOiJIUzI1NiJ9.abcdefghijklmn"}`,
    want: { base_url: 'https://demo.newapi.app', session: 'eyJhbGciOiJIUzI1NiJ9.abcdefghijklmn' },
  },
  {
    name: '空输入',
    input: '',
    want: {},
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = smartParse(c.input);
  const errs = [];
  for (const [k, v] of Object.entries(c.want)) {
    if (r[k] !== v) errs.push(`${k}: 期望 "${v}" 实得 "${r[k]}"`);
  }
  if (!Object.keys(c.want).length && (r.base_url || r.api_key)) {
    errs.push(`空输入不应有结果，实得 base_url="${r.base_url}" api_key="${r.api_key}"`);
  }
  if (errs.length) {
    fail++;
    console.log(`✗ ${c.name}\n   ${errs.join('\n   ')}`);
  } else {
    pass++;
    console.log(`✓ ${c.name}  → ${r._found.join('、') || '（无）'}`);
  }
}
console.log(`\n智能识别：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
