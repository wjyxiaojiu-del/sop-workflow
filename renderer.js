// renderer.js — SOP 工作流 v1.1 交互层（契约 docs/contracts/v1.1-interface.md §8 / §9 / §10）
//
// 职责边界
//  - 渲染全部委托给 SOPRender（render.js）；本文件只做 state 构造、事件委托、数据写入、视图切换。
//  - 进度一律由 core/progress.js 计算（§3.3 IRON RULE），本文件不自行算比例。
//  - 所有用户输入进入 HTML 前必须经 utils.escHtml / utils.escAttr（§8.3）。
//  - 保存失败时不得关闭弹窗 / 切换页面 / 清空输入（§7.2 IRON RULE）。
//  - 不使用 alert / confirm，一律 #toast-container（§9.7）。
(function () {
  'use strict';

  // ------------------------------------------------------------------ 依赖
  // index.html 按 §1.3 顺序加载：core 五个模块 → render.js → renderer.js。
  const core = globalThis.SOPCore || {};
  const R = globalThis.SOPRender || {};
  const U = core.utils;
  const P = core.progress;
  const T = core.templateService;
  const I = core.instanceService;
  const DS = core.dataStore;

  function missing(list, obj) {
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      if (!obj || !obj[list[i]]) out.push(list[i]);
    }
    return out;
  }

  function el(id) { return document.getElementById(id); }
  function msg(e) { return e && e.message ? String(e.message) : String(e); }
  function esc(v) { return U.escHtml(v); }
  function escA(v) { return U.escAttr(v); }
  function closest(target, sel) {
    return target && typeof target.closest === 'function' ? target.closest(sel) : null;
  }
  function toast(message, type) {
    if (R.toast) R.toast(message, type);
  }

  // ------------------------------------------------------------------ state（契约 §10 state 形状）
  const state = {
    data: {
      schemaVersion: 2,
      templates: [],
      instances: [],
      history: [],
      meta: { lastSavedAt: 0, exportedAt: null },
    },
    query: '',
    category: '',
    favoriteOnly: false,
    sort: 'recent',
    currentTemplateId: null,
    currentInstanceId: null,
    detailViewMode: 'list',
    instanceViewMode: 'checklist',
    isDirty: false,
  };

  let currentView = 'templates';

  // 输入立即进入脏状态；写入串行化，旧请求不得清除更新的输入。
  let dataDirty = false;
  let editorDirty = false;
  let dataRevision = 0;
  let editorRevision = 0;
  let pendingSaves = 0;
  let saveQueue = Promise.resolve();
  const notesDrafts = new Map();

  // 模板编辑弹窗
  let editingTemplateId = null;
  let pendingNewId = null;
  let templateSaveRunning = false;
  let instanceCreateRunning = false;
  let duplicateRunning = false;

  // 弹窗栈 / 确认弹窗回调
  const modalStack = [];
  let confirmHandlers = null;
  let confirmRunning = false;

  // 导入
  let pendingImport = null;
  let pendingTemplateId = null;

  // 备注防抖
  let notesTimer = null;

  let lastFocus = null;

  // ------------------------------------------------------------------ 脏标记

  function syncDirty() {
    state.isDirty = dataDirty === true || editorDirty === true || pendingSaves > 0;
    if (window.api && typeof window.api.setDirtyState === 'function') {
      try { window.api.setDirtyState(state.isDirty); } catch (e) { /* 主进程不可用不影响交互 */ }
    }
  }

  function markDataDirty(v) {
    dataDirty = v === true;
    if (dataDirty) dataRevision += 1;
    syncDirty();
  }

  function markEditorDirty() {
    editorDirty = true;
    editorRevision += 1;
    syncDirty();
  }

  // ------------------------------------------------------------------ 保存（§7.2）

  /** persistData() -> Promise<{ ok, error, savedAt }>；备注失败后仍留在内存，可重试。 */
  function persistData() {
    return commitChange(function () {});
  }

  /**
   * commitChange(mutator) -> Promise<{ ok, error, savedAt }>
   * 排队时不改 state；执行时从最新数据生成草稿，成功后才提交。失败不会留下幽灵模板、
   * 终态实例或重复历史。保存期间新输入的备注按 revision 合回，不能被旧快照覆盖。
   */
  function commitChange(mutator) {
    pendingSaves += 1;
    syncDirty();
    const operation = saveQueue.then(async function () {
      try {
        const revision = dataRevision;
        const draft = U.deepClone(state.data);
        mutator(draft);
        const res = await DS.save(draft);
        if (!res || !res.ok) return res || { ok: false, error: '保存失败', savedAt: null };

        notesDrafts.forEach(function (note, id) {
          if (note.revision <= revision) {
            notesDrafts.delete(id);
          } else {
            const instance = (draft.instances || []).find(function (item) { return item.id === id; });
            if (instance) {
              instance.executionNotes = note.value;
              instance.updatedAt = note.updatedAt;
            }
          }
        });
        state.data = draft;
        dataDirty = dataRevision !== revision;
        return res;
      } catch (e) {
        return { ok: false, error: msg(e), savedAt: null };
      } finally {
        pendingSaves -= 1;
        syncDirty();
      }
    });
    saveQueue = operation;
    return operation;
  }

  /** 统一提示并记录保存失败（不清空输入、不切页面）。 */
  function reportSaveFailure(res, prefix) {
    const detail = res && res.error ? res.error : '未知错误';
    const message = (prefix || '保存失败') + '：' + detail;
    console.error(message);
    toast(message, 'error');
  }

  // ------------------------------------------------------------------ 视图切换

  const VIEW_IDS = ['templates', 'instances', 'history', 'template-detail', 'instance-detail'];
  const NAV_OF = {
    templates: 'templates',
    'template-detail': 'templates',
    instances: 'instances',
    'instance-detail': 'instances',
    history: 'history',
  };

  function showView(view) {
    if (VIEW_IDS.indexOf(view) < 0) view = 'templates';
    currentView = view;

    for (let i = 0; i < VIEW_IDS.length; i += 1) {
      const node = el('view-' + VIEW_IDS[i]);
      if (node) node.classList.toggle('active', VIEW_IDS[i] === view);
    }

    const navKey = NAV_OF[view] || 'templates';
    const navItems = document.querySelectorAll('.nav-item[data-view]');
    for (let i = 0; i < navItems.length; i += 1) {
      navItems[i].classList.toggle('active', navItems[i].getAttribute('data-view') === navKey);
    }

    renderCurrent();
  }

  /** 只重绘当前视图（渲染全部交给 render.js） */
  function renderCurrent() {
    if (!R.renderDashboard) return;
    if (currentView === 'templates') R.renderDashboard(state);
    else if (currentView === 'instances') R.renderInstances(state);
    else if (currentView === 'history') R.renderHistory(state);
    else if (currentView === 'template-detail') R.renderTemplateDetail(state);
    else if (currentView === 'instance-detail') R.renderInstanceDetail(state);
    updateBadge();
  }

  function updateBadge() {
    const badge = el('running-badge');
    if (!badge) return;
    const active = (state.data.instances || []).filter(function (i) { return I.isActive(i); });
    badge.textContent = String(active.length);
    badge.style.display = active.length > 0 ? '' : 'none';
  }

  // ------------------------------------------------------------------ 数据查找

  function findInstance(id) {
    const list = state.data.instances || [];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function currentTemplate() {
    return state.currentTemplateId ? T.findTemplate(state.data.templates || [], state.currentTemplateId) : null;
  }

  function replaceInstance(draft, next) {
    const list = draft.instances || [];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === next.id) { list[i] = next; return true; }
    }
    list.unshift(next);
    return false;
  }

  // ------------------------------------------------------------------ 弹窗基础

  function openModal(id) {
    const node = el(id);
    if (!node) return;
    node.style.display = 'flex';
    if (modalStack.indexOf(id) < 0) modalStack.push(id);
    lastFocus = document.activeElement;
    const focusable = node.querySelector('input:not([type="radio"]), textarea, select, .modal-footer button');
    if (focusable && typeof focusable.focus === 'function') {
      try { focusable.focus(); } catch (e) { /* 忽略 */ }
    }
  }

  function closeModal(id) {
    const node = el(id);
    if (node) node.style.display = 'none';
    const at = modalStack.lastIndexOf(id);
    if (at >= 0) modalStack.splice(at, 1);
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) { /* 元素可能已被重绘移除 */ }
    }
    lastFocus = null;
  }

  function activeModal() {
    return modalStack.length > 0 ? modalStack[modalStack.length - 1] : null;
  }

  // ------------------------------------------------------------------ 通用确认弹窗（#modal-confirm）

  /**
   * openConfirm({ title, message, okText, okVariant, cancelText, discardText, onOk, onCancel, onDiscard })
   * 回调返回 false 表示「不要关闭弹窗」（例如保存失败时保持弹窗打开）。
   */
  function openConfirm(opts) {
    const o = opts || {};
    const title = el('modal-confirm-title');
    const message = el('modal-confirm-message');
    const ok = el('btn-confirm-ok');
    const cancel = el('btn-confirm-cancel');
    const discard = el('btn-confirm-discard');
    if (!ok || !cancel || !discard) return;

    if (title) title.textContent = o.title || '确认操作';
    if (message) message.textContent = o.message || '';
    ok.textContent = o.okText || '确定';
    ok.className = o.okVariant === 'danger' ? 'btn-danger' : 'btn-primary';
    cancel.textContent = o.cancelText || '取消';
    if (o.discardText) {
      discard.textContent = o.discardText;
      discard.className = 'btn-danger';
      discard.style.display = '';
    } else {
      discard.style.display = 'none';
    }

    confirmHandlers = { ok: o.onOk || null, cancel: o.onCancel || null, discard: o.onDiscard || null };
    openModal('modal-confirm');
    try { ok.focus(); } catch (e) { /* 忽略 */ }
  }

  async function runConfirm(which) {
    if (confirmRunning) return;
    const handlers = confirmHandlers;
    if (!handlers) { closeModal('modal-confirm'); return; }
    const handler = handlers[which];
    if (!handler) { confirmHandlers = null; closeModal('modal-confirm'); return; }

    confirmRunning = true;
    let keep = false;
    try {
      keep = (await handler()) === false;
    } catch (e) {
      toast('操作失败：' + msg(e), 'error');
      keep = true;
    }
    confirmRunning = false;

    if (!keep) {
      confirmHandlers = null;
      closeModal('modal-confirm');
    }
  }

  // ------------------------------------------------------------------ 模板编辑弹窗

  function openTemplateModal(template) {
    const name = el('input-template-name');
    const desc = el('input-template-desc');
    const category = el('input-template-category');
    const tags = el('input-template-tags');
    const favorite = el('input-template-favorite');
    const title = el('modal-template-title');
    const editor = el('steps-editor');
    if (!name || !editor) return;

    editingTemplateId = template && template.id ? String(template.id) : null;
    pendingNewId = null;
    editorDirty = false;
    editorRevision += 1;
    syncDirty();

    if (title) title.textContent = template ? '编辑 SOP 模板' : '新建 SOP 模板';
    name.value = template ? String(template.name || '') : '';
    if (desc) desc.value = template ? String(template.desc || '') : '';
    if (category) category.value = template && template.category ? String(template.category) : '其他';
    if (tags) tags.value = template && Array.isArray(template.tags) ? template.tags.join(', ') : '';
    if (favorite) favorite.checked = !!(template && template.favorite === true);

    const steps = template && Array.isArray(template.steps) ? template.steps : [];
    editor.innerHTML = steps.length > 0
      ? steps.map(function (s, i) { return R.renderStepEditor(s, i); }).join('')
      : R.renderStepEditor({}, 0);
    renumberSteps();

    openModal('modal-template');
    try { name.focus(); } catch (e) { /* 忽略 */ }
  }

  function renumberSteps() {
    const items = document.querySelectorAll('#steps-editor .step-editor-item');
    for (let i = 0; i < items.length; i += 1) {
      const num = items[i].querySelector('.step-number');
      if (num) num.textContent = String(i + 1);
    }
  }

  /** 从编辑器 DOM 收集步骤（标题为空的步骤/子步骤丢弃） */
  function collectSteps() {
    const items = document.querySelectorAll('#steps-editor .step-editor-item');
    const steps = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const titleInput = item.querySelector('.step-title-input');
      const noteInput = item.querySelector('.step-note-input');
      const title = titleInput ? String(titleInput.value).trim() : '';
      if (!title) continue;
      const subs = [];
      const subRows = item.querySelectorAll('.sub-step-input');
      for (let j = 0; j < subRows.length; j += 1) {
        const field = subRows[j].querySelector('.sub-step-field');
        const subTitle = field ? String(field.value).trim() : '';
        if (!subTitle) continue;
        subs.push({
          id: subRows[j].getAttribute('data-sub-id') || U.genId('ss'),
          title: subTitle,
          done: false,
        });
      }
      steps.push({
        id: item.getAttribute('data-step-id') || U.genId('s'),
        title: title,
        note: noteInput ? String(noteInput.value).trim() : '',
        done: false,
        subSteps: subs,
      });
    }
    return steps;
  }

  /** saveTemplate() -> boolean（true = 已成功落盘） */
  async function saveTemplate() {
    if (templateSaveRunning) return false;
    const nameInput = el('input-template-name');
    const name = nameInput ? String(nameInput.value).trim() : '';
    if (!name) {
      toast('请先填写模板名称', 'error');
      if (nameInput) nameInput.focus();
      return false;
    }
    const steps = collectSteps();
    if (steps.length === 0) {
      toast('至少需要一个有名称的步骤', 'error');
      return false;
    }

    const patch = {
      name: name,
      desc: el('input-template-desc') ? String(el('input-template-desc').value).trim() : '',
      category: el('input-template-category') ? String(el('input-template-category').value) : '其他',
      tags: T.normalizeTags(el('input-template-tags') ? el('input-template-tags').value : ''),
      favorite: !!(el('input-template-favorite') && el('input-template-favorite').checked),
      steps: steps,
    };

    if (!editingTemplateId && !pendingNewId) pendingNewId = U.genId('t');
    const targetId = editingTemplateId || pendingNewId;
    const revision = editorRevision;
    templateSaveRunning = true;
    let res;
    try {
      res = await commitChange(function (draft) {
        const list = draft.templates || [];
        const at = list.findIndex(function (item) { return item && item.id === targetId; });
        if (at >= 0) list[at] = T.updateTemplate(list[at], patch);
        else list.unshift(T.createTemplate(Object.assign({}, patch, { id: targetId })));
      });
    } finally {
      templateSaveRunning = false;
    }
    if (!res.ok) {
      // §7.2 IRON RULE：保持弹窗打开、保留用户输入；重试复用同一 id。
      reportSaveFailure(res, '保存失败');
      return false;
    }

    pendingNewId = null;
    editingTemplateId = targetId;
    if (revision !== editorRevision) {
      // 本次快照已落盘，但用户在等待期间又输入了内容；不得关闭或清脏。
      toast('已保存先前内容，新的修改仍待保存', 'info');
      return false;
    }
    editorDirty = false;
    syncDirty();
    editingTemplateId = null;
    closeModal('modal-template');
    state.currentTemplateId = targetId;
    showView('template-detail');
    toast('模板已保存', 'success');
    return true;
  }

  function requestCloseTemplateModal() {
    if (templateSaveRunning) { toast('正在保存，请稍候', 'info'); return; }
    if (!editorDirty) { closeModal('modal-template'); return; }
    openConfirm({
      title: '放弃未保存的修改？',
      message: '模板编辑内容尚未保存，关闭后这次修改会丢失。',
      okText: '放弃修改',
      okVariant: 'danger',
      cancelText: '继续编辑',
      onOk: function () {
        editorDirty = false;
        syncDirty();
        closeModal('modal-template');
      },
    });
  }

  // ------------------------------------------------------------------ 步骤编辑器（data-action 事件委托，§9.6）

  function moveEditorRow(node, dir) {
    const parent = node.parentNode;
    if (!parent) return;
    const isStep = node.classList.contains('step-editor-item');
    const cls = isStep ? 'step-editor-item' : 'sub-step-input';
    const rows = [];
    for (let i = 0; i < parent.children.length; i += 1) {
      if (parent.children[i].classList.contains(cls)) rows.push(parent.children[i]);
    }
    const from = rows.indexOf(node);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= rows.length) return;
    if (dir < 0) parent.insertBefore(node, rows[to]);
    else parent.insertBefore(rows[to], node);
    markEditorDirty();
    if (isStep) renumberSteps();
  }

  /** 用 render.js 的步骤编辑器片段生成一个子步骤行（不重复维护标记结构） */
  function buildSubRow(subId) {
    const tmp = document.createElement('div');
    tmp.innerHTML = R.renderStepEditor({ id: 'tmp_row', subSteps: [{ id: subId, title: '' }] }, 0);
    return tmp.querySelector('.sub-step-input');
  }

  function addSubRow(item) {
    const box = item.querySelector('.sub-steps-editor');
    if (!box) return;
    const addBtn = box.querySelector('.btn-add-sub');
    const row = buildSubRow(U.genId('ss'));
    if (!row) return;
    if (addBtn) box.insertBefore(row, addBtn);
    else box.appendChild(row);
    markEditorDirty();
    const field = row.querySelector('.sub-step-field');
    if (field) field.focus();
  }

  function confirmDeleteStep(item) {
    const input = item.querySelector('.step-title-input');
    const label = input && String(input.value).trim() ? String(input.value).trim() : '这个步骤';
    openConfirm({
      title: '删除步骤',
      message: '确定删除「' + label + '」及其全部子步骤吗？',
      okText: '删除',
      okVariant: 'danger',
      onOk: function () {
        item.parentNode.removeChild(item);
        renumberSteps();
        markEditorDirty();
      },
    });
  }

  function onStepsEditorClick(event) {
    const btn = closest(event.target, '#steps-editor [data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const item = closest(btn, '.step-editor-item');
    if (!item) return;

    if (action === 'del-step') { confirmDeleteStep(item); return; }
    if (action === 'step-up') { moveEditorRow(item, -1); return; }
    if (action === 'step-down') { moveEditorRow(item, 1); return; }
    if (action === 'add-sub') { addSubRow(item); return; }

    const sub = closest(btn, '.sub-step-input');
    if (!sub) return;
    if (action === 'del-sub') {
      sub.parentNode.removeChild(sub);
      markEditorDirty();
    } else if (action === 'sub-up') {
      moveEditorRow(sub, -1);
    } else if (action === 'sub-down') {
      moveEditorRow(sub, 1);
    }
  }

  // ------------------------------------------------------------------ 模板操作

  function openTemplateDetail(id) {
    state.currentTemplateId = id;
    showView('template-detail');
  }

  async function toggleFavorite() {
    const t = currentTemplate();
    if (!t) return;
    const res = await commitChange(function (draft) {
      const list = draft.templates || [];
      for (let i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === t.id) {
          list[i] = Object.assign({}, list[i], { favorite: list[i].favorite !== true });
          break;
        }
      }
    });
    if (!res.ok) { reportSaveFailure(res, '收藏保存失败'); return; }
    renderCurrent();
  }

  async function duplicateTemplate() {
    if (duplicateRunning) return;
    const t = currentTemplate();
    if (!t) return;
    const existingNames = (state.data.templates || []).map(function (x) { return x && x.name; });
    let copy;
    try {
      copy = T.duplicateTemplate(t, { existingNames: existingNames });
    } catch (e) {
      toast('复制失败：' + msg(e), 'error');
      return;
    }
    duplicateRunning = true;
    const res = await commitChange(function (draft) {
      (draft.templates || []).unshift(copy);
    });
    duplicateRunning = false;
    if (!res.ok) { reportSaveFailure(res, '复制失败'); return; }
    state.currentTemplateId = copy.id;
    toast('已复制为「' + copy.name + '」', 'success');
    renderCurrent();
    openTemplateModal(copy); // 复制后进入编辑状态
  }

  function deleteTemplate() {
    const t = currentTemplate();
    if (!t) return;
    openConfirm({
      title: '删除模板',
      message: '确定删除「' + t.name + '」吗？该操作不可恢复，已有的执行记录与历史不受影响。',
      okText: '删除',
      okVariant: 'danger',
      onOk: async function () {
        const res = await commitChange(function (draft) {
          draft.templates = (draft.templates || []).filter(function (x) { return x && x.id !== t.id; });
        });
        if (!res.ok) { reportSaveFailure(res, '删除失败'); return false; }
        state.currentTemplateId = null;
        showView('templates');
        toast('模板已删除', 'success');
      },
    });
  }

  // ------------------------------------------------------------------ 变量弹窗 → 创建实例

  function collectVariableTexts(template) {
    const texts = [];
    const steps = Array.isArray(template.steps) ? template.steps : [];
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i] || {};
      texts.push(s.title, s.note);
      const subs = Array.isArray(s.subSteps) ? s.subSteps : [];
      for (let j = 0; j < subs.length; j += 1) {
        texts.push(subs[j] && typeof subs[j] === 'object' ? subs[j].title : subs[j]);
      }
    }
    return texts;
  }

  function startInstance() {
    const t = currentTemplate();
    if (!t) return;
    if (!Array.isArray(t.steps) || t.steps.length === 0) {
      toast('该模板还没有步骤，无法开始执行', 'error');
      return;
    }

    let vars = [];
    try {
      vars = U.extractVariables.apply(null, collectVariableTexts(t));
    } catch (e) {
      vars = [];
    }

    if (vars.length === 0) { createInstance(t, {}); return; }

    const form = el('variables-form');
    if (!form) return;
    form.innerHTML = vars.map(function (v, i) {
      const vid = 'var-field-' + i;
      return '<div class="form-group variable-group">' +
        '<label for="' + escA(vid) + '">' + esc(v) + '</label>' +
        '<input type="text" class="variable-input" id="' + escA(vid) + '" data-var="' + escA(v) + '" ' +
        'placeholder="填写 ' + escA(v) + ' 的值">' +
        '</div>';
    }).join('');

    pendingTemplateId = t.id;
    openModal('modal-variables');
  }

  function confirmVariables() {
    const form = el('variables-form');
    if (!form) { closeModal('modal-variables'); return; }
    const vars = Object.create(null);
    const inputs = form.querySelectorAll('.variable-input[data-var]');
    for (let i = 0; i < inputs.length; i += 1) {
      vars[inputs[i].getAttribute('data-var')] = String(inputs[i].value);
    }
    const t = T.findTemplate(state.data.templates || [], pendingTemplateId);
    if (!t) {
      toast('模板不存在，可能已被删除', 'error');
      closeModal('modal-variables');
      return;
    }
    return createInstance(t, vars);
  }

  async function createInstance(template, variables) {
    if (instanceCreateRunning) return false;
    let instance;
    try {
      instance = I.createInstance(template, variables);
    } catch (e) {
      toast('创建执行失败：' + msg(e), 'error');
      return;
    }

    const now = Date.now();
    instanceCreateRunning = true;
    const res = await commitChange(function (draft) {
      (draft.instances || []).unshift(instance);
      const list = draft.templates || [];
      for (let i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === template.id) {
          // 只记录最近使用时间，不改版本号（版本号只跟随内容变更）
          list[i] = Object.assign({}, list[i], { lastUsedAt: now });
          break;
        }
      }
    });

    instanceCreateRunning = false;
    if (!res.ok) {
      reportSaveFailure(res, '执行未保存，请重试');
      return false;
    }

    if (modalStack.indexOf('modal-variables') >= 0) closeModal('modal-variables');
    pendingTemplateId = null;
    state.currentInstanceId = instance.id;
    state.instanceViewMode = 'checklist';
    showView('instance-detail');
    toast('开始执行：' + (template.name || ''), 'success');
  }

  // ------------------------------------------------------------------ 实例执行

  function openInstanceDetail(id) {
    state.currentInstanceId = id;
    state.instanceViewMode = 'checklist';
    showView('instance-detail');
  }

  async function applyInstance(id, update, successMessage) {
    const res = await commitChange(function (draft) {
      const inst = (draft.instances || []).find(function (item) { return item.id === id; });
      if (!inst) throw new Error('执行记录不存在');
      replaceInstance(draft, update(inst));
    });
    if (!res.ok) { reportSaveFailure(res, '保存失败'); return false; }
    renderCurrent();
    if (successMessage) toast(successMessage, 'info');
    return true;
  }

  async function pauseCurrent() {
    return applyInstance(state.currentInstanceId, I.pauseInstance, '已暂停');
  }

  async function resumeCurrent() {
    return applyInstance(state.currentInstanceId, I.resumeInstance, '已继续');
  }

  async function finishCurrent(force, id) {
    const inst = findInstance(id || state.currentInstanceId);
    if (!inst) return false;

    if (!force) {
      const p = P.calculateProgress(inst); // §3.3 IRON RULE
      if (p.total > 0 && p.done < p.total) {
        openConfirm({
          title: '还有未完成的步骤',
          message: '当前进度 ' + p.done + ' / ' + p.total + '（' + p.percent + '%）。仍要标记为完成吗？',
          okText: '仍然完成',
          onOk: function () { return finishCurrent(true, inst.id); },
        });
        return;
      }
    }

    const res = await commitChange(function (draft) {
      const current = (draft.instances || []).find(function (item) { return item.id === inst.id; });
      if (current && current.status === 'completed') return; // 同一操作重入不再生成历史
      const result = I.completeInstance(current);
      replaceInstance(draft, result.instance);
      (draft.history || []).unshift(result.history);
    });
    if (!res.ok) { reportSaveFailure(res, '完成失败'); return false; }
    renderCurrent();
    toast('已标记完成，记录已写入历史', 'success');
    return true;
  }

  function abandonCurrent() {
    const inst = findInstance(state.currentInstanceId);
    if (!inst) return;
    openConfirm({
      title: '放弃执行',
      message: '确定放弃「' + (inst.templateName || '本次执行') + '」吗？放弃后进度会被保留并记入历史，但不能再继续执行。',
      okText: '放弃执行',
      okVariant: 'danger',
      onOk: async function () {
        const res = await commitChange(function (draft) {
          const current = (draft.instances || []).find(function (item) { return item.id === inst.id; });
          if (current && current.status === 'abandoned') return;
          const result = I.abandonInstance(current);
          replaceInstance(draft, result.instance);
          (draft.history || []).unshift(result.history);
        });
        if (!res.ok) { reportSaveFailure(res, '放弃失败'); return false; }
        renderCurrent();
        toast('已放弃执行，记录已写入历史', 'info');
      },
    });
  }

  /** 勾选顶层步骤 / 子步骤（§3.5 语义由 core/progress.js 保证） */
  async function toggleChecklistItem(item) {
    const inst = findInstance(state.currentInstanceId);
    if (!inst) return;
    if (inst.status !== 'running' && inst.status !== 'paused') return;

    const stepIndex = Number(item.getAttribute('data-step-index'));
    const subRaw = item.getAttribute('data-sub-index');
    const nextDone = item.getAttribute('aria-checked') !== 'true';

    const res = await commitChange(function (draft) {
      const current = (draft.instances || []).find(function (entry) { return entry.id === inst.id; });
      if (!current || !I.isActive(current)) throw new Error('执行记录已结束，不能修改进度');
      const next = subRaw === null
        ? P.toggleStep(current, stepIndex, nextDone)
        : P.toggleSubStep(current, stepIndex, Number(subRaw), nextDone);
      replaceInstance(draft, I.updateInstance(next, {}));
    });
    if (!res.ok) { reportSaveFailure(res, '进度保存失败'); return; }
    renderCurrent();
  }

  // ------------------------------------------------------------------ 执行备注

  function scheduleNotesSave() {
    const box = el('instance-exec-notes');
    const inst = findInstance(box && box.getAttribute('data-instance-id'));
    if (!box || !inst) return;
    const value = String(box.value);
    if (value !== String(inst.executionNotes || '')) {
      const next = I.updateInstance(inst, { executionNotes: value });
      replaceInstance(state.data, next);
      markDataDirty(true);
      notesDrafts.set(inst.id, { value: value, updatedAt: next.updatedAt, revision: dataRevision });
    }
    if (notesTimer) clearTimeout(notesTimer);
    if (dataDirty) notesTimer = setTimeout(flushNotes, 600);
  }

  async function flushNotes() {
    if (notesTimer) { clearTimeout(notesTimer); notesTimer = null; }
    // input 时已按实例 id 捕获，不能在延迟回调里读另一个页面的 textarea。
    if (!dataDirty) return { ok: true };
    const res = await persistData();
    if (!res.ok) reportSaveFailure(res, '备注保存失败');
    return res;
  }

  // ------------------------------------------------------------------ 导入 / 导出

  async function doExport() {
    try {
      if (editorDirty && modalStack.indexOf('modal-template') >= 0) {
        if (!await saveTemplate()) return;
      }
      if (pendingSaves > 0) {
        const pending = await saveQueue;
        if (!pending.ok) { reportSaveFailure(pending, '导出前保存失败'); return; }
      }
      if (dataDirty) {
        if (notesTimer) { clearTimeout(notesTimer); notesTimer = null; }
        const saved = await persistData();
        if (!saved.ok) { reportSaveFailure(saved, '导出前保存失败'); return; }
      }
      if (state.isDirty) { toast('仍有新的修改未保存，请保存后再导出', 'info'); return; }
      const res = await DS.exportToFile();
      if (res.canceled) return;
      if (!res.ok) { toast('导出失败：' + (res.error || '未知错误'), 'error'); return; }
      toast('已导出到 ' + (res.filePath || '所选文件'), 'success');
    } catch (e) {
      reportSaveFailure({ error: msg(e) }, '导出失败');
    }
  }

  async function doImport() {
    const res = await DS.importFromFile();
    if (!res.ok) { toast('导入失败：' + (res.error || '未知错误'), 'error'); return; }
    if (res.canceled) return;
    if (!res.data) { toast('导入文件内容为空', 'error'); return; }

    pendingImport = res.data;
    const s = res.summary || {};
    const box = el('import-summary');
    if (box) {
      box.innerHTML =
        '<strong>导入文件已就绪</strong><br>' +
        '模板 ' + esc(s.templates || 0) + ' 个 · 执行记录 ' + esc(s.instances || 0) + ' 条 · 历史 ' +
        esc(s.history || 0) + ' 条<br>' +
        (res.filePath ? '文件：' + esc(res.filePath) : '');
    }
    const merge = el('import-mode-merge');
    if (merge) merge.checked = true;
    openModal('modal-import');
  }

  async function confirmImport() {
    if (!pendingImport) { closeModal('modal-import'); return; }
    const replace = !!(el('import-mode-replace') && el('import-mode-replace').checked);
    const incoming = pendingImport;

    const res = await commitChange(function (draft) {
      if (replace) {
        draft.templates = incoming.templates || [];
        draft.instances = incoming.instances || [];
        draft.history = incoming.history || [];
      } else {
        const merged = DS.mergeData(draft, incoming);
        draft.templates = merged.templates || [];
        draft.instances = merged.instances || [];
        draft.history = merged.history || [];
      }
    });

    if (!res.ok) {
      // §7.2：保持弹窗打开，用户可重试或取消
      reportSaveFailure(res, '导入失败');
      return;
    }
    pendingImport = null;
    closeModal('modal-import');
    toast('导入完成', 'success');
    renderCurrent();
  }

  // ------------------------------------------------------------------ 恢复提示条

  function showRecoveryBanner(text) {
    const banner = el('recovery-banner');
    if (!banner) return;
    const span = banner.querySelector('.recovery-text');
    if (span && text) span.textContent = text;
    banner.style.display = 'flex';
  }

  function reportRecovery(info) {
    if (info && info.source === 'empty') {
      const text = '主数据文件不可读且无可用备份，当前已打开空数据。请检查数据文件或手动导入备份。' +
        (info.error ? ' 错误：' + String(info.error) : '');
      showRecoveryBanner(text);
      console.error(text);
      toast(text, 'error');
      return;
    }
    showRecoveryBanner(info && info.message ? String(info.message) :
      '检测到主数据文件不可读，已从最近一次备份恢复。请检查最近的模板与执行记录是否完整。');
  }

  // ------------------------------------------------------------------ 关闭流程（§8.2）

  function handleCloseRequested() {
    if (!state.isDirty) {
      if (window.api && window.api.confirmClose) window.api.confirmClose();
      return;
    }

    openConfirm({
      title: '有未保存的更改',
      message: '部分修改还没有写入磁盘。要保存后退出吗？',
      okText: '保存并退出',
      okVariant: 'primary',
      discardText: '直接退出',
      cancelText: '取消',
      onOk: async function () {
        // 编辑器打开且已改动 → 先保存模板内容
        if (editorDirty && modalStack.indexOf('modal-template') >= 0) {
          const saved = await saveTemplate();
          if (!saved) {
            // 保存失败：保持弹窗打开，不退出（不得丢弃用户输入）
            return false;
          }
        }
        if (notesTimer) { clearTimeout(notesTimer); notesTimer = null; }
        const res = await persistData();
        if (!res.ok) {
          reportSaveFailure(res, '保存失败');
          return false;
        }
        if (state.isDirty) {
          toast('仍有新的修改未保存，请再次保存后退出', 'info');
          return false;
        }
        if (window.api && window.api.confirmClose) window.api.confirmClose();
      },
      onDiscard: function () {
        if (window.api && window.api.confirmClose) window.api.confirmClose();
      },
      onCancel: function () {
        if (window.api && window.api.cancelClose) window.api.cancelClose();
      },
    });
  }

  // ------------------------------------------------------------------ 键盘（Phase 5）

  function isTypingTarget(node) {
    if (!node) return false;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
  }

  function onKeydown(event) {
    const mod = event.ctrlKey || event.metaKey;
    const key = String(event.key || '');

    if (key === 'Escape') {
      const top = activeModal();
      if (!top) return;
      event.preventDefault();
      if (top === 'modal-confirm') { runConfirm('cancel'); return; }
      if (top === 'modal-template') { requestCloseTemplateModal(); return; }
      closeModal(top);
      return;
    }

    if (mod && (key === 'n' || key === 'N')) {
      event.preventDefault();
      if (activeModal() === null) openTemplateModal(null);
      return;
    }

    if (mod && (key === 'f' || key === 'F')) {
      event.preventDefault();
      // 搜索快捷键不具备丢弃编辑内容或关闭确认框的权限。
      if (activeModal() !== null) return;
      if (currentView !== 'templates') showView('templates');
      const search = el('search-templates');
      if (search) { search.focus(); if (search.select) search.select(); }
      return;
    }

    if (mod && (key === 's' || key === 'S')) {
      event.preventDefault();
      if (activeModal() === 'modal-template') { saveTemplate(); return; }
      if (activeModal() !== null) return;
      if (currentView === 'instance-detail' || dataDirty) {
        if (notesTimer) { clearTimeout(notesTimer); notesTimer = null; }
        persistData().then(function (res) {
          if (!res.ok) reportSaveFailure(res, '保存失败');
          else if (!state.isDirty) toast('已保存', 'success');
          else toast('仍有新的修改未保存', 'info');
        });
        return;
      }
      toast('当前没有需要保存的内容', 'info');
      return;
    }

    // Space / Enter：只在焦点位于步骤项时激活，绝不在输入框里拦截
    if ((key === ' ' || key === 'Enter' || key === 'Spacebar') && !isTypingTarget(document.activeElement)) {
      const target = closest(document.activeElement, '.checklist-item[data-step-index], .flow-node.executable[data-step-index], .template-card[data-id], .instance-card[data-id]');
      if (target) {
        event.preventDefault();
        target.click();
      }
    }
  }

  // ------------------------------------------------------------------ 事件绑定

  function onDocumentClick(event) {
    const t = event.target;

    // 1) 侧边栏导航
    const nav = closest(t, '.nav-item[data-view]');
    if (nav) { showView(nav.getAttribute('data-view')); return; }

    // 2) 实例卡片的「继续执行」按钮（先于卡片判断）
    const cont = closest(t, '.btn-continue-instance[data-id]');
    if (cont) {
      event.stopPropagation();
      openInstanceDetail(cont.getAttribute('data-id'));
      return;
    }

    // 3) 勾选清单 / 可交互流程图节点
    const check = closest(t, '#instance-checklist .checklist-item[data-step-index], #instance-checklist .flow-node.executable[data-step-index]');
    if (check) { toggleChecklistItem(check); return; }

    // 4) 卡片
    const card = closest(t, '#template-grid .template-card[data-id], #dash-recent-list .template-card[data-id]');
    if (card) { openTemplateDetail(card.getAttribute('data-id')); return; }
    const instCard = closest(t, '#instances-list .instance-card[data-id], #dash-running-list .instance-card[data-id]');
    if (instCard) { openInstanceDetail(instCard.getAttribute('data-id')); return; }

    // 5) 首页筛选胶囊
    const chip = closest(t, '#filter-chips .chip[data-filter]');
    if (chip) {
      state.favoriteOnly = chip.getAttribute('data-filter') === 'favorite';
      const chips = document.querySelectorAll('#filter-chips .chip[data-filter]');
      for (let i = 0; i < chips.length; i += 1) {
        const on = (chips[i].getAttribute('data-filter') === 'favorite') === state.favoriteOnly;
        chips[i].classList.toggle('active', on);
      }
      R.renderDashboard(state);
      updateBadge();
      return;
    }

    // 6) 详情视图切换
    const dToggle = closest(t, '#detail-view-toggle .toggle-btn[data-mode]');
    if (dToggle) {
      state.detailViewMode = dToggle.getAttribute('data-mode') === 'flow' ? 'flow' : 'list';
      R.renderTemplateDetail(state);
      return;
    }
    const iToggle = closest(t, '#instance-mode-toggle .toggle-btn[data-mode]');
    if (iToggle) {
      state.instanceViewMode = iToggle.getAttribute('data-mode') === 'flow' ? 'flow' : 'checklist';
      R.renderInstanceDetail(state);
      return;
    }

    // 7) 步骤编辑器（data-action 委托）
    if (closest(t, '#steps-editor [data-action]')) { onStepsEditorClick(event); return; }

    // 8) 按 id 分发的按钮
    const btn = closest(t, 'button[id], .modal-overlay[id]');
    if (!btn) return;
    const id = btn.id;

    switch (id) {
      // 窗口控制
      case 'btn-minimize': if (window.api && window.api.minimize) window.api.minimize(); return;
      case 'btn-maximize': if (window.api && window.api.maximize) window.api.maximize(); return;
      case 'btn-close': if (window.api && window.api.close) window.api.close(); return;

      // 新建模板（三个入口）
      case 'btn-new-template':
      case 'btn-new-template-top':
      case 'btn-empty-new-template':
        openTemplateModal(null); return;

      // 导入 / 导出
      case 'btn-import-data': doImport(); return;
      case 'btn-export-data': doExport(); return;

      // 恢复提示条
      case 'btn-dismiss-recovery': {
        const banner = el('recovery-banner');
        if (banner) banner.style.display = 'none';
        return;
      }

      // 模板详情
      case 'btn-back-templates': showView('templates'); return;
      case 'detail-favorite-toggle': toggleFavorite(); return;
      case 'btn-duplicate-template': duplicateTemplate(); return;
      case 'btn-edit-template': {
        const tpl = currentTemplate();
        if (tpl) openTemplateModal(tpl);
        return;
      }
      case 'btn-delete-template': deleteTemplate(); return;
      case 'btn-start-instance': startInstance(); return;

      // 模板编辑弹窗
      case 'btn-add-step': {
        const editor = el('steps-editor');
        if (!editor) return;
        const count = editor.querySelectorAll('.step-editor-item').length;
        editor.insertAdjacentHTML('beforeend', R.renderStepEditor({}, count));
        markEditorDirty();
        const rows = editor.querySelectorAll('.step-editor-item');
        const last = rows[rows.length - 1];
        if (last) {
          const input = last.querySelector('.step-title-input');
          if (input) input.focus();
        }
        return;
      }
      case 'btn-save-template': saveTemplate(); return;
      case 'btn-cancel-template': requestCloseTemplateModal(); return;
      case 'modal-template-close': requestCloseTemplateModal(); return;

      // 变量弹窗
      case 'btn-confirm-variables': confirmVariables(); return;
      case 'btn-cancel-variables': closeModal('modal-variables'); return;
      case 'modal-variables-close': closeModal('modal-variables'); return;

      // 通用确认弹窗
      case 'btn-confirm-ok': runConfirm('ok'); return;
      case 'btn-confirm-discard': runConfirm('discard'); return;
      case 'btn-confirm-cancel': runConfirm('cancel'); return;
      case 'modal-confirm-close': runConfirm('cancel'); return;

      // 导入弹窗
      case 'btn-confirm-import': confirmImport(); return;
      case 'btn-cancel-import': pendingImport = null; closeModal('modal-import'); return;
      case 'modal-import-close': pendingImport = null; closeModal('modal-import'); return;

      // 实例详情
      case 'btn-back-instances': showView('instances'); return;
      case 'btn-pause-instance': pauseCurrent(); return;
      case 'btn-resume-instance': resumeCurrent(); return;
      case 'btn-finish-instance': finishCurrent(false); return;
      case 'btn-abandon-instance': abandonCurrent(); return;

      default:
        // 点击遮罩空白处不关闭弹窗，避免误操作丢失输入
        return;
    }
  }

  function bindEvents() {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeydown);

    // 搜索（复用 core 的搜索语义，不重写匹配逻辑）
    const search = el('search-templates');
    if (search) {
      const onSearch = U.debounce(function () {
        state.query = String(search.value);
        if (currentView === 'templates') { R.renderDashboard(state); updateBadge(); }
      }, 180);
      search.addEventListener('input', onSearch);
    }

    const category = el('select-filter-category');
    if (category) {
      category.addEventListener('change', function () {
        state.category = String(category.value);
        if (currentView === 'templates') { R.renderDashboard(state); updateBadge(); }
      });
    }

    const sort = el('select-sort-templates');
    if (sort) {
      sort.addEventListener('change', function () {
        state.sort = String(sort.value) || 'recent';
        if (currentView === 'templates') { R.renderDashboard(state); updateBadge(); }
      });
    }

    // 执行备注：防抖保存
    const notes = el('instance-exec-notes');
    if (notes) {
      notes.addEventListener('input', scheduleNotesSave);
      notes.addEventListener('blur', flushNotes);
    }

    // Chromium 对文本、select、checkbox 的实际修改都会触发 input。
    // 不监听 change：Ctrl+S 隐藏编辑器后的失焦也会触发它，不能把已保存内容重新标脏。
    const templateModal = el('modal-template');
    if (templateModal) {
      templateModal.addEventListener('input', markEditorDirty);
    }

    // 关闭请求（§8.2）
    if (window.api && typeof window.api.onCloseRequested === 'function') {
      window.api.onCloseRequested(handleCloseRequested);
    }
    if (window.api && typeof window.api.onDataRecovered === 'function') {
      window.api.onDataRecovered(reportRecovery);
    }
  }

  // ------------------------------------------------------------------ 启动

  async function init() {
    const missCore = missing(['utils', 'progress', 'templateService', 'instanceService', 'dataStore'], core);
    const missRender = missing([
      'renderDashboard', 'renderTemplates', 'renderInstances', 'renderHistory',
      'renderTemplateDetail', 'renderInstanceDetail', 'renderFlowchart',
      'renderChecklist', 'renderStepEditor', 'statusBadge', 'toast',
    ], R);
    if (missCore.length > 0 || missRender.length > 0) {
      const parts = [];
      if (missCore.length > 0) parts.push('SOPCore.' + missCore.join('/'));
      if (missRender.length > 0) parts.push('SOPRender.' + missRender.join('/'));
      document.body.innerHTML = '<div style="padding:40px;font-family:system-ui;color:#dc2626">' +
        '加载失败：缺少 ' + esc(parts.join('、')) + '。请检查 index.html 的脚本加载顺序（契约 §1.3）。</div>';
      return;
    }

    bindEvents();
    syncDirty();

    let res;
    try {
      res = await DS.load();
    } catch (e) {
      res = { ok: false, error: msg(e), data: null };
    }
    if (res && res.data) state.data = res.data;

    if (!res || !res.ok) {
      toast('数据加载失败：' + ((res && res.error) || '未知错误'), 'error');
    } else if (res.recovered) {
      reportRecovery(res);
    }

    showView('templates');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
