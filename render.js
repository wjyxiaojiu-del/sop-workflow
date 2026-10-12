// render.js — SOP 工作流 v1.1 渲染层（契约 docs/contracts/v1.1-interface.md §10）
//
// IRON RULES
//  - 只做渲染：不改数据、不发 IPC（§10）。事件绑定与数据写入全部在 renderer.js。
//  - 所有进度必须调 SOPCore.progress.calculateProgress(instance)（§3.3），本文件不自行算比例。
//  - 所有用户输入进 HTML 前必须经 utils.escHtml / utils.escAttr（§8.3）。
//  - 模块顶层不得访问 document / window / SOPCore，只在函数体内惰性取用（§10 验收：可被 Node require）。
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.SOPRender = mod.SOPRender;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- core 惰性取用

  function coreNs() {
    return typeof globalThis !== 'undefined' && globalThis.SOPCore ? globalThis.SOPCore : null;
  }

  function U() {
    const c = coreNs();
    if (!c || !c.utils) throw new Error('SOPRender 需要 SOPCore.utils（契约 §1.2 全局命名空间）');
    return c.utils;
  }

  function P() {
    const c = coreNs();
    if (!c || !c.progress) throw new Error('SOPRender 需要 SOPCore.progress（契约 §3.3）');
    return c.progress;
  }

  function T() {
    const c = coreNs();
    if (!c || !c.templateService) throw new Error('SOPRender 需要 SOPCore.templateService（契约 §1.2）');
    return c.templateService;
  }

  function I() {
    const c = coreNs();
    if (!c || !c.instanceService) throw new Error('SOPRender 需要 SOPCore.instanceService（契约 §1.2）');
    return c.instanceService;
  }

  function esc(v) { return U().escHtml(v); }
  function escA(v) { return U().escAttr(v); }
  function hl(v) { return U().highlightVariables(v); }
  function fDate(ts) { return U().formatDate(ts); }
  function fDateTime(ts) { return U().formatDateTime(ts); }
  function fDuration(ms) { return U().formatDuration(ms); }

  function toArray(v) { return Array.isArray(v) ? v : []; }
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function el(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------- 图标（内联 SVG，颜色继承 currentColor）

  const ICON = {
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    sub: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    rate: '<path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/>',
    history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    up: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    down: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  };

  function svg(path, size, extra) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true"' + (extra ? ' ' + extra : '') + '>' + path + '</svg>';
  }

  // ---------------------------------------------------------------- 状态徽章（§9.4 / §9.7 / §9.8）

  // IRON RULE §9.8：状态不得只靠颜色表达 —— 每个徽章同时含图标 + 中文文字 + 状态色。
  const STATUS_META = {
    running: { label: '执行中', cls: 'status-running', icon: ICON.play, stroke: 2.5 },
    paused: { label: '已暂停', cls: 'status-paused', icon: ICON.pause, stroke: 2 },
    completed: { label: '已完成', cls: 'status-completed', icon: ICON.check, stroke: 2.5 },
    abandoned: { label: '已放弃', cls: 'status-abandoned', icon: ICON.close, stroke: 2 },
    error: { label: '出错', cls: 'status-error', icon: ICON.warn, stroke: 2 },
  };

  /**
   * statusBadge(status) -> HTML 字符串
   * 返回 <span class="status-badge status-<s>">[图标][文字]</span>，
   * 供 renderer.js 直接写入 #instance-status-badge 槽位。
   */
  function statusBadge(status) {
    const key = str(status);
    const meta = STATUS_META[key] || {
      label: key ? key : '未知状态',
      cls: 'status-abandoned',
      icon: ICON.warn,
      stroke: 2,
    };
    const icon = '<svg class="status-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="' + meta.stroke + '" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + meta.icon + '</svg>';
    return '<span class="status-badge ' + meta.cls + '" title="状态：' + escA(meta.label) + '">' +
      icon + '<span class="status-text">' + esc(meta.label) + '</span></span>';
  }

  // ---------------------------------------------------------------- toast（§9.7）

  const TOAST_TTL = 3600;

  /**
   * toast(message, type)  type: 'success' | 'error' | 'info'
   * 非阻塞提示，写入 #toast-container，到期自动淡出移除。
   */
  function toast(message, type) {
    const container = el('toast-container');
    if (!container) return;
    const kind = type === 'error' || type === 'success' ? type : 'info';
    const iconPath = kind === 'error' ? ICON.warn : (kind === 'success' ? ICON.check : ICON.info);
    const node = document.createElement('div');
    node.className = 'toast toast-' + kind;
    node.setAttribute('role', 'status');
    node.innerHTML = '<svg class="toast-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + iconPath + '</svg>' +
      '<span class="toast-text">' + esc(message) + '</span>';
    container.appendChild(node);
    const remove = function () {
      node.style.transition = 'opacity 0.2s, transform 0.2s';
      node.style.opacity = '0';
      node.style.transform = 'translateX(16px)';
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    };
    setTimeout(remove, TOAST_TTL);
    node.addEventListener('click', remove);
  }

  // ---------------------------------------------------------------- 空状态（§9.2；文案必须说明下一步操作）

  const EMPTY_TEMPLATES =
    '<div class="empty-state" id="templates-empty">' +
    '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.2" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="13" y2="13"/></svg>' +
    '<p>还没有 SOP，先创建一个模板</p>' +
    '<p class="empty-hint">点击上方「新建模板」从零开始，或用「导入」恢复已有的 SOP 数据</p>' +
    '</div>';

  const EMPTY_QUERY =
    '<div class="empty-state" id="templates-empty-query">' +
    '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.2" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
    '<p>没有匹配「<span id="empty-query-text"></span>」的模板</p>' +
    '<p class="empty-hint">换个关键词，或清空搜索与筛选条件后再试</p>' +
    '<button class="btn-primary" id="btn-empty-new-template" type="button">' +
    svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', 14, 'stroke-width="2.5"') +
    '新建模板</button>' +
    '</div>';

  const EMPTY_INSTANCES =
    '<div class="empty-state" id="instances-empty">' +
    '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.2" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
    '<p>没有正在执行的 SOP</p>' +
    '<p class="empty-hint">回到「模板库」，选择一个模板点击「开始执行」</p>' +
    '</div>';

  const EMPTY_HISTORY =
    '<div class="empty-state" id="history-empty">' +
    '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.2" aria-hidden="true">' +
    '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>' +
    '<p>暂无历史记录</p>' +
    '<p class="empty-hint">完成或放弃一次 SOP 执行后，记录会保留在这里</p>' +
    '</div>';

  function dashEmpty(id, title, hint) {
    return '<div class="empty-state empty-state-compact" id="' + id + '">' +
      '<p>' + title + '</p><p class="empty-hint">' + hint + '</p></div>';
  }

  const EMPTY_DASH_RUNNING = dashEmpty(
    'dash-running-empty',
    '没有正在执行的 SOP',
    '在下方「全部模板」中选一个模板，点击「开始执行」即可'
  );
  const EMPTY_DASH_RECENT = dashEmpty(
    'dash-recent-empty',
    '还没有收藏或最近使用的模板',
    '在模板详情里点「收藏」，或直接开始执行一次，模板就会出现在这里'
  );
  const EMPTY_DASH_HISTORY = dashEmpty(
    'dash-history-empty',
    '还没有完成记录',
    '完成或放弃一次执行后，记录会出现在这里'
  );

  // ---------------------------------------------------------------- 卡片片段

  function progressBarHTML(percent, label) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    return '<div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" ' +
      'aria-valuenow="' + p + '"' + (label ? ' aria-label="' + escA(label) + '"' : '') + '>' +
      '<div class="progress-fill" style="width:' + p + '%"></div></div>';
  }

  /** 模板卡片（首页「全部模板」/「收藏·最近使用」共用） */
  function templateCard(t) {
    const steps = toArray(t.steps);
    const subCount = steps.reduce(function (n, s) {
      return n + toArray(s && s.subSteps).length;
    }, 0);
    const tags = toArray(t.tags);

    const meta = [];
    meta.push('<span>' + svg(ICON.list, 14) + esc(steps.length) + ' 个步骤</span>');
    if (subCount > 0) meta.push('<span>' + svg(ICON.sub, 14) + esc(subCount) + ' 个子步骤</span>');
    meta.push('<span>' + svg(ICON.tag, 14) + esc(t.category || '其他') + '</span>');
    meta.push('<span>' + svg(ICON.clock, 14) + esc(fDate(t.updatedAt)) + '</span>');
    if (t.favorite === true) {
      meta.push('<span title="已收藏">' + svg(ICON.star, 14, 'fill="var(--warning)" stroke="var(--warning)"') + '已收藏</span>');
    }
    if (tags.length > 0) {
      meta.push('<span title="' + escA(tags.join('、')) + '">' + svg(ICON.tag, 14) + esc(tags.slice(0, 3).join('、')) + '</span>');
    }

    return '<div class="template-card" data-id="' + escA(t.id) + '" tabindex="0" role="button" ' +
      'aria-label="打开模板 ' + escA(t.name) + '">' +
      '<div class="template-card-icon">' + svg(ICON.doc, 20) + '</div>' +
      '<h3>' + esc(t.name) + '</h3>' +
      '<p>' + esc(t.desc || '暂无描述') + '</p>' +
      '<div class="template-card-meta">' + meta.join('') + '</div>' +
      '</div>';
  }

  /** 执行中卡片：模板名 / 状态 / 当前进度 / 开始时间 / 上次更新时间 / 继续执行 */
  function instanceCard(inst) {
    const p = P().calculateProgress(inst); // IRON RULE §3.3
    return '<div class="instance-card" data-id="' + escA(inst.id) + '">' +
      '<div class="instance-card-header">' +
      '<h3>' + esc(inst.templateName || '未命名模板') + '</h3>' +
      '<span class="instance-card-time">开始于 ' + esc(fDateTime(inst.startedAt)) + '</span>' +
      '</div>' +
      '<div class="instance-card-header">' +
      statusBadge(inst.status) +
      '<span class="instance-card-time">更新于 ' + esc(fDateTime(inst.updatedAt)) + '</span>' +
      '</div>' +
      progressBarHTML(p.percent, '执行进度') +
      '<div class="progress-text"><span>' + esc(p.done) + ' / ' + esc(p.total) + ' 项完成</span>' +
      '<span>' + esc(p.percent) + '%</span></div>' +
      '<div class="instance-card-actions">' +
      '<button class="btn-secondary btn-continue-instance" data-id="' + escA(inst.id) + '" type="button">' +
      svg(ICON.play, 14) + '继续执行</button>' +
      '</div>' +
      '</div>';
  }

  /** 历史卡片：模板名 / 状态 / 步骤 / 完成率 / 完成时间 / 耗时 */
  function historyCard(h) {
    const abandoned = str(h.status) === 'abandoned';
    const accent = abandoned ? ' style="border-left-color:var(--status-abandoned)"' : '';
    return '<div class="history-card"' + accent + '>' +
      '<div class="history-card-header">' +
      '<h3>' + esc(h.templateName || '未命名模板') + '</h3>' +
      statusBadge(h.status) +
      '</div>' +
      '<div class="history-card-meta">' +
      '<span>' + svg(ICON.list, 14) + esc(h.stepsDone) + '/' + esc(h.stepsTotal) + ' 步骤</span>' +
      '<span>' + svg(ICON.rate, 14) + '完成率 ' + esc(h.completionRate) + '%</span>' +
      '<span>' + svg(ICON.clock, 14) + esc(fDateTime(h.completedAt)) + '</span>' +
      '<span>' + svg(ICON.history, 14) + '耗时 ' + esc(fDuration(h.elapsedMs)) + '</span>' +
      '</div>' +
      '</div>';
  }

  // ---------------------------------------------------------------- §10 导出函数

  /** renderTemplates(state) —— 「全部模板」网格 + 两种空状态（§9.2） */
  function renderTemplates(state) {
    const grid = el('template-grid');
    if (!grid) return;
    const data = (state && state.data) || {};
    const all = toArray(data.templates);

    if (all.length === 0) {
      grid.innerHTML = EMPTY_TEMPLATES;
      return;
    }

    const list = T().filterTemplates(all, {
      query: state.query,
      category: state.category,
      favoriteOnly: state.favoriteOnly,
      sort: state.sort,
    });

    if (list.length === 0) {
      grid.innerHTML = EMPTY_QUERY;
      const label = el('empty-query-text');
      if (label) {
        label.textContent = state.query
          ? str(state.query)
          : (state.category ? str(state.category) : (state.favoriteOnly ? '收藏' : '当前筛选'));
      }
      return;
    }

    grid.innerHTML = list.map(templateCard).join('');
  }

  /** renderInstances(state) —— 「执行中」列表（running + paused） */
  function renderInstances(state) {
    const list = el('instances-list');
    if (!list) return;
    const data = (state && state.data) || {};
    const active = I().sortInstances(toArray(data.instances).filter(function (i) {
      return I().isActive(i);
    }));

    if (active.length === 0) {
      list.innerHTML = EMPTY_INSTANCES;
      return;
    }
    list.innerHTML = active.map(instanceCard).join('');
  }

  /** renderHistory(state) —— 「历史记录」列表（按 completedAt 降序，由 data-store 保证） */
  function renderHistory(state) {
    const list = el('history-list');
    if (!list) return;
    const data = (state && state.data) || {};
    const items = toArray(data.history);
    if (items.length === 0) {
      list.innerHTML = EMPTY_HISTORY;
      return;
    }
    list.innerHTML = items.map(historyCard).join('');
  }

  /** renderDashboard(state) —— 首页四个分区（§9.2：正在执行 / 收藏·最近使用 / 全部模板 / 最近完成） */
  function renderDashboard(state) {
    const data = (state && state.data) || {};
    const templates = toArray(data.templates);
    const instances = toArray(data.instances);
    const history = toArray(data.history);

    // 1) 正在执行
    const runningBox = el('dash-running-list');
    if (runningBox) {
      const active = I().sortInstances(instances.filter(function (i) { return I().isActive(i); }));
      runningBox.innerHTML = active.length === 0 ? EMPTY_DASH_RUNNING : active.map(instanceCard).join('');
    }

    // 2) 收藏 / 最近使用
    const recentBox = el('dash-recent-list');
    if (recentBox) {
      const picked = [];
      const seen = {};
      templates.forEach(function (t) {
        if (t && t.favorite === true && !seen[t.id]) { seen[t.id] = true; picked.push(t); }
      });
      templates.slice().sort(function (a, b) {
        return (Number(b && b.lastUsedAt) || 0) - (Number(a && a.lastUsedAt) || 0);
      }).forEach(function (t) {
        if (t && Number(t.lastUsedAt) > 0 && !seen[t.id]) { seen[t.id] = true; picked.push(t); }
      });
      const top = picked.slice(0, 6);
      recentBox.innerHTML = top.length === 0 ? EMPTY_DASH_RECENT : top.map(templateCard).join('');
    }

    // 3) 全部模板（含筛选与两种空状态）
    renderTemplates(state);

    // 4) 最近完成记录
    const historyBox = el('dash-history-list');
    if (historyBox) {
      const top = history.slice(0, 5);
      historyBox.innerHTML = top.length === 0 ? EMPTY_DASH_HISTORY : top.map(historyCard).join('');
    }
  }

  /** renderTemplateDetail(state) —— 模板详情（list / flow）+ 视图切换与收藏态同步 */
  function renderTemplateDetail(state) {
    const box = el('template-detail');
    if (!box) return;
    const data = (state && state.data) || {};
    const mode = state && state.detailViewMode === 'flow' ? 'flow' : 'list';

    syncToggle('#detail-view-toggle', mode);

    const t = state && state.currentTemplateId
      ? T().findTemplate(toArray(data.templates), state.currentTemplateId)
      : null;

    if (!t) {
      box.innerHTML = '<h2>模板不存在</h2><p class="desc">该模板可能已被删除，请返回模板库重新选择。</p>';
      setFavoriteButton(false, false);
      setDisabled('btn-start-instance', true);
      return;
    }

    setFavoriteButton(t.favorite === true, true);
    setDisabled('btn-start-instance', toArray(t.steps).length === 0);

    if (mode === 'flow') {
      box.innerHTML = renderFlowchart(t.steps, t.name, t.desc, {});
      return;
    }

    const tags = toArray(t.tags);
    const meta = ['分类：' + esc(t.category || '其他')];
    if (tags.length > 0) meta.push('标签：' + esc(tags.join('、')));
    meta.push('版本 v' + esc(t.version));
    meta.push('更新于 ' + esc(fDateTime(t.updatedAt)));

    const stepsHTML = toArray(t.steps).map(function (s, i) {
      const subs = toArray(s.subSteps);
      return '<li class="step-item">' +
        '<span class="step-number">' + (i + 1) + '</span>' +
        '<div class="step-content">' +
        '<div class="step-title">' + hl(esc(s.title)) + '</div>' +
        (s.note ? '<div class="step-note">' + hl(esc(s.note)) + '</div>' : '') +
        (subs.length > 0
          ? '<div class="step-sub-steps">' + subs.map(function (ss) {
            return '<div class="sub-step">' + hl(esc(ss && ss.title)) + '</div>';
          }).join('') + '</div>'
          : '') +
        '</div></li>';
    }).join('');

    box.innerHTML =
      '<h2>' + esc(t.name) + '</h2>' +
      '<p class="desc">' + esc(t.desc || '暂无描述') + '</p>' +
      '<div class="template-detail-meta">' + meta.join(' · ') + '</div>' +
      (toArray(t.steps).length > 0
        ? '<ol class="step-list">' + stepsHTML + '</ol>'
        : '<p class="desc">这个模板还没有步骤，点「编辑」添加第一步。</p>');
  }

  /** renderInstanceDetail(state) —— 执行详情：状态徽章 / 进度 / 清单或流程图 / 备注 / 按钮可用性 */
  function renderInstanceDetail(state) {
    const data = (state && state.data) || {};
    const inst = state && state.currentInstanceId
      ? toArray(data.instances).filter(function (x) { return x && x.id === state.currentInstanceId; })[0]
      : null;

    const badge = el('instance-status-badge');
    const heading = el('instance-template-name');
    if (heading) heading.textContent = inst ? str(inst.templateName || '未命名模板') : '执行记录不存在';
    const mode = state && state.instanceViewMode === 'flow' ? 'flow' : 'checklist';
    syncToggle('#instance-mode-toggle', mode);

    if (!inst) {
      if (badge) badge.innerHTML = statusBadge('abandoned');
      setDisabled('btn-pause-instance', true);
      setDisabled('btn-resume-instance', true);
      setDisabled('btn-finish-instance', true);
      setDisabled('btn-abandon-instance', true);
      const cl = el('instance-checklist');
      if (cl) cl.innerHTML = '<p class="step-note">该执行记录不存在或已归档，请返回列表重新选择。</p>';
      return;
    }

    // 状态徽章（文字 + 图标 + 颜色）
    if (badge) badge.innerHTML = statusBadge(inst.status);

    // 进度（IRON RULE §3.3：只能调 calculateProgress）
    const p = P().calculateProgress(inst);
    const fill = el('instance-progress-fill');
    if (fill) fill.style.width = p.percent + '%';
    const bar = fill && fill.parentNode;
    if (bar && bar.setAttribute) bar.setAttribute('aria-valuenow', String(p.percent));
    const text = el('instance-progress-text');
    if (text) {
      text.textContent = p.done + ' / ' + p.total + '（' + p.percent + '%）' +
        ' · 耗时 ' + fDuration(P().getElapsedMs(inst));
    }

    // 清单 / 流程图
    const checklist = el('instance-checklist');
    if (checklist) {
      const focused = document.activeElement;
      const sameInstance = checklist.getAttribute('data-instance-id') === str(inst.id);
      const stepIndex = sameInstance && checklist.contains(focused) ? focused.getAttribute('data-step-index') : null;
      const subIndex = stepIndex !== null ? focused.getAttribute('data-sub-index') : null;
      checklist.setAttribute('data-instance-id', str(inst.id));
      checklist.innerHTML = mode === 'flow'
        ? renderFlowchart(inst.steps, '', '', { isInstance: true, instance: inst })
        : renderChecklist(inst);
      if (stepIndex !== null) {
        // 仅恢复重绘前仍在清单上的焦点；用户已切到备注等控件时不抢焦点。
        const items = checklist.querySelectorAll('[data-step-index]');
        for (let i = 0; i < items.length; i += 1) {
          if (items[i].getAttribute('data-step-index') === stepIndex &&
              items[i].getAttribute('data-sub-index') === subIndex) {
            items[i].focus({ preventScroll: true });
            break;
          }
        }
      }
    }

    // 备注框复用时绑定实例 id；切换实例必须换值，同一实例输入中则保留光标。
    const notes = el('instance-exec-notes');
    if (notes) {
      const sameInstance = notes.getAttribute('data-instance-id') === str(inst.id);
      if ((!sameInstance || document.activeElement !== notes) && notes.value !== str(inst.executionNotes)) {
        notes.value = str(inst.executionNotes);
      }
      notes.setAttribute('data-instance-id', str(inst.id));
    }

    // 按钮可用性（运行中 → 只能暂停；暂停中 → 只能继续；非活动态全部禁用）
    const running = str(inst.status) === 'running';
    const paused = str(inst.status) === 'paused';
    setDisabled('btn-pause-instance', !running);
    setDisabled('btn-resume-instance', !paused);
    setDisabled('btn-finish-instance', !(running || paused));
    setDisabled('btn-abandon-instance', !(running || paused));
  }

  /**
   * renderFlowchart(steps, title, desc, opts) -> HTML 字符串
   * opts: { isInstance?: boolean, instance?: Instance }
   * isInstance 时节点可交互：带 data-step-index、role=checkbox、aria-checked。
   */
  function renderFlowchart(steps, title, desc, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const isInstance = o.isInstance === true;
    const list = toArray(steps);
    const startLabel = isInstance ? '开始执行' : '开始';
    const endLabel = isInstance ? '执行完成' : '结束';

    let nodes = '';
    list.forEach(function (s, i) {
      const step = s && typeof s === 'object' ? s : { title: s };
      const subs = toArray(step.subSteps);
      const done = P().isStepComplete(step);
      const attrs = isInstance
        ? ' class="flow-node executable' + (done ? ' done' : '') + '" data-step-index="' + i + '"' +
          ' tabindex="0" role="checkbox" aria-checked="' + (done ? 'true' : 'false') + '"' +
          ' aria-label="步骤 ' + (i + 1) + '：' + escA(step.title) + (done ? '（已完成）' : '') + '"'
        : ' class="flow-node"';

      nodes += '<div' + attrs + '>' +
        (isInstance
          ? '<div class="flow-check">' + svg(ICON.check, 14, 'stroke-width="3"') + '</div>'
          : '') +
        '<div class="flow-node-header">' +
        '<span class="flow-node-num">' + (i + 1) + '</span>' +
        '<span class="flow-node-title">' + hl(esc(step.title)) + '</span>' +
        '</div>' +
        (step.note ? '<div class="flow-node-note">' + hl(esc(step.note)) + '</div>' : '') +
        (subs.length > 0
          ? '<div class="flow-node-substeps">' + subs.map(function (ss) {
            const sub = ss && typeof ss === 'object' ? ss : { title: ss };
            return '<div class="flow-node-sub">' + hl(esc(sub.title)) + '</div>';
          }).join('') + '</div>'
          : '') +
        '</div>';

      if (i < list.length - 1) {
        nodes += '<div class="flow-connector"><div class="flow-connector-line"></div>' +
          '<div class="flow-connector-dot"></div><div class="flow-connector-line"></div></div>';
      }
    });

    return '<div class="flowchart-container"><div class="flowchart">' +
      (title ? '<div class="flow-title">' + esc(title) + '</div>' : '') +
      (desc ? '<div class="flow-desc">' + esc(desc) + '</div>' : '') +
      '<div class="flow-start">' + startLabel + '</div>' +
      '<div class="flow-arrow"><div class="flow-arrow-line"></div></div>' +
      nodes +
      '<div class="flow-arrow"><div class="flow-arrow-line"></div></div>' +
      '<div class="flow-end">' + endLabel + '</div>' +
      '</div></div>';
  }

  /**
   * renderChecklist(instance) -> HTML 字符串
   * 顶层步骤与子步骤可分别勾选；data-step-index / data-sub-index 供 renderer.js 事件委托（§9.6）。
   */
  function renderChecklist(instance) {
    const steps = toArray(instance && instance.steps);
    if (steps.length === 0) {
      return '<p class="step-note">这个执行没有步骤，点「完成」即可归档。</p>';
    }

    return steps.map(function (s, i) {
      const step = s && typeof s === 'object' ? s : {};
      const subs = toArray(step.subSteps);
      const stepDone = P().isStepComplete(step);

      const parent =
        '<div class="checklist-item' + (stepDone ? ' done' : '') + '"' +
        ' data-step-index="' + i + '"' +
        ' tabindex="0" role="checkbox" aria-checked="' + (stepDone ? 'true' : 'false') + '"' +
        ' aria-label="步骤 ' + (i + 1) + '：' + escA(step.title) + '">' +
        '<span class="checklist-check">' + svg(ICON.check, 14, 'stroke-width="3"') + '</span>' +
        '<div class="checklist-content">' +
        '<div class="step-title">' + hl(esc(step.title)) + '</div>' +
        (step.note ? '<div class="step-note">' + hl(esc(step.note)) + '</div>' : '') +
        '</div></div>';

      const subList = subs.length > 0
        ? '<div class="checklist-sub">' + subs.map(function (ss, j) {
          const sub = ss && typeof ss === 'object' ? ss : { title: ss };
          const subDone = sub.done === true;
          return '<div class="checklist-item' + (subDone ? ' done' : '') + '"' +
            ' data-step-index="' + i + '" data-sub-index="' + j + '"' +
            ' tabindex="0" role="checkbox" aria-checked="' + (subDone ? 'true' : 'false') + '"' +
            ' aria-label="子步骤 ' + (j + 1) + '：' + escA(sub.title) + '">' +
            '<span class="checklist-check">' + svg(ICON.check, 14, 'stroke-width="3"') + '</span>' +
            '<div class="checklist-content"><div class="step-title">' + hl(esc(sub.title)) + '</div></div>' +
            '</div>';
        }).join('') + '</div>'
        : '';

      return '<div class="checklist-step">' + parent + subList + '</div>';
    }).join('');
  }

  /**
   * renderStepEditor(step, index) -> HTML 字符串（模板编辑弹窗的步骤编辑器）
   * data-step-id / data-sub-id 定位 DOM，data-action 供 renderer.js 事件委托（§9.6）。
   */
  function renderStepEditor(step, index) {
    const s = step && typeof step === 'object' ? step : {};
    const idx = Number.isFinite(Number(index)) ? Number(index) : 0;
    const stepId = s.id ? str(s.id) : U().genId('s');
    const subs = toArray(s.subSteps);

    const subHTML = subs.map(function (ss) {
      const sub = ss && typeof ss === 'object' ? ss : { title: ss };
      const subId = sub.id ? str(sub.id) : U().genId('ss');
      return '<div class="sub-step-input" data-sub-id="' + escA(subId) + '">' +
        '<input type="text" class="sub-step-field" value="' + escA(sub.title) + '" placeholder="子步骤...">' +
        '<button class="btn-remove-sub" type="button" data-action="sub-up" title="上移子步骤" aria-label="上移子步骤">' + svg(ICON.up, 12) + '</button>' +
        '<button class="btn-remove-sub" type="button" data-action="sub-down" title="下移子步骤" aria-label="下移子步骤">' + svg(ICON.down, 12) + '</button>' +
        '<button class="btn-remove-sub" type="button" data-action="del-sub" title="删除子步骤" aria-label="删除子步骤">' + svg(ICON.close, 12) + '</button>' +
        '</div>';
    }).join('');

    return '<div class="step-editor-item" data-step-id="' + escA(stepId) + '">' +
      '<span class="step-number">' + (idx + 1) + '</span>' +
      '<div class="step-editor-fields">' +
      '<input type="text" class="step-title-input" value="' + escA(s.title) + '" ' +
      'placeholder="步骤名称（用 {{变量名}} 插入变量，如 {{服务器地址}}）">' +
      '<textarea class="step-note-input" placeholder="备注说明（可选）">' + esc(s.note) + '</textarea>' +
      '<div class="sub-steps-editor">' + subHTML +
      '<button class="btn-add-sub" type="button" data-action="add-sub">+ 子步骤</button>' +
      '</div>' +
      '</div>' +
      '<button class="btn-remove-step" type="button" data-action="step-up" title="上移步骤" aria-label="上移步骤">' + svg(ICON.up, 16) + '</button>' +
      '<button class="btn-remove-step" type="button" data-action="step-down" title="下移步骤" aria-label="下移步骤">' + svg(ICON.down, 16) + '</button>' +
      '<button class="btn-remove-step" type="button" data-action="del-step" title="删除步骤" aria-label="删除步骤">' + svg(ICON.trash, 16) + '</button>' +
      '</div>';
  }

  // ---------------------------------------------------------------- 局部 DOM 工具

  function syncToggle(scopeSelector, mode) {
    const root = document.querySelector(scopeSelector);
    if (!root) return;
    const buttons = root.querySelectorAll('.toggle-btn[data-mode]');
    for (let i = 0; i < buttons.length; i += 1) {
      const b = buttons[i];
      const on = b.getAttribute('data-mode') === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function setDisabled(id, disabled) {
    const node = el(id);
    if (!node) return;
    node.disabled = disabled === true;
    node.classList.toggle('is-disabled', disabled === true);
  }

  function setFavoriteButton(isFav, enabled) {
    const btn = el('detail-favorite-toggle');
    if (!btn) return;
    btn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
    btn.classList.toggle('active', isFav);
    btn.disabled = enabled === false;
    btn.innerHTML = svg(ICON.star, 14, isFav ? 'fill="var(--warning)" stroke="var(--warning)"' : '') +
      (isFav ? '已收藏' : '收藏');
  }

  return {
    SOPRender: {
      renderDashboard: renderDashboard,
      renderTemplates: renderTemplates,
      renderInstances: renderInstances,
      renderHistory: renderHistory,
      renderTemplateDetail: renderTemplateDetail,
      renderInstanceDetail: renderInstanceDetail,
      renderFlowchart: renderFlowchart,
      renderChecklist: renderChecklist,
      renderStepEditor: renderStepEditor,
      statusBadge: statusBadge,
      toast: toast,
    },
  };
});
