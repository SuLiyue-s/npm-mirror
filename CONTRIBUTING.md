# 参与开发

感谢你关注这个项目。它是一个**零第三方依赖、无构建步骤**的单进程 npm 镜像源，改动门槛很低，但有一些必须遵守的约定，请先读完本文再提交。

## 环境准备

- Node.js **>= 18**（开发与测试用 Node.js 24）
- Windows / macOS / Linux 均可运行服务本体；一键脚本（`.cmd` / `acceptance-npm.ps1`）仅面向 Windows
- 不需要 `npm install`（项目没有依赖），克隆后即可运行

```bash
git clone https://github.com/SuLiyue-s/npm-mirror.git
cd npm-mirror
node cli.js init      # 生成 data/config.json（含访问令牌，data/ 不入库）
node cli.js start     # 启动服务，默认 http://127.0.0.1:4873
```

## 设计约定（重要）

1. **保持零依赖**：`dependencies` / `devDependencies` 必须为空。新增任何运行时依赖都需要先在 issue 中讨论并说明理由。
2. **无构建步骤**：前端是原生 HTML/CSS/JS（`public/`），不要引入打包器、框架或 TypeScript。
3. **单进程、文件存储**：不引入数据库、消息队列、Redis 等外部服务。
4. **CommonJS**：后端统一 `require` / `module.exports`，入口 `cli.js`，服务端 `src/server.js`。
5. **错误要可诊断**：抛出的错误带 `status` 与 `code`（例如 `EBADNAME`、`ETOOLARGE`、`EINTEGRITY`），由 `src/server.js` 的 `CODE_STATUS` 映射为 HTTP 状态码。
6. **安全优先**：一切来自网络或磁盘的输入都视为不可信——包名、版本、文件名、tgz 内 `package.json`、bundle 清单、上游响应都要校验（参考 `src/util.js` 的 `isSafePkgName` / `isSafeVersion` 与 `src/store.js` 的 `isInside`）。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `cli.js` | 命令行入口、进程管理、`use/unuse` 等本机操作 |
| `src/server.js` | HTTP 服务、静态页面、安全响应头、路由分发、错误映射 |
| `src/registry.js` | npm registry 协议（安装/发布/弃用/dist-tag/搜索/审计、tarball 下载） |
| `src/api.js` | 管理端 API `/__admin/api/*` |
| `src/auth.js` | 令牌提取与鉴权 |
| `src/upstream.js` | 上游请求：超时、重试、重定向逐跳校验、SSRF 防护、完整性校验 |
| `src/store.js` | 包存储与索引（元数据 + tarball，原子写、路径包含校验） |
| `src/tar.js` | 纯 Node 实现的 tar.gz 打包/解包 |
| `src/bundle.js` | 离线 bundle 导出/导入 |
| `src/npmcache.js` | 本机 npm 缓存扫描/导入 |
| `src/deps.js` / `src/pull.js` / `src/tasks.js` | 依赖解析、批量补包任务、后台任务表 |
| `src/config.js` | 配置读写、字段白名单与校验 |
| `src/http-util.js` | body 读取、Range、静态文件、Host/Origin 校验 |
| `src/util.js` | semver、原子写、包名/版本/path 校验等公共函数 |
| `public/` | 管理界面（`app.js` / `index.html` / `style.css`） |
| `test/` | 自动化测试与验收脚本 |

## 提交前自检

```bash
# 1. 语法检查（全部 JS）
Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }

# 2. 服务端 + npm 协议全量测试（需先启动服务）
node cli.js start
node test/api-test.js

# 3. 前端静态契约检查
node test/ui-check.js

# 4. 真实 npm 客户端验收（Windows / PowerShell 7，可选）
pwsh -File test/acceptance-npm.ps1
```

- 测试必须 **0 失败**；`test/api-test.js` 默认会跳过破坏性用例（重启服务、清空日志），确认隔离环境后可加 `--destructive` 执行。
- 新增或修改测试时，**不允许删除用户数据**：涉及清理的用例要先用 `--destructive` 门控，或改到专用测试包、临时目录，并在 `finally` 中恢复。
- 临时脚本请放 `tmp/`（已 gitignore）或系统临时目录，提交前清理。

## 代码风格

- 2 空格缩进、LF 换行、UTF-8 无 BOM、文件末尾留空行（`.editorconfig` 已约定；`.cmd` / `.ps1` 用 CRLF）
- `'use strict';` + 顶部按「内置模块 → 本地模块」分组 `require`
- 用户可见文案、日志、注释统一使用**中文**
- 不写阻塞请求热路径的同步 IO；配置、日志初始化等启动期操作除外
- 不提交 `data/`、`*.log`、`node_modules/`、令牌及任何运行时产物

## 提交信息

使用简短的中文祈使句，一次提交只做一件事，建议加类型前缀：

```text
feat: 支持 dist-tag 合并
fix: 修复 tarball 路由反斜杠路径穿越
docs: 补充离线迁移流程
test: 新增 Origin:null 安全回归
chore: 忽略 tmp/ 目录
```

功能或命令变更请同步更新：`README.md`、`使用说明.md`、`CHANGELOG.md`（必要时 `报告.md` 的验收记录）。

## 分支与 PR

- 从 `master` 切分支（如 `fix/tarball-path`），完成后对 `master` 发 Pull Request
- PR 说明写清：改了什么、为什么、如何验证（附测试命令与结果）
- 不要 force-push 已推送的 `master`；历史尽量保持线性可读

## 许可

提交的代码默认以 [MIT](LICENSE) 许可发布。
