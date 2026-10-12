'use strict';

/**
 * §4 core/utils.js 契约测试
 * 运行器：node:test + node:assert/strict（零依赖，Node 18/20/22 均可）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../core/utils.js');

assert.ok(mod && typeof mod === 'object', 'core/utils.js 必须导出对象（契约 §1.2）');
assert.ok(mod.utils && typeof mod.utils === 'object', 'core/utils.js 必须导出 { utils }（契约 §1.2）');
const utils = mod.utils;

test('utils: 导出契约完整（§4 全部 12 个函数）', () => {
  const fns = [
    'genId', 'escHtml', 'escAttr', 'formatDate', 'formatDateTime',
    'formatDuration', 'replaceVars', 'highlightVariables', 'extractVariables',
    'debounce', 'clamp', 'deepClone'
  ];
  for (const fn of fns) {
    assert.strictEqual(typeof utils[fn], 'function', `utils.${fn} 必须是函数`);
  }
});

test('utils.genId: 返回字符串 id 且大量调用不重复', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(utils.genId('t'));
  assert.strictEqual(ids.size, 50, 'genId 必须包含随机成分，50 次调用不得重复');
  for (const id of ids) {
    assert.strictEqual(typeof id, 'string');
    assert.match(id, /^[A-Za-z0-9_]+$/);
    assert.ok(id.length > 2);
  }
});

test('utils.genId: 使用 prefix_ 前缀形式（契约示例 "t_m1x2y3abc"，数据模型 id 形如 t_xxx）', () => {
  assert.ok(utils.genId('t').startsWith('t_'), 'genId("t") 应形如 t_xxx');
  assert.ok(utils.genId('s').startsWith('s_'), 'genId("s") 应形如 s_xxx');
  assert.ok(utils.genId('ss').startsWith('ss_'), 'genId("ss") 应形如 ss_xxx');
  assert.ok(utils.genId('i').startsWith('i_'), 'genId("i") 应形如 i_xxx');
  assert.ok(utils.genId('h').startsWith('h_'), 'genId("h") 应形如 h_xxx');
});

test('§12-14 utils.escHtml: 转义 & < > " 与单引号', () => {
  assert.strictEqual(utils.escHtml('&'), '&amp;');
  assert.strictEqual(utils.escHtml('<'), '&lt;');
  assert.strictEqual(utils.escHtml('>'), '&gt;');
  assert.strictEqual(utils.escHtml('"'), '&quot;');
  assert.match(utils.escHtml("'"), /^(?:&#39;|&#x27;|&apos;)$/, "单引号必须转义为实体");
});

test('§12-14 utils.escHtml: 转义 XSS 向量 <img src=x onerror=alert(1)>', () => {
  const out = utils.escHtml('<img src=x onerror=alert(1)>');
  assert.strictEqual(out, '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(out.includes('<'), false, '输出不得含裸 <');
  assert.strictEqual(out.includes('>'), false, '输出不得含裸 >');
});

test('utils.escHtml: 先转义 & 避免重复实体被二次解码', () => {
  assert.strictEqual(utils.escHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.strictEqual(utils.escHtml('&amp;'), '&amp;amp;');
});

test('utils.escHtml: 普通文本不变', () => {
  assert.strictEqual(utils.escHtml('文献精读 2026'), '文献精读 2026');
});

test('utils.escAttr: 中和属性注入（引号与尖括号不得裸出）', () => {
  const injected = utils.escAttr('" onmouseover="alert(1)');
  assert.strictEqual(injected.includes('"'), false, '属性值中的 " 必须被转义');
  assert.strictEqual(utils.escAttr('<script>').includes('<'), false, '属性值中的 < 必须被转义');
  assert.strictEqual(utils.escAttr('10.0.0.1'), '10.0.0.1');
});

test('utils.formatDate: 输出 "3/14"（本地时间，注入固定时间戳）', () => {
  const ts = new Date(2026, 2, 14, 9, 5, 0).getTime();
  assert.strictEqual(utils.formatDate(ts), '3/14');
});

test('utils.formatDateTime: 输出 "2026-03-14 09:05"', () => {
  const ts = new Date(2026, 2, 14, 9, 5, 0).getTime();
  assert.strictEqual(utils.formatDateTime(ts), '2026-03-14 09:05');
});

test('utils.formatDuration: "45 分钟" / "2 小时 5 分钟"', () => {
  assert.strictEqual(utils.formatDuration(45 * 60 * 1000), '45 分钟');
  assert.strictEqual(utils.formatDuration((2 * 60 + 5) * 60 * 1000), '2 小时 5 分钟');
});

test('utils.replaceVars: {{k}} -> vars[k]，缺失保留原样', () => {
  assert.strictEqual(
    utils.replaceVars('{{服务器地址}} 与 {{端口}}', { 服务器地址: '10.0.0.1', 端口: '8080' }),
    '10.0.0.1 与 8080'
  );
  assert.strictEqual(utils.replaceVars('{{缺失}}', {}), '{{缺失}}');
  assert.strictEqual(utils.replaceVars('{{a}}{{a}}', { a: 'X' }), 'XX');
  assert.strictEqual(utils.replaceVars('无变量文本', { a: 'X' }), '无变量文本');
});

test('utils.highlightVariables: {{k}} -> <span class="variable-value">{{k}}</span>', () => {
  assert.strictEqual(
    utils.highlightVariables('{{k}}'),
    '<span class="variable-value">{{k}}</span>'
  );
  assert.strictEqual(
    utils.highlightVariables('前 {{a}} 后'),
    '前 <span class="variable-value">{{a}}</span> 后'
  );
});

test('utils.extractVariables: 去重 + 按首次出现顺序', () => {
  assert.deepStrictEqual(
    utils.extractVariables('{{b}} {{a}}', '{{b}} {{c}}'),
    ['b', 'a', 'c']
  );
  assert.deepStrictEqual(utils.extractVariables('没有变量'), []);
  assert.deepStrictEqual(utils.extractVariables(), []);
});

test('utils.debounce: 合并高频调用，只执行最后一次', async () => {
  let calls = 0;
  let lastArg = null;
  const fn = utils.debounce((v) => { calls += 1; lastArg = v; }, 20);
  fn(1); fn(2); fn(3);
  assert.strictEqual(calls, 0, 'debounce 必须延迟执行');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.strictEqual(calls, 1, '20ms 窗口内 3 次调用只应执行 1 次');
  assert.strictEqual(lastArg, 3, '应使用最后一次调用的参数');
});

test('utils.clamp: 边界钳制', () => {
  assert.strictEqual(utils.clamp(5, 0, 10), 5);
  assert.strictEqual(utils.clamp(-1, 0, 10), 0);
  assert.strictEqual(utils.clamp(99, 0, 10), 10);
  assert.strictEqual(utils.clamp(0, 0, 10), 0);
  assert.strictEqual(utils.clamp(10, 0, 10), 10);
});

test('utils.deepClone: 结构化深拷贝，不共享引用', () => {
  const src = { a: 1, b: { c: [1, 2, 3] }, d: 'x' };
  const copy = utils.deepClone(src);
  assert.deepStrictEqual(copy, src);
  assert.notStrictEqual(copy, src);
  assert.notStrictEqual(copy.b, src.b);
  assert.notStrictEqual(copy.b.c, src.b.c);
  copy.b.c.push(4);
  copy.a = 999;
  assert.deepStrictEqual(src.b.c, [1, 2, 3]);
  assert.strictEqual(src.a, 1);
});
