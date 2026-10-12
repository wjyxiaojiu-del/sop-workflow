// core/template-service.js — 模板服务（契约 §5）
// 纯函数 + 不可变风格（返回新对象，不修改入参）
// 双环境 UMD 包装（契约 §1.1）
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.SOPCore = root.SOPCore || {};
    Object.assign(root.SOPCore, mod);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 跨模块依赖：Node 用 require，浏览器用全局命名空间。
  // 两种环境都返回 { <camelName>: API } 命名空间，保证调用点 dep('x').x 一致。
  function dep(name) {
    if (typeof module === 'object' && module.exports) return require('./' + name + '.js');
    const core = globalThis.SOPCore || {};
    const key = name.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
    const ns = {};
    ns[key] = core[key];
    return ns;
  }

  const utils = dep('utils').utils;

  const CATEGORIES = ['科研', '学习', '开发', '生活', '其他'];
  const DEFAULT_CATEGORY = '其他';
  const MAX_TAGS = 20;

  function toArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function nowOr(now) {
    return Number.isFinite(Number(now)) ? Number(now) : Date.now();
  }

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function normalizeCategory(category) {
    return CATEGORIES.indexOf(category) === -1 ? DEFAULT_CATEGORY : category;
  }

  /**
   * normalizeTags(input) -> string[]
   * 只接受数组或逗号/中文逗号分隔字符串；其他类型（数字/布尔/对象）返回 []。
   */
  function normalizeTags(input) {
    let parts = [];
    if (Array.isArray(input)) {
      parts = input;
    } else if (typeof input === 'string') {
      parts = input.split(/[,，]/);
    } else {
      return [];
    }

    const seen = new Set();
    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
      const tag = str(parts[i]).trim();
      if (!tag) continue;
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }

  /** 把任意形态的 step 规整成契约 §2.3 的 Step（生成缺失 id，迁移字符串 subSteps） */
  function normalizeStep(step) {
    const s = step && typeof step === 'object' ? step : {};
    const subs = toArray(s.subSteps).map(function (sub) {
      if (sub && typeof sub === 'object') {
        return {
          id: sub.id ? str(sub.id) : utils.genId('ss'),
          title: str(sub.title),
          done: sub.done === true,
        };
      }
      // 兼容旧格式：subSteps: ["记录 DOI"]
      return { id: utils.genId('ss'), title: str(sub), done: false };
    });
    return {
      id: s.id ? str(s.id) : utils.genId('s'),
      title: str(s.title),
      note: str(s.note),
      done: s.done === true,
      subSteps: subs,
    };
  }

  function normalizeSteps(steps) {
    return toArray(steps).map(normalizeStep);
  }

  /**
   * createTemplate({ name, desc, category, tags, steps }, now?) -> Template
   * now 为可选注入（便于测试）；不传则 Date.now()。
   */
  function createTemplate(input, now) {
    const src = input && typeof input === 'object' ? input : {};
    const ts = nowOr(now);
    return {
      id: src.id ? str(src.id) : utils.genId('t'),
      name: str(src.name),
      desc: str(src.desc),
      category: normalizeCategory(src.category),
      tags: normalizeTags(src.tags),
      favorite: src.favorite === true,
      version: 1,
      steps: normalizeSteps(src.steps),
      createdAt: ts,
      updatedAt: ts,
      lastUsedAt: null,
    };
  }

  /**
   * updateTemplate(template, patch, now?) -> Template
   * version + 1，updatedAt = now；返回新对象，不修改入参。
   */
  function updateTemplate(template, patch, now) {
    const base = template && typeof template === 'object' ? template : {};
    const p = patch && typeof patch === 'object' ? patch : {};
    const ts = nowOr(now);

    const next = {};
    const keys = Object.keys(base);
    for (let i = 0; i < keys.length; i += 1) next[keys[i]] = base[keys[i]];

    if (Object.prototype.hasOwnProperty.call(p, 'name')) next.name = str(p.name);
    if (Object.prototype.hasOwnProperty.call(p, 'desc')) next.desc = str(p.desc);
    if (Object.prototype.hasOwnProperty.call(p, 'category')) next.category = normalizeCategory(p.category);
    if (Object.prototype.hasOwnProperty.call(p, 'tags')) next.tags = normalizeTags(p.tags);
    if (Object.prototype.hasOwnProperty.call(p, 'favorite')) next.favorite = p.favorite === true;
    if (Object.prototype.hasOwnProperty.call(p, 'steps')) next.steps = normalizeSteps(p.steps);

    next.version = (Number.isFinite(Number(base.version)) ? Number(base.version) : 1) + 1;
    next.updatedAt = ts;
    return next;
  }

  /**
   * duplicateTemplate(template, { nameSuffix = ' - 副本', existingNames }, now?) -> Template
   * 新 id、新步骤 id、新子步骤 id、version=1、createdAt/updatedAt=now、
   * lastUsedAt=null、favorite 继承；name 冲突时追加 " (2)" " (3)" ...
   * 未传 existingNames 时只做一次 nameSuffix。
   */
  function duplicateTemplate(template, options, now) {
    const base = template && typeof template === 'object' ? template : {};
    const opts = options && typeof options === 'object' ? options : {};
    const suffix = typeof opts.nameSuffix === 'string' ? opts.nameSuffix : ' - 副本';
    const existingNames = Array.isArray(opts.existingNames) ? opts.existingNames : null;
    const ts = nowOr(now);

    const baseName = str(base.name) + suffix;
    let name = baseName;

    if (existingNames) {
      const taken = new Set(existingNames.map(function (n) { return str(n); }));
      if (taken.has(name)) {
        let counter = 2;
        while (taken.has(baseName + ' (' + counter + ')')) counter += 1;
        name = baseName + ' (' + counter + ')';
      }
    }

    return {
      id: utils.genId('t'),
      name: name,
      desc: str(base.desc),
      category: normalizeCategory(base.category),
      tags: normalizeTags(base.tags),
      favorite: base.favorite === true,
      version: 1,
      steps: toArray(base.steps).map(function (step) {
        const s = step && typeof step === 'object' ? step : {};
        return {
          id: utils.genId('s'),
          title: str(s.title),
          note: str(s.note),
          done: false,
          subSteps: toArray(s.subSteps).map(function (sub) {
            const ss = sub && typeof sub === 'object' ? sub : { title: sub };
            return {
              id: utils.genId('ss'),
              title: str(ss.title),
              done: false,
            };
          }),
        };
      }),
      createdAt: ts,
      updatedAt: ts,
      lastUsedAt: null,
    };
  }

  /** templateMatchesQuery(template, query) -> boolean（全部大小写不敏感） */
  function templateMatchesQuery(template, query) {
    const q = str(query).trim().toLowerCase();
    if (!q) return true;
    const t = template && typeof template === 'object' ? template : {};

    const haystack = [
      str(t.name),
      str(t.desc),
      toArray(t.tags).map(str).join(' '),
      str(t.category),
    ];

    toArray(t.steps).forEach(function (step) {
      const s = step && typeof step === 'object' ? step : {};
      haystack.push(str(s.title));
      haystack.push(str(s.note));
      toArray(s.subSteps).forEach(function (sub) {
        haystack.push(sub && typeof sub === 'object' ? str(sub.title) : str(sub));
      });
    });

    return haystack.join('\n').toLowerCase().indexOf(q) !== -1;
  }

  function sortValue(template, key) {
    const v = template ? template[key] : null;
    return Number.isFinite(Number(v)) ? Number(v) : -1;
  }

  /**
   * filterTemplates(templates, { query, category, favoriteOnly, sort }) -> Template[]
   * sort: 'recent'(updatedAt) | 'created'(createdAt) | 'name' | 'lastUsed'(lastUsedAt)
   */
  function filterTemplates(templates, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const query = opts.query;
    const category = str(opts.category);
    const favoriteOnly = opts.favoriteOnly === true;
    const sort = typeof opts.sort === 'string' && opts.sort ? opts.sort : 'recent';

    let out = toArray(templates).filter(function (t) {
      const tpl = t && typeof t === 'object' ? t : {};
      if (category && normalizeCategory(tpl.category) !== category) return false;
      if (favoriteOnly && tpl.favorite !== true) return false;
      return templateMatchesQuery(tpl, query);
    });

    out = out.slice();
    if (sort === 'name') {
      out.sort(function (a, b) { return str(a.name).localeCompare(str(b.name), 'zh-Hans-CN'); });
    } else if (sort === 'created') {
      out.sort(function (a, b) { return sortValue(b, 'createdAt') - sortValue(a, 'createdAt'); });
    } else if (sort === 'lastUsed') {
      out.sort(function (a, b) { return sortValue(b, 'lastUsedAt') - sortValue(a, 'lastUsedAt'); });
    } else {
      out.sort(function (a, b) { return sortValue(b, 'updatedAt') - sortValue(a, 'updatedAt'); });
    }
    return out;
  }

  /** findTemplate(templates, id) -> Template | undefined */
  function findTemplate(templates, id) {
    const target = str(id);
    if (!target) return undefined;
    return toArray(templates).find(function (t) {
      return t && str(t.id) === target;
    });
  }

  /**
   * buildSnapshotSteps(template, variables) -> Step[]
   * 深拷贝 + replaceVars，供 instance-service 使用（契约 §2.4 快照不变量）。
   */
  function buildSnapshotSteps(template, variables) {
    const t = template && typeof template === 'object' ? template : {};
    const vars = variables && typeof variables === 'object' ? variables : {};
    return toArray(t.steps).map(function (step) {
      const s = step && typeof step === 'object' ? step : {};
      return {
        id: s.id ? str(s.id) : utils.genId('s'),
        title: utils.replaceVars(str(s.title), vars),
        note: utils.replaceVars(str(s.note), vars),
        done: false,
        subSteps: toArray(s.subSteps).map(function (sub) {
          const ss = sub && typeof sub === 'object' ? sub : { title: sub };
          return {
            id: ss.id ? str(ss.id) : utils.genId('ss'),
            title: utils.replaceVars(str(ss.title), vars),
            done: false,
          };
        }),
      };
    });
  }

  return {
    templateService: {
      createTemplate: createTemplate,
      updateTemplate: updateTemplate,
      duplicateTemplate: duplicateTemplate,
      normalizeTags: normalizeTags,
      templateMatchesQuery: templateMatchesQuery,
      filterTemplates: filterTemplates,
      findTemplate: findTemplate,
      buildSnapshotSteps: buildSnapshotSteps,
      CATEGORIES: CATEGORIES,
    },
  };
});
