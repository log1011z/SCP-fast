# 开发与发布

## 环境与目录

在 Windows x64 上开发和打包。需要 Node.js 20+、npm、Windows OpenSSH 9.0+，以及 .NET Framework 4.x C# 编译器。

| 目录 | 内容 |
| --- | --- |
| `src/` | VS Code 扩展、SSH 配置、认证、队列、传输及界面 |
| `native/` | Windows askpass 辅助程序源码 |
| `scripts/` | 构建、测试及可选性能对比脚本 |
| `tests/` | 回环 SSH/SFTP 夹具与精简队列场景 |
| `docs/` | 开发说明、验证记录及归档结果 |
| `bin/`、`dist/` | 自动生成的辅助程序与扩展构建结果 |
| `artifacts/` | 当前版本 VSIX 安装包 |
| `test-results/` | 可删除的测试临时文件，不纳入 Git |

源码和锁文件纳入 Git；依赖、构建结果、安装包和测试临时文件通过 `.gitignore` 排除。VSIX 仅包含运行文件、使用说明、更新记录和许可证。

## 构建与验证

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run package
```

`package` 自动执行 TypeScript 检查、辅助程序编译和扩展构建。输出为 `artifacts/scp-fast-1.1.1-win32-x64.vsix`。单独检查可执行 `npm.cmd run check`；在 VS Code 中按 F5 启动本地扩展开发窗口。

测试保持精简：真实 Windows scp 回环上传／下载、密码及验证码认证，以及一个队列场景验证覆盖保护、失败清理、取消和重试。VS Code 输入框使用测试替身；这些测试不代表真实 Remote-SSH 窗口已验收。

文件夹下载另外覆盖一个场景：实际 scp 下载中文嵌套目录中的文件、空目录保留、链接元数据跳过、扫描取消、本机目标文件保护，以及目录失败后的子任务重试。`src/download.ts` 负责只读清单扫描和本机目录准备，文件内容继续走原有传输引擎。

`src/records.ts` 将内部执行任务按批次和顶层文件夹汇总。队列及持久化只保留顶层记录，内部成员用于恢复和重试，不作为子节点显示。精简检查另覆盖整体进度、整夹取消／重试、活动记录保护及新旧历史恢复。

## 可选性能对比

已有数据在 `docs/validation/benchmark.json`；无需每次发布都传输大文件。需要复测时，先运行 `npm.cmd test` 生成测试入口，再执行：

```powershell
node scripts/benchmark-download.mjs user@host 22 /absolute/path/file.zip
```

该脚本需要无需人工输入的 SSH 认证，仅读取远端指定文件，分别下载两次到 `test-results/performance/`，记录原生 scp 和插件传输核心的相邻测量结果。它用 SSH `stat` 读取远端元数据，不测量 VS Code 窗口、编辑或终端响应。结束后可删除下载副本，保留需要的结果 JSON。

## 发布约定

同时更新 `package.json` 与 `package-lock.json` 的版本号、VSIX 输出文件名、README 的安装文件名和 CHANGELOG。通过精简检查后生成安装包，提交源码并创建同名版本标签，例如 `v1.0.0`。

当前发布形式为本地 VSIX 和本地 Git 标签。上传 GitHub Release 或 VS Code Marketplace 时，需要配置对应远端仓库或发布者账号；当前工程未配置这些发布目标。
