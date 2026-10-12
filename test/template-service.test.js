'use strict';

/**
 * §5 core/template-service.js 契约测试（纯函数 + 不可变风格）
 * 覆盖 §12 验收矩阵 #5 #16 #17
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../core/template-service.js');

assert.ok(mod && typeof mod === 'object', 'core/template-service.js 必须导出对象（契约 §1.2）');
assert.ok(
  mod.templateService && typeof mod.templateService === 'object',
  'core/template-service.js 必须导出 { templateService }（契约 §1.2）'
);
const templateService = mod.templateService;

/** 夹具模板：name/desc/tags/步骤 title/步骤 note/子步骤 title 六条搜索路径各自唯一可辨识 */
function makeTemplate(overrides) {
  return Object.assign(
    {
      id: 't_lit',
      name: 'Literature Review',
      desc: '深度阅读论文',
      category: '科研',
      tags: ['论文', 'Paper'],
      favorite: false,
      version: 3,
      steps: [
        {
          id: 's_a',
          title: '确认文章信息',
          note: '记录 DOI 和研究对象',
          done: false,
          subSteps: [{ id: 'ss_a1', title: '记录 DOI', done: false }]
        },
        {
          id: 's_b',
          title: '提取方法',
          note: '关注实验设计',
          done: false,
          subSteps: []
        }
      ],
      createdAt: 1000,
      updatedAt: 2000,
      lastUsedAt: null
    },
    overrides || {}
  );
}

test('templateService: 导出契约完整（§5）', () => {
  const fns = [
    'createTemplate', 'updateTemplate', 'duplicateTemplate', 'normalizeTags',
    'templateMatchesQuery', 'filterTemplates', 'findTemplate', 'buildSnapshotSteps'
  ];
  for (const fn of fns) {
    assert.strictEqual(typeof templateService[fn], 'function', `templateService.${fn} 必须是函数`);
  }
});

test('templateService.createTemplate: 默认字段与 id 生成（§2.2）', () => {
  const t = templateService.createTemplate({
    name: '文献精读',
    desc: '逐段精读',
    category: '科研',
    tags: ['文献', '精读'],
    steps: [{ id: 's_1', title: '读摘要', note: '', done: false, subSteps: [] }]
  });
  assert.strictEqual(typeof t.id, 'string');
  assert.ok(t.id.startsWith('t_'), 'template.id 必须形如 t_xxx');
  assert.strictEqual(t.name, '文献精读');
  assert.strictEqual(t.desc, '逐段精读');
  assert.strictEqual(t.category, '科研');
  assert.deepStrictEqual(t.tags, ['文献', '精读']);
  assert.strictEqual(t.favorite, false);
  assert.strictEqual(t.version, 1, '新建模板 version 必须为 1');
  assert.strictEqual(t.lastUsedAt, null);
  assert.strictEqual(typeof t.createdAt, 'number');
  assert.strictEqual(typeof t.updatedAt, 'number');
  assert.ok(t.createdAt > 0);
  assert.ok(t.updatedAt > 0);
  assert.strictEqual(t.steps.length, 1);
  assert.strictEqual(t.steps[0].title, '读摘要');
});

test('templateService.createTemplate: 非法 category 回落 "其他"（§2.2）', () => {
  const t = templateService.createTemplate({ name: 'x', category: '不存在的分类' });
  assert.strictEqual(t.category, '其他');
  const t2 = templateService.createTemplate({ name: 'y' });
  assert.strictEqual(t2.category, '其他');
});

test('templateService.createTemplate: 不可变，深拷贝入参 steps', () => {
  const steps = [{ id: 's_1', title: '原始', note: '', done: false, subSteps: [] }];
  const t = templateService.createTemplate({ name: 'n', steps });
  assert.notStrictEqual(t.steps, steps);
  assert.notStrictEqual(t.steps[0], steps[0]);
  t.steps[0].title = '被改';
  assert.strictEqual(steps[0].title, '原始');
});

test('templateService.normalizeTags: 数组去重/trim/去空', () => {
  assert.deepStrictEqual(templateService.normalizeTags([' a ', 'a', 'b', '', '  ']), ['a', 'b']);
  assert.deepStrictEqual(templateService.normalizeTags([]), []);
});

test('templateService.normalizeTags: 逗号 / 中文逗号分隔字符串', () => {
  assert.deepStrictEqual(templateService.normalizeTags('a,b'), ['a', 'b']);
  assert.deepStrictEqual(templateService.normalizeTags('a，b'), ['a', 'b']);
  assert.deepStrictEqual(templateService.normalizeTags('a, b ，c'), ['a', 'b', 'c']);
});

test('templateService.normalizeTags: 非数组非字符串输入返回数组且不抛错', () => {
  assert.deepStrictEqual(templateService.normalizeTags(null), []);
  assert.deepStrictEqual(templateService.normalizeTags(undefined), []);
  let out;
  assert.doesNotThrow(() => { out = templateService.normalizeTags(42); });
  assert.ok(Array.isArray(out), 'normalizeTags 任何输入都必须返回数组');
});

test('templateService.normalizeTags: 最多 20 个（§2.2）', () => {
  const input = Array.from({ length: 25 }, (_, i) => `tag${i}`);
  const out = templateService.normalizeTags(input);
  assert.strictEqual(out.length, 20);
  assert.deepStrictEqual(out, input.slice(0, 20));
});

test('templateService.updateTemplate: version+1、updatedAt 刷新、不可变', () => {
  const t = makeTemplate();
  const before = Date.now();
  const u = templateService.updateTemplate(t, { name: '新名字', desc: '新描述' });
  assert.notStrictEqual(u, t);
  assert.strictEqual(u.name, '新名字');
  assert.strictEqual(u.desc, '新描述');
  assert.strictEqual(u.version, t.version + 1, '每次保存编辑 version +1');
  assert.strictEqual(u.id, t.id);
  assert.strictEqual(u.createdAt, t.createdAt);
  assert.ok(u.updatedAt >= before, 'updatedAt 必须刷新为当前时间');
  assert.strictEqual(t.name, 'Literature Review', '原模板不得被修改');
  assert.strictEqual(t.version, 3, '原模板 version 不得被修改');
});

test('§12-5 buildSnapshotSteps: 变量替换覆盖标题、备注、子步骤', () => {
  const t = makeTemplate({
    steps: [
      {
        id: 's_a',
        title: '连接 {{服务器地址}}',
        note: '确认 {{服务器地址}} 可达',
        done: false,
        subSteps: [{ id: 'ss_a1', title: 'ping {{服务器地址}}', done: false }]
      },
      { id: 's_b', title: '无变量步骤', note: '', done: false, subSteps: [] }
    ]
  });
  const vars = { 服务器地址: '10.0.0.1' };
  const steps = templateService.buildSnapshotSteps(t, vars);

  assert.strictEqual(steps[0].title, '连接 10.0.0.1', '标题中的变量必须替换');
  assert.strictEqual(steps[0].note, '确认 10.0.0.1 可达', '备注中的变量必须替换');
  assert.strictEqual(steps[0].subSteps[0].title, 'ping 10.0.0.1', '子步骤标题中的变量必须替换');
  assert.strictEqual(steps[1].title, '无变量步骤');

  assert.notStrictEqual(steps, t.steps, '必须是深拷贝');
  assert.notStrictEqual(steps[0], t.steps[0]);
  assert.notStrictEqual(steps[0].subSteps, t.steps[0].subSteps);
  assert.notStrictEqual(steps[0].subSteps[0], t.steps[0].subSteps[0]);
  assert.strictEqual(t.steps[0].title, '连接 {{服务器地址}}', '原模板必须保持未替换');
});

test('§12-5 buildSnapshotSteps: 缺失变量保留原样 {{k}}', () => {
  const t = makeTemplate({
    steps: [{ id: 's_a', title: '连接 {{未定义}}', note: '', done: false, subSteps: [] }]
  });
  const steps = templateService.buildSnapshotSteps(t, {});
  assert.strictEqual(steps[0].title, '连接 {{未定义}}');
});

test('§12-16 templateMatchesQuery: 搜索 name（大小写不敏感）', () => {
  const t = makeTemplate();
  assert.strictEqual(templateService.templateMatchesQuery(t, 'Literature'), true);
  assert.strictEqual(templateService.templateMatchesQuery(t, 'literature'), true);
  assert.strictEqual(templateService.templateMatchesQuery(t, 'LITERATURE REVIEW'), true);
});

test('§12-16 templateMatchesQuery: 搜索 desc', () => {
  assert.strictEqual(templateService.templateMatchesQuery(makeTemplate(), '深度阅读'), true);
});

test('§12-16 templateMatchesQuery: 搜索 tags（大小写不敏感）', () => {
  assert.strictEqual(templateService.templateMatchesQuery(makeTemplate(), '论文'), true);
  assert.strictEqual(templateService.templateMatchesQuery(makeTemplate(), 'paper'), true);
  assert.strictEqual(templateService.templateMatchesQuery(makeTemplate(), 'PAPER'), true);
});

test('§12-16 templateMatchesQuery: 搜索步骤标题', () => {
  assert.strictEqual(templateService.templateMatchesQuery(makeTemplate(), '确认文章信息'), true);
  assert.strictEqual(templateService.templateMatchesQuery(makeTemplate(), '提取方法'), true);
});

test('§12-16 templateMatchesQuery: 搜索步骤备注', () => {
  assert.strictEqual(templateService.templateMatchesQuery(makeTemplate(), '研究对象'), true);
  assert.strictEqual(templateService.templateMatchesQuery(makeTemplate(), '实验设计'), true);
});

test('§12-16 templateMatchesQuery: 搜索子步骤标题', () => {
  assert.strictEqual(templateService.templateMatchesQuery(makeTemplate(), '记录 DOI'), true);
});

test('§12-16 templateMatchesQuery: 未命中返回 false，空查询返回 true', () => {
  const t = makeTemplate();
  assert.strictEqual(templateService.templateMatchesQuery(t, 'zzz-not-found-zzz'), false);
  assert.strictEqual(templateService.templateMatchesQuery(t, ''), true);
});

test('templateService.filterTemplates: query / category / favoriteOnly 组合过滤', () => {
  const all = [
    makeTemplate({ id: 't_1', name: 'A', category: '科研', favorite: true }),
    makeTemplate({ id: 't_2', name: 'B', category: '学习', favorite: false }),
    makeTemplate({ id: 't_3', name: 'C', category: '科研', favorite: false })
  ];

  assert.deepStrictEqual(
    templateService.filterTemplates(all, {}).map((t) => t.id),
    ['t_1', 't_2', 't_3']
  );
  assert.deepStrictEqual(
    templateService.filterTemplates(all, { category: '科研' }).map((t) => t.id),
    ['t_1', 't_3']
  );
  assert.deepStrictEqual(
    templateService.filterTemplates(all, { favoriteOnly: true }).map((t) => t.id),
    ['t_1']
  );
  assert.deepStrictEqual(
    templateService.filterTemplates(all, { category: '科研', favoriteOnly: true }).map((t) => t.id),
    ['t_1']
  );
  assert.deepStrictEqual(
    templateService.filterTemplates(all, { query: '深度阅读' }).map((t) => t.id),
    ['t_1', 't_2', 't_3']
  );
  assert.strictEqual(all.length, 3, 'filterTemplates 不得修改入参');
});

test('templateService.filterTemplates: sort=name 升序、sort=recent 按 updatedAt 降序', () => {
  // 数据手工推导（name 升序 / updatedAt 降序）：
  //   t_1 name='B' updatedAt=100
  //   t_2 name='A' updatedAt=300
  //   t_3 name='C' updatedAt=200
  const all = [
    makeTemplate({ id: 't_1', name: 'B', updatedAt: 100 }),
    makeTemplate({ id: 't_2', name: 'A', updatedAt: 300 }),
    makeTemplate({ id: 't_3', name: 'C', updatedAt: 200 })
  ];
  assert.deepStrictEqual(
    templateService.filterTemplates(all, { sort: 'name' }).map((t) => t.id),
    ['t_2', 't_1', 't_3'],
    'sort=name 必须按名称升序：A(t_2) -> B(t_1) -> C(t_3)'
  );
  assert.deepStrictEqual(
    templateService.filterTemplates(all, { sort: 'recent' }).map((t) => t.id),
    ['t_2', 't_3', 't_1'],
    'sort=recent 必须按 updatedAt 降序：300(t_2) -> 200(t_3) -> 100(t_1)'
  );
});

test('templateService.filterTemplates: sort=created / lastUsed 不丢项、不改入参', () => {
  // 数据手工推导（createdAt 降序 / lastUsedAt 降序，null 视为 0）：
  //   t_1 createdAt=100 lastUsedAt=500
  //   t_2 createdAt=300 lastUsedAt=null
  //   t_3 createdAt=200 lastUsedAt=900
  const all = [
    makeTemplate({ id: 't_1', createdAt: 100, lastUsedAt: 500 }),
    makeTemplate({ id: 't_2', createdAt: 300, lastUsedAt: null }),
    makeTemplate({ id: 't_3', createdAt: 200, lastUsedAt: 900 })
  ];
  for (const sort of ['created', 'lastUsed']) {
    const out = templateService.filterTemplates(all, { sort });
    assert.strictEqual(out.length, 3, `sort=${sort} 必须返回全部模板`);
    assert.deepStrictEqual(
      out.map((t) => t.id).sort(),
      ['t_1', 't_2', 't_3']
    );
  }
  assert.deepStrictEqual(
    templateService.filterTemplates(all, { sort: 'created' }).map((t) => t.id),
    ['t_2', 't_3', 't_1'],
    'sort=created 必须按 createdAt 降序：300(t_2) -> 200(t_3) -> 100(t_1)'
  );
  assert.deepStrictEqual(
    templateService.filterTemplates(all, { sort: 'lastUsed' }).map((t) => t.id),
    ['t_3', 't_1', 't_2'],
    'sort=lastUsed 必须按 lastUsedAt 降序：900(t_3) -> 500(t_1) -> null(t_2)'
  );
});

test('templateService.findTemplate: 命中返回模板，未命中返回 undefined', () => {
  const all = [makeTemplate({ id: 't_1' }), makeTemplate({ id: 't_2' })];
  assert.strictEqual(templateService.findTemplate(all, 't_2').id, 't_2');
  assert.strictEqual(templateService.findTemplate(all, 'nope'), undefined);
  assert.strictEqual(templateService.findTemplate([], 't_1'), undefined);
});

test('§12-17 duplicateTemplate: 模板/步骤/子步骤全部产生全新 id', () => {
  const src = makeTemplate();
  const copy = templateService.duplicateTemplate(src);

  assert.notStrictEqual(copy.id, src.id, '模板 id 必须全新');
  assert.strictEqual(copy.steps.length, src.steps.length);

  const srcStepIds = src.steps.map((s) => s.id);
  const copyStepIds = copy.steps.map((s) => s.id);
  assert.strictEqual(new Set(copyStepIds).size, copyStepIds.length, '副本步骤 id 不得互相重复');
  for (const id of copyStepIds) {
    assert.strictEqual(srcStepIds.includes(id), false, `步骤 id ${id} 与模板重复`);
  }

  const srcSubIds = src.steps.flatMap((s) => s.subSteps.map((x) => x.id));
  const copySubIds = copy.steps.flatMap((s) => s.subSteps.map((x) => x.id));
  assert.deepStrictEqual(srcSubIds, ['ss_a1']);
  assert.strictEqual(copySubIds.length, srcSubIds.length);
  assert.strictEqual(new Set(copySubIds).size, copySubIds.length, '副本子步骤 id 不得互相重复');
  for (const id of copySubIds) {
    assert.strictEqual(srcSubIds.includes(id), false, `子步骤 id ${id} 与模板重复`);
  }

  assert.notStrictEqual(copy.steps, src.steps);
  assert.notStrictEqual(copy.steps[0].subSteps, src.steps[0].subSteps);
});

test('§12-17 duplicateTemplate: 默认名称追加 " - 副本"，version=1，lastUsedAt=null，favorite 继承', () => {
  const src = makeTemplate({ favorite: true });
  const copy = templateService.duplicateTemplate(src);

  assert.strictEqual(copy.name, 'Literature Review - 副本');
  assert.strictEqual(copy.version, 1, '副本 version 必须重置为 1');
  assert.strictEqual(copy.lastUsedAt, null);
  assert.strictEqual(copy.favorite, true, 'favorite 必须继承');
  assert.strictEqual(copy.desc, src.desc);
  assert.strictEqual(copy.category, src.category);
  assert.deepStrictEqual(copy.tags, src.tags);
  assert.strictEqual(copy.steps[0].title, src.steps[0].title, '步骤内容必须保留');
  assert.strictEqual(copy.steps[0].note, src.steps[0].note);
  assert.strictEqual(copy.steps[0].subSteps[0].title, src.steps[0].subSteps[0].title);
  assert.ok(copy.createdAt > 0);
  assert.ok(copy.updatedAt > 0);
  assert.strictEqual(src.name, 'Literature Review', '原模板不得被修改');
});

test('§12-17 duplicateTemplate: 名称冲突时追加 " (2)" " (3)"', () => {
  const src = makeTemplate();
  const existing = ['Literature Review', 'Literature Review - 副本'];

  const copy2 = templateService.duplicateTemplate(src, { existingNames: existing });
  assert.strictEqual(copy2.name, 'Literature Review - 副本 (2)');

  const copy3 = templateService.duplicateTemplate(src, {
    existingNames: existing.concat(copy2.name)
  });
  assert.strictEqual(copy3.name, 'Literature Review - 副本 (3)');
});

test('§12-17 duplicateTemplate: 自定义 nameSuffix', () => {
  const copy = templateService.duplicateTemplate(makeTemplate(), { nameSuffix: ' (copy)' });
  assert.strictEqual(copy.name, 'Literature Review (copy)');
});

test('§12-17 duplicateTemplate: 连续复制两次得到互不相同的 id', () => {
  const src = makeTemplate();
  const a = templateService.duplicateTemplate(src);
  const b = templateService.duplicateTemplate(src);
  assert.notStrictEqual(a.id, b.id);
  const ids = new Set([a.id, ...a.steps.map((s) => s.id), ...b.steps.map((s) => s.id)]);
  assert.strictEqual(ids.size, 5, 'a/b 的模板 id 与步骤 id 必须互不相同');
});
