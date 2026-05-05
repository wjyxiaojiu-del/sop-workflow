// ============ 数据层 ============
let appData = { templates: [], instances: [], history: [] };

async function loadData() {
  appData = await window.api.loadData();
  if (!appData.templates) appData.templates = [];
  if (!appData.instances) appData.instances = [];
  if (!appData.history) appData.history = [];
}

async function saveData() {
  await window.api.saveData(appData);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ============ 窗口控制 ============
document.getElementById('btn-minimize').onclick = () => window.api.minimize();
document.getElementById('btn-maximize').onclick = () => window.api.maximize();
document.getElementById('btn-close').onclick = () => window.api.close();

// ============ 视图切换 ============
let currentView = 'templates';

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.add('active');

  const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');

  if (view === 'templates') renderTemplates();
  if (view === 'instances') renderInstances();
  if (view === 'history') renderHistory();
}

function switchViewDirect(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.add('active');
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ============ 模板渲染 ============
function renderTemplates(filter = '') {
  const grid = document.getElementById('template-grid');
  const empty = document.getElementById('templates-empty');
  const templates = appData.templates.filter(t =>
    !filter || t.name.includes(filter) || (t.desc && t.desc.includes(filter))
  );

  if (templates.length === 0) {
    grid.innerHTML = '';
    grid.appendChild(empty);
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  grid.innerHTML = templates.map(t => `
    <div class="template-card" data-id="${t.id}">
      <div class="template-card-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      </div>
      <h3>${escHtml(t.name)}</h3>
      <p>${escHtml(t.desc || '暂无描述')}</p>
      <div class="template-card-meta">
        <span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          ${t.steps.length} 个步骤
        </span>
        <span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          ${formatDate(t.createdAt)}
        </span>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.template-card').forEach(card => {
    card.addEventListener('click', () => showTemplateDetail(card.dataset.id));
  });
}

document.getElementById('search-templates').addEventListener('input', (e) => {
  renderTemplates(e.target.value.trim());
});

// ============ 模板详情 ============
let currentTemplateId = null;
let detailViewMode = 'list'; // 'list' or 'flow'

function showTemplateDetail(id) {
  currentTemplateId = id;
  detailViewMode = 'list';
  updateToggleButtons();
  switchViewDirect('template-detail');
  renderTemplateDetail();
}

function renderTemplateDetail() {
  const t = appData.templates.find(x => x.id === currentTemplateId);
  if (!t) return;

  const detail = document.getElementById('template-detail');

  if (detailViewMode === 'flow') {
    detail.innerHTML = renderFlowchart(t.steps, t.name, t.desc, false);
  } else {
    detail.innerHTML = `
      <h2>${escHtml(t.name)}</h2>
      <p class="desc">${escHtml(t.desc || '暂无描述')}</p>
      <ol class="step-list">
        ${t.steps.map((s, i) => `
          <li class="step-item">
            <span class="step-number">${i + 1}</span>
            <div class="step-content">
              <div class="step-title">${escHtml(s.title)}</div>
              ${s.note ? `<div class="step-note">${highlightVariables(escHtml(s.note))}</div>` : ''}
              ${s.subSteps && s.subSteps.length > 0 ? `
                <div class="step-sub-steps">
                  ${s.subSteps.map(ss => `<div class="sub-step">${escHtml(ss)}</div>`).join('')}
                </div>
              ` : ''}
            </div>
          </li>
        `).join('')}
      </ol>
    `;
  }
}

// 视图切换按钮
document.getElementById('detail-view-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-btn');
  if (!btn) return;
  detailViewMode = btn.dataset.mode;
  updateToggleButtons();
  renderTemplateDetail();
});

function updateToggleButtons() {
  document.querySelectorAll('#detail-view-toggle .toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === detailViewMode);
  });
}

document.getElementById('btn-back-templates').addEventListener('click', () => switchView('templates'));
document.getElementById('btn-back-instances').addEventListener('click', () => switchView('instances'));

// ============ 流程图渲染 ============
function renderFlowchart(steps, title, desc, isInstance, instance = null) {
  const startLabel = isInstance ? '开始执行' : '开始';
  const endLabel = isInstance ? '执行完成' : '结束';

  let nodesHTML = '';

  steps.forEach((s, i) => {
    const isDone = isInstance && s.done;
    const execClass = isInstance ? 'executable' : '';
    const doneClass = isDone ? 'done' : '';

    nodesHTML += `
      <div class="flow-node ${execClass} ${doneClass}" ${isInstance ? `data-step="${i}"` : ''}>
        ${isInstance ? '<div class="flow-check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>' : ''}
        <div class="flow-node-header">
          <span class="flow-node-num">${i + 1}</span>
          <span class="flow-node-title">${escHtml(s.title)}</span>
        </div>
        ${s.note ? `<div class="flow-node-note">${highlightVariables(escHtml(s.note))}</div>` : ''}
        ${s.subSteps && s.subSteps.length > 0 ? `
          <div class="flow-node-substeps">
            ${s.subSteps.map(ss => `<div class="flow-node-sub">${escHtml(ss)}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    `;

    if (i < steps.length - 1) {
      nodesHTML += `
        <div class="flow-connector">
          <div class="flow-connector-line"></div>
          <div class="flow-connector-dot"></div>
          <div class="flow-connector-line"></div>
        </div>
      `;
    }
  });

  return `
    <div class="flowchart-container">
      <div class="flowchart">
        <div class="flow-title">${escHtml(title)}</div>
        ${desc ? `<div class="flow-desc">${escHtml(desc)}</div>` : ''}
        <div class="flow-start">${startLabel}</div>
        <div class="flow-arrow">
          <div class="flow-arrow-line"></div>
        </div>
        ${nodesHTML}
        <div class="flow-arrow">
          <div class="flow-arrow-line"></div>
        </div>
        <div class="flow-end">${endLabel}</div>
      </div>
    </div>
  `;
}

// ============ 模板 CRUD ============
const modalTemplate = document.getElementById('modal-template');
let editingTemplateId = null;

function openTemplateModal(template = null) {
  editingTemplateId = template ? template.id : null;
  document.getElementById('modal-template-title').textContent = template ? '编辑 SOP 模板' : '新建 SOP 模板';
  document.getElementById('input-template-name').value = template ? template.name : '';
  document.getElementById('input-template-desc').value = template ? (template.desc || '') : '';

  const editor = document.getElementById('steps-editor');
  if (template) {
    editor.innerHTML = template.steps.map(s => createStepEditorHTML(s)).join('');
  } else {
    editor.innerHTML = createStepEditorHTML({ title: '', note: '', subSteps: [] });
  }

  modalTemplate.style.display = 'flex';
  document.getElementById('input-template-name').focus();
}

function createStepEditorHTML(step) {
  const subStepsHTML = (step.subSteps || []).map(ss => `
    <div class="sub-step-input">
      <input type="text" class="sub-step-field" value="${escAttr(ss)}" placeholder="子步骤...">
      <button class="btn-remove-sub" title="删除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');

  return `
    <div class="step-editor-item">
      <div class="step-editor-fields">
        <input type="text" class="step-title-input" value="${escAttr(step.title)}" placeholder="步骤名称（用 {{变量名}} 插入变量，如 {{服务器地址}}）">
        <textarea class="step-note-input" placeholder="备注说明（可选）">${escHtml(step.note || '')}</textarea>
        <div class="sub-steps-editor">
          ${subStepsHTML}
          <button class="btn-add-sub">+ 子步骤</button>
        </div>
      </div>
      <button class="btn-remove-step" title="删除步骤">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  `;
}

document.getElementById('btn-new-template').addEventListener('click', () => openTemplateModal());
document.getElementById('modal-template-close').addEventListener('click', () => modalTemplate.style.display = 'none');
document.getElementById('btn-cancel-template').addEventListener('click', () => modalTemplate.style.display = 'none');

document.getElementById('btn-add-step').addEventListener('click', () => {
  const editor = document.getElementById('steps-editor');
  editor.insertAdjacentHTML('beforeend', createStepEditorHTML({ title: '', note: '', subSteps: [] }));
});

// 事件委托
document.getElementById('steps-editor').addEventListener('click', (e) => {
  const target = e.target.closest('button');
  if (!target) return;

  if (target.classList.contains('btn-remove-step')) {
    target.closest('.step-editor-item').remove();
  }
  if (target.classList.contains('btn-add-sub')) {
    const container = target.closest('.sub-steps-editor');
    const input = document.createElement('div');
    input.className = 'sub-step-input';
    input.innerHTML = `
      <input type="text" class="sub-step-field" value="" placeholder="子步骤...">
      <button class="btn-remove-sub" title="删除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
    container.insertBefore(input, target);
  }
  if (target.classList.contains('btn-remove-sub')) {
    target.closest('.sub-step-input').remove();
  }
});

document.getElementById('btn-save-template').addEventListener('click', async () => {
  const name = document.getElementById('input-template-name').value.trim();
  if (!name) {
    alert('请输入模板名称');
    return;
  }

  const desc = document.getElementById('input-template-desc').value.trim();
  const stepItems = document.querySelectorAll('#steps-editor .step-editor-item');
  const steps = [];

  stepItems.forEach(item => {
    const title = item.querySelector('.step-title-input').value.trim();
    if (!title) return;
    const note = item.querySelector('.step-note-input').value.trim();
    const subSteps = Array.from(item.querySelectorAll('.sub-step-field'))
      .map(f => f.value.trim())
      .filter(Boolean);
    steps.push({ title, note, subSteps });
  });

  if (steps.length === 0) {
    alert('请至少添加一个步骤');
    return;
  }

  if (editingTemplateId) {
    const t = appData.templates.find(x => x.id === editingTemplateId);
    if (t) {
      t.name = name;
      t.desc = desc;
      t.steps = steps;
      t.updatedAt = Date.now();
    }
  } else {
    appData.templates.push({
      id: genId(),
      name,
      desc,
      steps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  await saveData();
  modalTemplate.style.display = 'none';
  renderTemplates();
});

// 编辑按钮
document.getElementById('btn-edit-template').addEventListener('click', () => {
  const t = appData.templates.find(x => x.id === currentTemplateId);
  if (t) openTemplateModal(t);
});

// 删除模板
document.getElementById('btn-delete-template').addEventListener('click', async () => {
  if (!confirm('确定要删除这个模板吗？')) return;
  appData.templates = appData.templates.filter(t => t.id !== currentTemplateId);
  await saveData();
  switchView('templates');
});

// ============ 从模板创建实例 ============
document.getElementById('btn-start-instance').addEventListener('click', () => {
  const t = appData.templates.find(x => x.id === currentTemplateId);
  if (!t) return;

  // 提取变量
  const vars = new Set();
  t.steps.forEach(s => {
    const matches = s.title.match(/\{\{(.+?)\}\}/g);
    if (matches) matches.forEach(m => vars.add(m.slice(2, -2)));
    if (s.note) {
      const noteMatches = s.note.match(/\{\{(.+?)\}\}/g);
      if (noteMatches) noteMatches.forEach(m => vars.add(m.slice(2, -2)));
    }
  });

  if (vars.size > 0) {
    openVariablesModal(t, Array.from(vars));
  } else {
    createInstance(t, {});
  }
});

// 变量填写弹窗
const modalVariables = document.getElementById('modal-variables');

function openVariablesModal(template, variables) {
  const form = document.getElementById('variables-form');
  form.innerHTML = variables.map(v => `
    <div class="variable-group">
      <label>${escHtml(v)}</label>
      <input type="text" class="variable-input" data-var="${escAttr(v)}" placeholder="请输入 ${escHtml(v)}">
    </div>
  `).join('');

  modalVariables.style.display = 'flex';
  form.querySelector('input').focus();
  modalVariables.dataset.templateId = template.id;
}

document.getElementById('modal-variables-close').addEventListener('click', () => modalVariables.style.display = 'none');
document.getElementById('btn-cancel-variables').addEventListener('click', () => modalVariables.style.display = 'none');

document.getElementById('btn-confirm-variables').addEventListener('click', async () => {
  const templateId = modalVariables.dataset.templateId;
  const t = appData.templates.find(x => x.id === templateId);
  if (!t) return;

  const vars = {};
  document.querySelectorAll('.variable-input').forEach(input => {
    vars[input.dataset.var] = input.value.trim();
  });

  createInstance(t, vars);
  modalVariables.style.display = 'none';
});

async function createInstance(template, variables) {
  const instance = {
    id: genId(),
    templateId: template.id,
    templateName: template.name,
    variables,
    steps: template.steps.map(s => ({
      title: replaceVars(s.title, variables),
      note: replaceVars(s.note || '', variables),
      subSteps: (s.subSteps || []).map(ss => replaceVars(ss, variables)),
      done: false,
    })),
    startedAt: Date.now(),
    status: 'running',
  };

  appData.instances.push(instance);
  await saveData();
  switchView('instances');
}

// ============ 实例渲染 ============
function renderInstances() {
  const list = document.getElementById('instances-list');
  const empty = document.getElementById('instances-empty');
  const running = appData.instances.filter(i => i.status === 'running');

  updateBadge();

  if (running.length === 0) {
    list.innerHTML = '';
    list.appendChild(empty);
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = running.map(inst => {
    const doneCount = inst.steps.filter(s => s.done).length;
    const total = inst.steps.length;
    const pct = Math.round((doneCount / total) * 100);
    return `
      <div class="instance-card" data-id="${inst.id}">
        <div class="instance-card-header">
          <h3>${escHtml(inst.templateName)}</h3>
          <span class="instance-card-time">${formatDate(inst.startedAt)} 开始</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-text">
          <span>${doneCount}/${total} 步骤完成</span>
          <span>${pct}%</span>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.instance-card').forEach(card => {
    card.addEventListener('click', () => showInstanceDetail(card.dataset.id));
  });
}

// ============ 实例详情 ============
let currentInstanceId = null;

function showInstanceDetail(id) {
  currentInstanceId = id;
  switchViewDirect('instance-detail');
  renderInstanceDetail();
}

function renderInstanceDetail() {
  const inst = appData.instances.find(x => x.id === currentInstanceId);
  if (!inst) return;

  const detail = document.getElementById('instance-detail');
  const doneCount = inst.steps.filter(s => s.done).length;
  const total = inst.steps.length;
  const pct = Math.round((doneCount / total) * 100);

  // 使用流程图模式渲染
  detail.innerHTML = `
    <h2>${escHtml(inst.templateName)}</h2>
    <div class="instance-meta">
      开始于 ${formatDateTime(inst.startedAt)} · 进度 ${pct}%
      <div class="progress-bar" style="margin-top:10px"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    ${renderFlowchart(inst.steps, '', '', true, inst)}
  `;

  // 绑定点击事件
  detail.querySelectorAll('.flow-node.executable').forEach(el => {
    el.addEventListener('click', async () => {
      const idx = parseInt(el.dataset.step);
      inst.steps[idx].done = !inst.steps[idx].done;
      await saveData();
      renderInstanceDetail();
      updateBadge();
    });
  });
}

// 完成实例
document.getElementById('btn-finish-instance').addEventListener('click', async () => {
  const inst = appData.instances.find(x => x.id === currentInstanceId);
  if (!inst) return;

  const doneCount = inst.steps.filter(s => s.done).length;
  if (doneCount < inst.steps.length) {
    if (!confirm(`还有 ${inst.steps.length - doneCount} 个步骤未完成，确定要标记为完成吗？`)) return;
  }

  inst.status = 'completed';
  inst.completedAt = Date.now();
  appData.history.unshift({
    id: inst.id,
    templateName: inst.templateName,
    startedAt: inst.startedAt,
    completedAt: inst.completedAt,
    stepsTotal: inst.steps.length,
    stepsDone: inst.steps.filter(s => s.done).length,
  });

  appData.instances = appData.instances.filter(x => x.id !== currentInstanceId);
  await saveData();
  switchView('instances');
});

// 放弃实例
document.getElementById('btn-abandon-instance').addEventListener('click', async () => {
  if (!confirm('确定要放弃这个 SOP 执行吗？')) return;
  appData.instances = appData.instances.filter(x => x.id !== currentInstanceId);
  await saveData();
  switchView('instances');
});

// ============ 历史记录 ============
function renderHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');

  if (appData.history.length === 0) {
    list.innerHTML = '';
    list.appendChild(empty);
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = appData.history.map(h => {
    const duration = h.completedAt - h.startedAt;
    return `
      <div class="history-card">
        <div class="history-card-header">
          <h3>${escHtml(h.templateName)}</h3>
        </div>
        <div class="history-card-meta">
          <span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            ${h.stepsDone}/${h.stepsTotal} 步骤
          </span>
          <span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${formatDate(h.startedAt)}
          </span>
          <span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/></svg>
            ${formatDuration(duration)}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

// ============ 徽章更新 ============
function updateBadge() {
  const count = appData.instances.filter(i => i.status === 'running').length;
  const badge = document.getElementById('running-badge');
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ============ 工具函数 ============
function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function escAttr(s) {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function replaceVars(text, vars) {
  return text.replace(/\{\{(.+?)\}\}/g, (_, key) => vars[key] || `{{${key}}}`);
}

function highlightVariables(text) {
  return text.replace(/\{\{(.+?)\}\}/g, '<span class="variable-value">{{$1}}</span>');
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours} 小时 ${remainMins} 分钟` : `${hours} 小时`;
}

// ============ 初始化 ============
loadData().then(() => {
  renderTemplates();
  updateBadge();
});
