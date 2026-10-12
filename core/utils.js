// core/utils.js — 纯工具函数（契约 §4）
// 双环境 UMD 包装（契约 §1.1）：Node require + 浏览器 globalThis.SOPCore
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
  // （契约 §1.1 的字面 dep 片段在浏览器下返回内层 API，与 §1.2 的 camelCase
  // 导出名不符，此处为等价修正，已在报告中说明。）
  function dep(name) {
    if (typeof module === 'object' && module.exports) return require('./' + name + '.js');
    const core = globalThis.SOPCore || {};
    const key = name.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
    const ns = {};
    ns[key] = core[key];
    return ns;
  }

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  let idCounter = 0;

  /**
   * genId(prefix) -> string
   * prefix + base36 时间戳 + 随机串（+ 进程内自增，保证同毫秒不重复）
   */
  function genId(prefix) {
    const p = typeof prefix === 'string' && prefix.trim() ? prefix.trim().replace(/_+$/, '') : 'id';
    idCounter = (idCounter + 1) % 46656;
    return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + idCounter.toString(36);
  }

  /**
   * escHtml(str) -> string
   * 纯字符串实现（禁止 DOM），转义 & < > " ' 五个字符。
   * 注意：& 必须最先替换，否则会二次转义。
   */
  function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, function (ch) {
      return HTML_ESCAPES[ch];
    });
  }

  /**
   * escAttr(str) -> string
   * 属性值转义；与 escHtml 同为安全超集（含引号）。
   */
  function escAttr(str) {
    return escHtml(str);
  }

  /** formatDate(ts) -> "3/14" */
  function formatDate(ts) {
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return '';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /** formatDateTime(ts) -> "2026-03-14 09:05" */
  function formatDateTime(ts) {
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return '';
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** formatDuration(ms) -> "45 分钟" / "2 小时 5 分钟" */
  function formatDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '0 分钟';
    const totalMins = Math.floor(n / 60000);
    if (totalMins < 60) return totalMins + ' 分钟';
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return mins > 0 ? hours + ' 小时 ' + mins + ' 分钟' : hours + ' 小时';
  }

  /**
   * replaceVars(text, vars) -> string
   * {{k}} -> vars[k]；k 不存在或值为 null/undefined 时保留原样 {{k}}。
   */
  function replaceVars(text, vars) {
    if (typeof text !== 'string') return text === null || text === undefined ? '' : String(text);
    if (!vars || typeof vars !== 'object') return text;
    return text.replace(/\{\{(.+?)\}\}/g, function (full, key) {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return full;
      const v = vars[key];
      return v === undefined || v === null ? full : String(v);
    });
  }

  /** highlightVariables(text) -> string  把 {{k}} 包成 span（入参应已 escHtml） */
  function highlightVariables(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/\{\{(.+?)\}\}/g, '<span class="variable-value">{{$1}}</span>');
  }

  /** extractVariables(...texts) -> string[]  去重、按首次出现顺序 */
  function extractVariables() {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < arguments.length; i += 1) {
      const text = arguments[i];
      if (typeof text !== 'string' || text.indexOf('{{') === -1) continue;
      const re = /\{\{(.+?)\}\}/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const key = m[1];
        if (!key || !key.trim()) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
    }
    return out;
  }

  /** debounce(fn, ms) -> function（附 .cancel） */
  function debounce(fn, ms) {
    let timer = null;
    const wait = Number.isFinite(Number(ms)) ? Number(ms) : 0;
    function debounced() {
      const ctx = this;
      const args = Array.prototype.slice.call(arguments);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (typeof fn === 'function') fn.apply(ctx, args);
      }, wait);
    }
    debounced.cancel = function () {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return debounced;
  }

  /** clamp(n, min, max) -> number */
  function clamp(n, min, max) {
    const v = Number(n);
    let lo = Number(min);
    let hi = Number(max);
    if (!Number.isFinite(lo)) lo = -Infinity;
    if (!Number.isFinite(hi)) hi = Infinity;
    if (lo > hi) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    if (!Number.isFinite(v)) return lo === -Infinity ? 0 : lo;
    return Math.min(hi, Math.max(lo, v));
  }

  /**
   * deepClone(obj) -> obj
   * 结构化克隆：数组/普通对象/Date 递归复制，禁止引用共享。
   */
  function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      const arr = new Array(value.length);
      for (let i = 0; i < value.length; i += 1) arr[i] = deepClone(value[i]);
      return arr;
    }
    if (value instanceof Date) return new Date(value.getTime());
    const out = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) {
      // 保留 JSON 的自有 __proto__ 键，不能触发 Object.prototype 上的 setter。
      Object.defineProperty(out, keys[i], {
        value: deepClone(value[keys[i]]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  return {
    utils: {
      genId: genId,
      escHtml: escHtml,
      escAttr: escAttr,
      formatDate: formatDate,
      formatDateTime: formatDateTime,
      formatDuration: formatDuration,
      replaceVars: replaceVars,
      highlightVariables: highlightVariables,
      extractVariables: extractVariables,
      debounce: debounce,
      clamp: clamp,
      deepClone: deepClone,
    },
  };
});
