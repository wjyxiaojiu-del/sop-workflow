# SOP Workflow 优化实施方案

## 1. 文档目的

本文档用于交给 dsh 执行 `sop-workflow` 项目的第一轮产品和工程升级。

项目目录：`E:\Project coding\sop-workflow`

当前技术栈：Electron + 原生 HTML/CSS/JavaScript + 本地 JSON 文件。

当前基线：仓库可以创建 SOP 模板、编辑多步骤和子步骤、插入变量、生成流程图、启动执行实例、记录历史，但子步骤没有独立执行状态，数据保存没有备份和恢复机制。

## 2. 产品定位

将项目定位为“个人本地 SOP 执行工具”，服务于研究、学习、开发和重复事务。

核心闭环：

1. 创建一个可复用的 SOP 模板；
2. 从模板启动一次执行实例；
3. 按步骤和子步骤完成任务；
4. 中途关闭后可以恢复；
5. 完成后留下可追溯历史；
6. 复制旧模板，快速建立下一套流程。

第一阶段只面向单机个人使用，不做账号、云同步、多人协作、权限系统、在线模板市场和移动端。

## 3. 总体目标

### 必须达到

- 子步骤可以单独勾选，进度统计准确；
- 执行实例支持继续、暂停、完成和放弃；
- 应用关闭后再次打开，未完成实例仍然存在；
- 数据采用安全写入，主文件损坏时可以从备份恢复；
- 支持 JSON 导出和导入；
- 模板支持复制、分类、标签、收藏和搜索；
- 修改模板不会影响已经开始的执行实例；
- Windows 打包后可以独立启动。

### 不属于本轮目标

- 不接入数据库；
- 不接入云服务或登录；
- 不引入 React、Vue 等前端框架；
- 不做 AI 自动生成 SOP；
- 不重写为多人项目管理工具；
- 不为了视觉效果大规模重写现有功能。

## 4. 执行顺序

按以下阶段顺序实施，每阶段完成后单独验证并提交一次 Git commit。

### Phase 0：建立基线

任务：

- 阅读 `README.md`、`package.json`、`main.js`、`preload.js`、`renderer.js`、`index.html`、`styles.css`；
- 保留当前 `master` 分支，不覆盖用户已有修改；
- 执行 `npm install`；
- 执行 `npm start`，确认应用可以启动；
- 记录当前页面和核心交互是否正常；
- 创建本地分支：`feat/sop-workflow-v1.1`。

验收：

- 应用可以启动；
- 新建模板、编辑模板、启动实例、完成实例、查看历史均可运行；
- 基线结果写入 dsh 的执行记录。

### Phase 1：数据模型和安全持久化

涉及文件：`main.js`、`preload.js`、`renderer.js`。

#### 1.1 统一数据结构

初始化数据必须经过 `normalizeData()`，兼容旧版本缺失字段。

模板结构：

```js
{
  id: "...",
  name: "文献精读",
  desc: "...",
  category: "科研",
  tags: ["文献", "精读"],
  favorite: false,
  version: 1,
  steps: [
    {
      id: "step-1",
      title: "确认文章信息",
      note: "记录 DOI 和研究对象",
      subSteps: [
        { id: "sub-1", title: "记录 DOI", done: false },
        { id: "sub-2", title: "记录实验对象", done: false }
      ]
    }
  ],
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null
}
```

执行实例结构：

```js
{
  id: "...",
  templateId: "...",
  templateVersion: 1,
  templateName: "文献精读",
  variables: {},
  steps: [],
  status: "running",
  startedAt: 0,
  updatedAt: 0,
  completedAt: null,
  elapsedMs: 0,
  executionNotes: ""
}
```

历史记录结构：

```js
{
  id: "...",
  instanceId: "...",
  templateId: "...",
  templateName: "文献精读",
  status: "completed",
  startedAt: 0,
  completedAt: 0,
  elapsedMs: 0,
  stepsTotal: 0,
  stepsDone: 0,
  completionRate: 0
}
```

#### 1.2 安全保存

`main.js` 中禁止继续使用直接覆盖正式文件的单步写入。实现：

1. 确保 `userData` 目录和 `backups` 子目录存在；
2. 将 JSON 写入 `sop-data.json.tmp`；
3. 使用 UTF-8 写入并完成关闭；
4. 先将现有 `sop-data.json` 复制到备份目录；
5. 将临时文件替换为正式文件；
6. 只保留最近 3 个备份；
7. 保存失败时返回错误，不在渲染进程中假装成功。

#### 1.3 启动恢复

- 主文件不存在：创建空数据；
- 主文件格式正确：正常加载；
- 主文件损坏：尝试读取最近备份；
- 备份也无法读取：返回空数据并显示明确错误；
- 恢复成功后，界面显示“已从备份恢复”的提示。

#### 1.4 导入和导出

新增 IPC：

```text
export-data
import-data
get-data-file-info
```

导出内容包括模板、执行实例、历史记录和导出版本号。导入时必须先校验结构，再让用户选择：

- 合并到当前数据；
- 用导入数据覆盖当前数据。

导入前自动创建一次备份。

### Phase 2：执行模型升级

涉及文件：`renderer.js`、`index.html`、`styles.css`。

#### 2.1 统一进度计算

新增纯函数：

```js
calculateProgress(instance)
getAllChecklistItems(instance)
isStepComplete(step)
```

规则：

- 没有子步骤的顶层步骤计为一个任务项；
- 有子步骤的顶层步骤按子步骤计数；
- 所有子步骤完成后，顶层步骤自动完成；
- 顶层步骤取消完成时，至少保留子步骤真实状态；
- 所有页面禁止自行重复计算进度。

#### 2.2 执行状态

状态固定为：

```text
running / paused / completed / abandoned
```

行为：

- 开始执行：创建 `running` 实例；
- 暂停：保留实例，不写入历史；
- 继续：恢复 `running`；
- 完成：写入历史并移出活动实例；
- 放弃：从活动实例移除，但保留一条 abandoned 历史记录。

#### 2.3 执行页面

保留流程图作为查看模式，增加清单执行模式。执行页应包含：

- 模板名称和当前实例状态；
- 总体进度；
- 可勾选的顶层步骤；
- 可勾选的子步骤；
- 当前步骤备注；
- “暂停”“完成”“放弃”按钮；
- 执行备注输入框。

单击步骤后立即保存。保存失败时显示错误提示，并保留当前页面状态。

#### 2.4 模板快照

启动实例时复制完整步骤结构，不再实时引用模板对象。模板后续编辑不得改变已启动实例。

### Phase 3：模板管理升级

涉及文件：`renderer.js`、`index.html`、`styles.css`。

#### 3.1 复制模板

详情页增加“复制模板”，复制名称默认为“原名称 - 副本”，复制后进入编辑状态。

#### 3.2 分类、标签和收藏

模板编辑表单增加：

- 分类下拉框：科研、学习、开发、生活、其他；
- 标签输入框，使用逗号分隔；
- 收藏开关。

首页支持：

- 全部模板；
- 收藏模板；
- 按分类筛选；
- 最近使用排序。

#### 3.3 搜索

搜索范围包括模板名称、描述、标签、步骤标题、步骤备注和子步骤内容。搜索结果为空时显示搜索词和“新建模板”入口。

#### 3.4 模板编辑体验

- 添加步骤后自动聚焦步骤名称；
- 删除步骤前确认；
- 支持步骤上移和下移；
- 支持子步骤上移和下移；
- 编辑弹窗按 `Esc` 关闭；
- `Ctrl+S` 保存；
- 表单保存失败时保留输入内容。

### Phase 4：首页和界面优化

不改变现有整体风格，先优化信息层级。

首页结构：

1. 顶部搜索、新建模板、导入、导出；
2. 正在执行卡片；
3. 收藏和最近使用模板；
4. 全部模板；
5. 最近完成记录。

执行中卡片必须显示：

- 模板名称；
- 当前进度；
- 开始时间；
- 上次更新时间；
- 继续执行按钮。

空状态必须说明下一步操作，例如“还没有 SOP，先创建一个模板”。

状态颜色统一：

- running：蓝色；
- paused：橙色；
- completed：绿色；
- abandoned：灰色；
- error：红色。

避免只依赖颜色表达状态，必须同时显示文字和图标。

### Phase 5：快捷键和桌面体验

实现以下快捷键：

```text
Ctrl+N  新建模板
Ctrl+F  聚焦搜索框
Ctrl+S  保存当前模板
Esc     关闭弹窗
Space   完成当前聚焦步骤
```

窗口行为：

- 关闭前如果有未保存编辑，提示保存或放弃；
- 启动时恢复窗口大小和最大化状态；
- 重要操作使用非阻塞 toast，不大量使用 `alert()`；
- 所有按钮有明确 hover、focus 和 disabled 状态；
- 键盘 Tab 顺序可用。

## 5. 工程质量要求

### 5.1 代码结构

当前 `renderer.js` 较长，第一轮不必拆成框架，但应按职责拆出以下模块或区域：

- `data-store.js`：数据规范化和保存调用；
- `progress.js`：进度计算；
- `template-service.js`：模板 CRUD、复制和搜索；
- `instance-service.js`：执行实例状态变更；
- `render.js`：页面渲染；
- `utils.js`：转义、日期、变量处理。

如果 dsh 判断拆文件会增加风险，可以先在 `renderer.js` 中使用清晰的函数边界完成，第二轮再拆分。

### 5.2 安全边界

- 保持 `contextIsolation: true`；
- 保持 `nodeIntegration: false`；
- preload 只暴露必要的白名单 API；
- 所有用户输入进入 HTML 前必须经过 `escHtml` 或 `escAttr`；
- 不允许从渲染进程直接访问文件系统；
- IPC 对导入数据进行结构校验。

### 5.3 错误处理

所有异步保存都必须使用 `try/catch`。保存失败时：

- 不清空用户输入；
- 不切换页面；
- 显示可理解的错误信息；
- 在控制台记录技术错误；
- 允许用户重试。

## 6. 验收测试

### 功能验收

- 新建、编辑、复制、删除模板；
- 模板包含 3 个顶层步骤；
- 一个步骤包含 3 个子步骤；
- 子步骤逐个完成后进度正确；
- 变量可以出现在标题、备注和子步骤中；
- 启动实例后修改模板，旧实例内容不改变；
- 实例暂停后重启应用，可以继续；
- 完成实例后历史记录有正确的耗时和完成率；
- 放弃实例后状态可追溯；
- 导出后删除本地数据，再导入可以恢复；
- 人为破坏主 JSON 后，可以从备份恢复。

### 工程验收

```powershell
npm install
npm start
npm run build
```

还要检查：

- `npm run build` 能生成 Windows 安装包或 portable 包；
- 打包后的程序能独立启动；
- Git 工作区没有无关临时文件；
- README 与实际功能一致；
- dsh 每个阶段提交一个清晰 commit。

## 7. 推荐提交拆分

```text
chore: establish sop workflow baseline
feat: add normalized data model and safe persistence
feat: make substeps executable and track progress
feat: add instance pause resume and template snapshots
feat: add template duplicate categories tags and search
feat: add import export and backup recovery
feat: improve dashboard and execution experience
test: add workflow regression checks
docs: update README and release instructions
```

## 8. dsh 执行规则

- 先执行 Phase 0，不要直接重写全部界面；
- 每个 Phase 完成后运行对应验收，不通过就先修复；
- 不删除现有用户数据格式，必须提供兼容迁移；
- 不引入新框架，除非先说明必要性和迁移成本；
- 不修改个人主页项目描述，除非功能已经实际完成并验证；
- 不自动推送 GitHub，不创建 Release，除非得到单独授权；
- 最终报告必须列出：完成项、未完成项、测试结果、生成文件、剩余风险。

## 9. 最小可交付版本

如果时间有限，至少完成以下内容：

1. 子步骤可勾选；
2. 进度统一计算；
3. 执行实例暂停和恢复；
4. 模板复制；
5. 安全保存和自动备份；
6. JSON 导入导出；
7. Windows 构建验证。

完成这七项后，项目才具备稳定的日常使用价值。分类、统计、快捷键和视觉细节可以在第二轮继续做。
