# 更新日志

本文件记录项目的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-17

首个开源版本。零第三方依赖、可离线迁移的私人 npm 镜像源。

### 新增

- **npm registry 协议**：`npm install / publish / unpublish / deprecate / dist-tag / search / audit`，支持 scoped 包与 `npm:` 别名依赖
- **三种运行模式**：`cache`（本地优先，默认）、`proxy`（按 TTL 回源更新）、`offline`（纯离线）
- **公共包缓存**：自动回源 `https://registry.npmmirror.com`，缓存元数据与 tarball；记录每个版本的真实发布时间
- **私有包仓库**：私有包与上游同名包隔离，私有包不回源合并（防依赖混淆）
- **中文可视化管理界面**：概览、包管理、迁移备份（含本机缓存导入）、配置、日志、服务控制共 6 个页面，包详情与任务进度以抽屉/弹窗呈现
- **离线迁移**：导出整个镜像为单个 `.tgz` bundle，在无网络环境导入；支持按 `all / private / upstream` 范围导出
- **本机 npm 缓存导入**：扫描 `~/.npm/_cacache`（含 `.npmrc` 自定义缓存目录），按页展示候选包，支持全部导入 / 仅导入不存在的包 / 覆盖导入，带逐包进度并可取消
- **依赖递归添加**：自动解析依赖闭包，支持层级/数量限制、多版本共存、非注册表依赖识别、带空格版本范围与 `npm:` 别名
- **批量补 tarball**：按版本、只补最新、全部包批量补齐，后台任务可看进度、可取消、失败明细可查
- **完整的命令行**：`start/stop/restart/status/open/init/config/token/use/unuse/list/add/remove/stats/export/import/scan-cache/import-cache/doctor/logs/autostart` 共 21 个命令
- **开机自启**：写入用户「启动」文件夹，无需管理员权限
- **零依赖实现**：HTTP 服务、tar.gz 打包解包、semver 比较、registry 协议、断点与完整性校验全部手写实现

### 安全

- 包名 / 版本 / tarball 文件名严格校验，阻断路径穿越（含 Windows 反斜杠与编码分隔符）
- registry tarball 路由重写：只允许「真实存在的包 + 纯文件名」，杜绝任意文件读取
- 管理接口令牌鉴权 + 常量时间比较；`?token=` 仅限本机回环
- 管理接口 Host / Origin 校验，拒绝 `Origin: null` 与跨站来源（防 CSRF / DNS 重绑定）
- 上游 tarball 同注册域校验、重定向逐跳校验、内网目标拒绝（SSRF）
- 下载完整性校验（`integrity` / `shasum`），支持多哈希
- tar 解包：校验和验证、截断检测、数据对齐、符号链接拦截、总量/条目数/单条目上限（防压缩炸弹）
- 上传格式与大小校验、离线 bundle 清单与包内 `package.json` 校验
- 安全响应头（nosniff / frame-options / referrer-policy）与管理页面 CSP

### 修复

两轮独立代码审计累计修复问题 60 余项，涵盖：令牌泄露、任意文件读取、路径穿越写入/删除、配置校验缺失导致鉴权被放大、semver 与 npm 行为不符、上游超时与重试语义、并发发布丢版本、任务表内存泄漏、日志伪造、前端契约不一致等。逐条记录见 [报告.md](报告.md)。

### 测试

- `test/api-test.js`：**153 项**（默认执行 150 项 + 3 项显式跳过，0 失败），覆盖 registry 协议、管理接口、发布/删除、离线导入导出、安全回归
- `test/ui-check.js`：**47/47** 前端与后端契约静态检查
- `test/acceptance-npm.ps1`：**16/16** 真实 npm 客户端验收（Windows）
- `test/ui-e2e-*.js`：浏览器端端到端脚本（需要本机 Chrome 调试端口，可选）
- 破坏性用例（重启服务、清空日志）默认跳过，加 `--destructive` 才执行

[1.0.0]: https://github.com/SuLiyue-s/npm-mirror/releases/tag/v1.0.0
