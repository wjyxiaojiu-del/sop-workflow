# SOP 工作流

一个轻量级的桌面 SOP（标准操作流程）管理工具，帮助你创建、复用和跟踪任务流程。

## 功能特性

- **SOP 模板管理** - 创建、编辑、删除 SOP 模板，支持多步骤 + 子步骤
- **流程图可视化** - 将 SOP 步骤以流程图形式直观展示
- **变量系统** - 在步骤中使用 `{{变量名}}` 占位符，执行时填写，实现模板复用
- **执行跟踪** - 从模板创建执行实例，逐步勾选完成，实时进度条
- **历史记录** - 自动记录已完成的 SOP 及耗时统计
- **本地存储** - 数据保存在本地，无需联网，无需账号

## 使用方式

### 直接运行（推荐）

1. 到 [Releases](https://github.com/wjyxiaojiu-del/sop-workflow/releases) 下载打包好的版本
2. 解压后双击 `SOP工作流.exe` 即可运行

### 从源码运行

```bash
# 克隆仓库
git clone https://github.com/wjyxiaojiu-del/sop-workflow.git
cd sop-workflow

# 安装依赖
npm install

# 启动应用
npm start
```

### 打包为可执行文件

```bash
npm install
npx electron-packager . "SOP工作流" --platform=win32 --arch=x64 --out=dist
```

打包产物在 `dist/SOP工作流-win32-x64/` 目录下。

## 快速上手

1. 点击左侧 **「新建 SOP 模板」** 创建一个流程模板
2. 填写步骤名称和备注，支持添加子步骤
3. 在步骤名称中使用 `{{变量名}}` 插入变量（如 `{{服务器地址}}`）
4. 保存后在模板库中点击模板查看详情
5. 点击 **「开始执行」**，填写变量后进入执行模式
6. 在流程图中点击节点勾选完成步骤

## 技术栈

- **Electron** - 跨平台桌面应用框架
- **HTML / CSS / JavaScript** - 原生前端，无额外框架依赖
- **本地 JSON 文件** - 数据持久化存储

## 许可证

MIT
