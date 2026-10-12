# v1.1 本地构建与验证

本项目使用 Electron 和 electron-builder；本轮只做本地提交和本机构建，不推送、不创建 Release。

## 1. 环境与常规命令

本次验证环境：Windows 11 x64（10.0.26100）、Node.js 24.18.0、Electron 35.7.5、electron-builder 26.8.1。

在项目根目录执行：

```powershell
npm install
npm test
npm start
npm run build
# 可选：仅构建便携包
npm run build:portable
```

- `npm test` 使用 `node --test` 自动发现测试，不需要安装测试框架。
- [CI 配置](<../.github/workflows/node.js.yml>) 在 Ubuntu、Node 18 / 20 / 22 上安装依赖、检查 JS 语法和运行测试。本轮没有推送，因此没有远程 CI 通过记录；该配置不承担 Windows 打包。
- 本次 `npm install` 成功；审计有 22 项漏洞（4 moderate、17 high、1 critical）。没有运行 `npm audit fix --force`，也没有为了掩盖报告而删除依赖。
- [依赖配置](<../package.json>) 的实际打包器是 electron-builder；原有 electron-packager 开发依赖仍保留，未做额外依赖迁移。

## 2. Electron 被宿主误以 Node 模式启动

某些开发宿主会设置 `ELECTRON_RUN_AS_NODE=1`。此时 `require('electron')` 不提供应用运行时的 `app`，启动可能报：

```text
TypeError: Cannot read properties of undefined (reading 'getPath')
```

先在当前终端清除变量，然后启动：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm start
```

如果宿主仍向进程注入变量，使用显式子进程环境。以下示例隔离业务数据，不影响日常目录：

```powershell
$project = (Get-Location).Path  # 必须在项目根目录运行
$testData = Join-Path $env:TEMP ('sop-manual-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testData | Out-Null
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = Join-Path $project 'node_modules\electron\dist\electron.exe'
$psi.WorkingDirectory = $project
$psi.Arguments = '. --user-data-dir="' + (Join-Path $testData 'profile') + '"'
$psi.UseShellExecute = $false
$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$psi.EnvironmentVariables['SOP_DATA_DIR'] = $testData
$process = [System.Diagnostics.Process]::Start($psi)
Write-Output "PID=$($process.Id); isolated data=$testData"
```

日常运行不要开放远程调试端口。本轮 CDP 仅用于本机验收，结束后关闭测试应用。

## 3. 本次 Windows 构建的环境绕行

本机默认构建先后遇到两个环境问题，不应写成“无参数构建已经通过”：

1. 访问 GitHub 的 Electron / winCodeSign 下载连接被代理重置；直接访问也超时。
2. 成功下载 winCodeSign 后，解包其中的 Darwin `.dylib` 符号链接报 `ERROR: Cannot create symbolic link`，当前 Windows 权限不允许创建。

本次实际成功命令：

```powershell
npm run build -- --config.electronDist=node_modules/electron/dist --config.win.signAndEditExecutable=false
```

- `electronDist` 复用已经安装的 Electron 35.7.5，避免再次下载同一运行时。
- `signAndEditExecutable=false` 适用于本次本地未签名验收，绕过资源编辑工具提取；不是生产发布的签名方案。
- 本次产物使用默认 Electron 图标，Windows 文件资源信息可能仍体现运行时默认值。

若同样被代理阻断，本次还在**单个构建进程环境**内清除了 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NODE_USE_ENV_PROXY`，并设置：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
```

该镜像是可选的第三方下载源，不是项目必须依赖；不应把当前环境的网络绕行持久写入系统代理设置。使用适合自己网络的下载源，正式发布前验证依赖来源与签名。

## 4. 产物与独立启动

[构建配置](<../package.json>) 生成 Windows x64 的：

- [便携包](<../dist/SOP工作流 1.1.0.exe>)；
- [NSIS 安装包](<../dist/SOP工作流 Setup 1.1.0.exe>)；
- [安装包 blockmap](<../dist/SOP工作流 Setup 1.1.0.exe.blockmap>)；
- `dist/win-unpacked/` 解包输出。

这些输出被 Git 忽略，不提交仓库。便携包验证必须从项目目录外启动，不能用项目的 Electron 代替：

```powershell
# 把 $portable 设为便携包绝对路径；下面只修改这个子进程环境。
$portable = 'E:\Project coding\sop-workflow\dist\SOP工作流 1.1.0.exe'
$testData = Join-Path $env:TEMP ('sop-portable-' + [guid]::NewGuid().ToString('N'))
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $portable
$psi.WorkingDirectory = $env:TEMP
$psi.UseShellExecute = $false
$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$psi.EnvironmentVariables['SOP_DATA_DIR'] = $testData
[System.Diagnostics.Process]::Start($psi)
```

本次已验证便携包从外部工作目录启动、创建与保存、关闭保存确认、重启数据和窗口最大化状态恢复、原生 JSON 导入导出。安装包仅验证生成及校验值，没有实际安装或卸载。

## 5. 验证层次与安全边界

1. **纯逻辑**：[进度测试](<../test/progress.test.js>)、[实例测试](<../test/instance-service.test.js>)、[模板测试](<../test/template-service.test.js>)、[工具测试](<../test/utils.test.js>)、[数据测试](<../test/data-store.test.js>)。
2. **真实旧版格式**：[迁移测试](<../test/migration.test.js>) 使用基线提交 `253813d` 实际字段，不伪造不存在的旧格式。
3. **持久化与 IPC**：[持久化测试](<../test/persistence.test.js>) 在临时目录使用真实文件系统、替身 Electron、故障注入，覆盖写入 / fsync / 备份 / rename / 清理失败和恢复。
4. **控制器竞态**：[渲染控制器测试](<../test/renderer.test.js>) 使用 `node:vm`、轻量 DOM 和 IPC 替身，覆盖重试、并行保存、备注归属、关闭保护、快捷键；不是 Chromium E2E。
5. **真实应用**：本轮对源码 Electron 和实际便携包走查关键流程，保存截图及磁盘结果。截图留档不等于全分辨率视觉验收。

全部破坏性验收仅针对临时 `SOP_DATA_DIR`。禁止用真实用户目录做损坏 / 删除实验。故障恢复检查时先关闭应用，保留主文件副本，确认至少一个有效备份后再破坏测试主 JSON，重启应显示“已从备份恢复”。恢复加载不应悄悄覆盖损坏原件。

详细结果、SHA-256、局限与发布前风险见 [验收报告](<V1.1-VALIDATION-REPORT.md>)。
