# 私人 npm 镜像源（离线版）

**零第三方依赖、可离线迁移的私人 npm 镜像源**：本地缓存公共包 + 私有包仓库 + 中文可视化管理界面 + 离线 bundle 导出导入，一个 Node.js 进程跑起来，不需要数据库、不需要构建、不需要联网安装依赖。

- 运行环境：Node.js **>= 18**（实测 Node.js 24），Windows / macOS / Linux 均可运行服务本体（一键脚本为 Windows `.cmd` / PowerShell）
- 默认地址：<http://127.0.0.1:4873>（管理界面同地址）
- 依赖数量：**0**（`dependencies` 与 `devDependencies` 均为空）
- 许可证：[MIT](LICENSE)

![管理界面概览](截图/管理界面-概览.png)

## 它能做什么

- **公共包缓存**：`npm install` 走本镜像时自动回源上游（默认 `https://registry.npmmirror.com`）并缓存元数据与 tarball；支持 `cache`（本地优先）/ `proxy`（过期即回源）/ `offline`（纯离线）三种模式
- **私有包仓库**：支持 `npm publish`、`npm unpublish`、`npm deprecate`、`npm dist-tag`，私有包与上游同名包隔离，不会混淆
- **离线迁移**：导出整个镜像为单个 `.tgz` bundle，拷贝到无网络电脑后导入；也支持直接导入本机 `~/.npm/_cacache` 已有缓存。**导出和导入都有详细进度弹窗**：一条总进度（导出按字节/文件数，导入按解包字节与包数）+ 逐包明细（已打包 / 新增 / 失败 / 跳过）+ 当前包的大进度条，长任务可取消
- **可视化管理界面**：概览、包管理、迁移备份（含本机缓存导入）、配置、日志、服务控制共 6 个页面，中文界面，全按钮操作；包详情、依赖解析、任务进度以抽屉/弹窗呈现
- **补齐工具链**：按版本 / 只补最新 / 全部包批量补 tarball，递归添加依赖（含 `npm:` 别名），后台任务可看进度、可取消
- **零依赖实现**：HTTP 服务、tar.gz 打包解包、semver 比较、npm 协议、断点与完整性校验全部手写，无任何第三方包

## 快速开始

```bash
# 1. 获取代码（本仓库不包含 data/ 运行时数据）
git clone https://github.com/SuLiyue-s/npm-mirror.git
cd npm-mirror

# 2. 初始化配置（生成 data/config.json 与访问令牌）
node cli.js init

# 3. 启动镜像源（默认 http://127.0.0.1:4873，会自动打开管理界面）
node cli.js start
```

也可以在 Windows 上直接双击 **`启动镜像源.cmd`**。

> 首次启动后，管理界面的「配置」页与 `data/config.json` 里都能看到访问令牌（`security.token`）。

## 让项目用上这个镜像源

全局切换（会自动备份原 `~/.npmrc`，可随时还原）：

```bash
node cli.js use       # 把 npm 源切到本镜像
node cli.js unuse     # 还原为切换前的源
```

或只给单个项目配置 `.npmrc`：

```ini
registry=http://127.0.0.1:4873/
//127.0.0.1:4873/:_authToken=<你的访问令牌>
```

> 本机回环访问默认免令牌（`security.trustLocalhost: true`）；局域网共享或需要严格鉴权时，在配置里开启 `requireRead` / `requirePublish` 并分发令牌。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `node cli.js start [--port 4873] [--mode cache\|proxy\|offline] [--no-open]` | 启动服务 |
| `node cli.js stop` / `restart` / `status` / `open` | 停止 / 重启 / 查看状态 / 打开管理界面 |
| `node cli.js init` / `config [--reveal]` / `token` | 初始化配置 / 查看配置（含明文令牌）/ 显示令牌 |
| `node cli.js use [--project]` / `unuse` | 切换本机 npm 源 / 还原 |
| `node cli.js list [--q 关键字] [--source all\|upstream\|private\|upload\|cache]` | 列出本地包 |
| `node cli.js add <包名[@版本]> [--with-deps] [--depth 8] [--limit 300]` | 添加公共包（可递归依赖） |
| `node cli.js remove <包名> [--version 1.2.3] [--yes]` | 删除包或单个版本 |
| `node cli.js stats` | 统计包 / 版本 / 占用空间 |
| `node cli.js export [--scope all\|private\|upstream] [--out 文件名] [包名...]` | 导出离线 bundle |
| `node cli.js import <文件.tgz\|文件.json> [--overwrite]` | 导入离线 bundle |
| `node cli.js scan-cache [--cache 目录] [--any-registry] [--refresh]` | 扫描本机 npm 缓存 |
| `node cli.js import-cache [--all] [--overwrite] [包名...]` | 从本机 npm 缓存导入 |
| `node cli.js doctor` / `logs [--lines 100] [--level info]` | 环境自检 / 查看日志 |
| `node cli.js autostart on\|off\|status` | 开机自启（写入「启动」文件夹，无需管理员） |

完整参数与界面操作见 **[使用说明.md](使用说明.md)**。

## 离线迁移流程

```bash
# 有网电脑：导出整个镜像（单个 .tgz，含全部包与元数据）
node cli.js export --scope all --out npm-mirror-all.tgz

# 拷贝 npm-mirror-all.tgz 到无网络电脑后：
node cli.js init          # 首次使用先初始化
node cli.js start         # 启动服务
# 然后打开管理界面「迁移备份」页导入，或执行：
node cli.js import npm-mirror-all.tgz
```

> 导入/导出不依赖服务运行；离线机器建议把 `mode` 设为 `offline`，或把 `upstream.registry` 指向内网可达的源。

## 运行模式

| 模式 | 行为 |
| --- | --- |
| `cache`（默认） | 本地优先；本地没有或手动刷新时才回源，回源结果缓存到本地 |
| `proxy` | 元数据超过 `upstream.metadataTtlSec` 就回源更新；tarball 仍缓存 |
| `offline` | 完全离线，不回源；未缓存的内容直接 404 |

## 配置说明（`data/config.json`）

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `server.ip` / `server.port` | `127.0.0.1` / `4873` | 监听地址与端口 |
| `mode` | `cache` | `cache` / `proxy` / `offline` |
| `upstream.registry` | `https://registry.npmmirror.com` | 上游公共源 |
| `upstream.timeoutMs` / `retries` | `30000` / `2` | 回源超时与重试次数 |
| `upstream.metadataTtlSec` | `300` | 元数据回源缓存时长（秒） |
| `upstream.concurrency` / `maxTarballMB` | `6` / `512` | 并发下载数 / 单个 tarball 上限（MB） |
| `security.token` | 随机生成 | 访问令牌（**不要提交到仓库**） |
| `security.requirePublish` / `requireRead` | `true` / `false` | 发布 / 读取是否需要令牌 |
| `security.trustLocalhost` | `true` | 本机回环地址免令牌 |
| `storage.dir` / `storage.maxUploadMB` | `data/storage` / `500` | 包存储目录 / 单包上传上限（MB，1-4096） |
| `storage.maxBundleUploadMB` | `4096` | 网页上传整机备份（离线包）的上限（MB，1-65536）。上传走流式落盘，不占内存；更大的包可放进 `data/bundles` 后用界面「导入」 |
| `log.level` / `log.maxDays` | `info` / `7` | 日志级别 / 保留天数 |
| `ui.title` | `私人 npm 镜像源` | 管理界面标题 |

当前生效配置可随时在管理界面「配置」页查看与修改；令牌只能通过「重置令牌」轮换。

## 目录结构

```text
npm私人镜像源-离线版/
├─ cli.js                 命令行入口（start/stop/init/export/import/use ...）
├─ src/
│  ├─ server.js           HTTP 服务与静态页面
│  ├─ registry.js         npm registry 协议（安装/发布/取消发布/搜索/dist-tag/审计）
│  ├─ api.js              管理端 API（/__admin/api/*）
│  ├─ auth.js             令牌鉴权
│  ├─ upstream.js         上游请求（超时、重试、重定向校验、完整性校验）
│  ├─ store.js            包存储与索引（元数据 + tarball）
│  ├─ tar.js              纯 Node 实现的 tar.gz 打包 / 解包
│  ├─ bundle.js           离线 bundle 导出 / 导入
│  ├─ npmcache.js         本机 npm 缓存扫描 / 导入
│  ├─ deps.js             递归依赖解析
│  ├─ pull.js             批量补包任务
│  ├─ tasks.js            后台任务表
│  ├─ config.js           配置读写与字段校验
│  ├─ http-util.js        HTTP 工具（body/Range/静态文件/安全头）
│  ├─ logger.js           日志
│  └─ util.js             工具函数（semver、原子写、包名/版本校验等）
├─ public/                原生前端（app.js / index.html / style.css）
├─ test/                  自动化测试与验收脚本
├─ data/                  运行时数据（包存储/日志/配置/离线包，已 gitignore）
├─ 使用说明.md            详细操作手册
├─ 报告.md                开发过程与验收记录
├─ 启动镜像源.cmd 等       Windows 一键脚本
└─ 截图/                  界面截图
```

## 测试与验收

先启动服务，然后：

```bash
node test/run-all.js                 # 一键自检（等价于 node test/api-test.js）
node test/ui-check.js                # 前端静态契约检查
pwsh -File test/acceptance-npm.ps1   # 真实 npm 客户端验收（Windows / PowerShell 7）
```

| 脚本 | 内容 | 最近结果（2026-10-17，本机） |
| --- | --- | --- |
| `test/api-test.js` | npm 协议、管理接口、发布/删除、离线导入导出、进度任务、安全回归等 172 项 | **168 通过 + 4 跳过，0 失败** |
| `test/ui-check.js` | 前端与后端接口/页面元素契约 | **74/74 通过** |
| `test/acceptance-npm.ps1` | 真实 `npm install / publish / dist-tag / deprecate / unpublish` | **16/16 通过** |
| `test/ui-e2e-*.js` | 浏览器端端到端（需要 Chrome 调试端口，可选） | 需本机 Chrome CDP 环境 |

> 破坏性用例（重启服务、清空日志）默认跳过，`node test/api-test.js --destructive` 才会执行。

## 安全说明

- 默认只监听 `127.0.0.1`，仅本机可访问；映射到局域网/公网前请先阅读 **[使用说明.md](使用说明.md) 的「安全提示」**。
- 访问令牌保存在 `data/config.json`，`data/` 已列入 `.gitignore`；**提交代码前确认没有把 `data/` 或令牌带进仓库**。
- 已实现的防护：包名/版本与路径穿越校验、tarball 路由防任意文件读取、管理接口 Host/Origin 校验与令牌鉴权、常量时间令牌比较、上游重定向逐跳校验与 SSRF 防护、下载完整性校验、tar 解压上限与符号链接拦截、上传大小/格式校验、私有包不回源合并（防依赖混淆）。
- 发现安全问题请按 **[SECURITY.md](SECURITY.md)** 私下上报，不要直接开公开 issue。

## 文档

- **[使用说明.md](使用说明.md)**：安装、界面、命令行、离线迁移、局域网共享、常见问题
- **[报告.md](报告.md)**：开发过程、问题修复与验收记录
- **[CHANGELOG.md](CHANGELOG.md)**：版本变更
- **[CONTRIBUTING.md](CONTRIBUTING.md)**：参与开发与提交规范
- **[SECURITY.md](SECURITY.md)**：安全策略与漏洞上报

## 许可证

[MIT](LICENSE)，可自由使用、修改与分发。
