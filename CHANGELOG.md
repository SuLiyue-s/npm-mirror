# 更新日志

本文件记录项目的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] - 2026-10-18

管理界面独立监听 + 连接状态双探测 + 分项重启。**不兼容变更**：管理页面与管理 API 从镜像源端口拆到独立的 `admin.ip:admin.port`（默认 `127.0.0.1:4874`），镜像源监听（默认 `127.0.0.1:4873`）不再提供管理页面；`/service/restart` 语义由「进程重启」改为「只重启镜像源监听」，整个进程重启改用新增的 `/service/restart-process`；托盘菜单「重启镜像源」拆为「重启管理界面」与「重启镜像源服务」。

### 新增

- **管理界面独立监听**：`admin.ip` 只允许 `127.0.0.0/8` 本地回环地址（默认 `127.0.0.1`），`admin.port` 默认 4874 且不能与镜像源端口相同（接口 400 校验，磁盘配置自动回退相邻端口）；管理页面 / 管理 API 只在管理界面监听提供，镜像源监听上 `/__admin/api/*` 一律 403，本机访问镜像源首页 302 跳转到管理界面。旧配置首次启动自动补 `admin` 段并完成端口冲突回退。
- **连接状态双探测**：顶栏两个 chip 分别显示「管理界面」与「镜像源服务」连接状态；同一次同源 `/__admin/api/session` 探测同时得出两者结果、显示可区分；**只有管理界面断连恢复（或管理界面实例标记 `pid` + `admin.startedAt` 变化）才自动刷新界面**，镜像源服务状态变化只更新 chip 与 toast、不打断正在使用的 npm 客户端。
- **分项重启**：新增 `/service/restart-admin`（只重启管理界面监听）与 `/service/restart-process`（整个进程重启）；`/service/restart` 改为只重启镜像源监听。管理界面、托盘菜单、`启动镜像源.cmd`、`开机自启-开启.cmd` 同步加入「重启管理界面」，原「重启镜像源」调整为「重启镜像源服务」。
- **CLI**：新增 `restart-admin`、`restart-process` 命令；`status` / `stop` / `open` / `prestart` 等管理操作走管理界面地址，`restart` 只重启镜像源监听；`prestart` 优先探测管理界面（不可用时回退镜像源 `/-/ping` 与 pid 文件）。

### 安全

- 管理界面与管理 API 隔离到仅 127 网段回环地址的独立监听：局域网内其它机器即使能访问镜像源端口也无法打开管理界面；管理界面监听额外校验请求必须来自回环来源。
- 保留原有 Host / Origin 校验、令牌鉴权、CSP 与安全响应头；镜像源监听上的管理 API 一律 403。

### 修复

- 修复 `--no-open` 命令行参数会把 `server.openBrowserOnStart=false` 写回配置缓存、导致之后保存配置时被持久化的问题（改为仅本次启动生效）。
- 修复「服务已经在运行」时再双击 `启动镜像源.cmd` 不会补注册托盘图标、右下角图标一直不出现的问题：`prestart` 退出码 10 分支现在**前台**拉起 `tools\tray.ps1` 补注册托盘（不用后台 `start /b`：脚本窗口一关会把托盘进程一起结束；改成前台后脚本窗口一直当托盘宿主、就绪后自己隐藏）；补注册模式（`MIRROR_TRAY_RESTORE=1`）会按标题接管原来那个「跑着服务、已被隐藏」的命令行窗口，`data\logs\tray.pid` 记录托盘宿主 PID，托盘加单实例互斥体（名字带项目目录哈希）保证同一份程序始终只有一个图标。
- 修复托盘「退出镜像源」在管理接口不可达/停不掉时留下没人管的 node 进程：改为以 `data\mirror.pid` 的进程是否真的退出为准，10 秒内没退直接 `Stop-Process -Force` 兜底；健康检查连续失败时会先重读配置再判定「服务已停止」，避免管理界面端口刚改过时误判。
- 开机自启注册项丢失后（例如被系统/安全软件清理、或手动删掉「启动」文件夹里的 `私人npm镜像源.vbs`），重新执行「开机自启-开启.cmd」即可恢复；登录时若镜像源已经在运行，启动脚本只写一行日志并顺带补注册托盘图标，不再直接退出。
- 修复日志行首时间戳使用 UTC（`Z` 后缀、比本机时间慢 8 小时）导致日志文件里的日期/时间与电脑本机时区不一致的问题：新增 `util.nowLocalIso()` 生成带本机 UTC 偏移的 ISO 时间（如 `2026-10-18T23:41:36.507+08:00`），`src/logger.js` 写日志改用它；管理界面「日志」页解析行首时间的正则同时兼容旧 `Z` 结尾与新的 `+08:00` 偏移（历史日志行保持原样、照常显示）。日志文件名本来就按本机日期切分，不受影响。

### 测试

- `test/api-test.js`：**276 项**（269 通过 + 7 跳过、0 失败，约 26 秒），含双监听、分项重启、镜像源监听管理 API 403、首页 302 跳转，以及日志行首时间戳为本机时区（带偏移）等用例；已不再包含会大量导包的「递归添加依赖 / 全部包补 tarball / 本机 npm 缓存导入真实扫描 / 大名单规划」用例（原 `--full` 模式已移除）
- `test/ui-check.js`：**231/231**，连接状态段重写为双 chip / 双探测 / 刷新规则 / 分项重启断言
- `test/tray-check.js`：**66/66**，托盘 5 项菜单与两个重启函数断言；新增补注册托盘（退出码 10 前台拉起 / 单实例互斥体 / 接管被隐藏的原命令行窗口 / `tray.pid`）、退出镜像源进程兜底、健康检查失败先重读配置等断言；`--base` 默认改为管理界面端口
- `test/tray-e2e.ps1`（手工、需真实桌面）新增**场景 A**：强杀托盘进程（模拟图标被关掉/崩掉）→ 再跑一次 `启动镜像源.cmd` → 断言托盘补注册成功、接管原来的隐藏命令行窗口、服务不受影响
- `test/run-all.js` 一键自检（约 40~60 秒，`--destructive` 含破坏性用例），已移除 `--full` 完整回归参数；与 6 个 `test/ui-e2e-*.js` 默认地址改为管理界面端口并分别探测两个监听
- 破坏性用例（重启镜像源服务 / 重启管理界面 / 清空日志）默认跳过，加 `--destructive` 才执行

## [0.0.1] - 2026-10-19

**首个桌面版（Tauri 单 exe）**：把 Node 镜像源服务、管理界面与托盘打包成一个 `npm-mirror-desktop-0.0.1.exe`，双击即用、目标机器无需安装 Node.js；网页版 / 命令行版行为与数据格式保持不变。

> 下载：[GitHub Releases v0.0.1](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.1)（附件含 exe 与 `SHA256SUMS.txt`）。

### 新增

- **单 exe 桌面版**：Tauri 2 外壳（Rust）+ 内嵌 node.exe 与全部程序文件，首次运行解压到 `%LOCALAPPDATA%\LiYueNpmMirror\runtime\<版本>\` 后复用；构建脚本 `tools/build-desktop.ps1`（校验三处版本一致 → 嵌入 node.exe → 生成/校验图标 → 用 `tmp/cargo-home` 离线 `cargo build --release` → 输出 `dist/npm-mirror-desktop-<版本>.exe` + `dist/SHA256SUMS.txt`），支持 `-NodeExe` / `-ForceIcon` / `-DebugBuild` / `-NoOffline`。
- **桌面窗口 = 现有管理界面**：窗口加载本机随机回环端口上的现有网页（顶栏版本 chip 显示 `0.0.1`）；左侧导航新增「控制台」「工具」两页，与现有六个页面共用同一套样式与组件。
- **控制台页**：环形缓冲最多 3000 行，汇总服务日志（`server`）、一键脚本输出（`script`）与桌面操作事件（`desktop`），每行带 `seq` / 时间戳 / 级别 / 来源；约 1 秒增量轮询，支持暂停 / 继续 / 清空 / 复制 / 下载与级别、来源筛选。
- **工具页**：桌面程序信息与「重启程序 / 退出程序 / 隐藏窗口」；服务控制「重启镜像源服务 / 重启管理界面 / 打开网页版管理界面」；开机自启开关；一键脚本「环境自检 / 查看状态 / 从 npm 缓存补包 / 一键导出全部包 / 一键导入离线包」；目录与日志「打开数据目录 / 日志目录 / 配置文件 / 复制路径」。
- **托盘常驻**：左键单击打开窗口；右键「打开窗口 / 关闭窗口 / 重启管理界面（仅网页版管理开启时出现）/ 重启镜像源服务 / 退出程序」；关闭窗口只是隐藏，进程与服务继续运行；托盘菜单随网页版管理开关变化（≤2 秒内更新）。
- **单实例**：命名互斥体 `Local\LiYueNpmMirrorDesktop`，重复双击只唤出已运行窗口，不会起第二个服务。
- **网页版管理开关 `admin.enabled`（默认 `false`）**：默认不监听浏览器可访问的固定管理端口，只能从桌面窗口管理；在配置页「桌面 / 网页管理」打开后**即时生效**（无需重启程序）并按 `admin.ip:admin.port` 监听，关闭即断开；网页版 / 命令行模式固定开启、行为不变。开关变化通过桥事件通知托盘，Rust 侧另有 1 秒配置轮询兜底。
- **主数据目录**：默认 `<exe目录>\data`，与网页版 / 命令行版共用同一数据格式；配置页只读输入框 +「选择目录…」原生文件夹选择器，选后确认并重启程序；非法路径（不存在 / 文件 / 磁盘根 / 相对路径 / NUL）被拒绝并给出中文错误；启动优先级 `--data-dir` > `MIRROR_DATA_DIR` > 记录文件（`%LOCALAPPDATA%\LiYueNpmMirror\data-location.json`）> `<exe目录>\data`。
- **开机自启**：工具页一键开关，写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（值名 `LiYueNpmMirror`，内容 `"<exe>" --autostart`），登录后隐藏窗口启动到托盘，无需管理员权限。
- **Node 侧数据根改造**：`src/util.js` 新增 `appRoot()` / `dataRoot()` / `setDataRoot()` / `dataPath()` / `resolveWithinDataRoot()` / `isDesktop()`，全项目 `rootPath('data', …)` 迁移为 `dataPath(…)`；`storage.dir` 兼容旧值 `data/storage` 前缀，非法值回退 `<dataRoot>/storage` 并 warn（不阻塞服务启动）。
- **一键脚本执行器**：`src/desktop-scripts.js` 白名单固定参数执行 `cli.js doctor / status / export --scope all / scan-cache + import-cache --all / import <文件> --overwrite`；输出逐行进控制台；同一脚本单实例、可取消（`taskkill /T /F`）；导入文件必须是存在的 `.tgz` / `.tar.gz` 且大小大于 0。
- **Rust ↔ Node stdio 桥**：`@@BRIDGE@@` 前缀逐行 JSON，Node 上报 `ready`（含内部管理端口 / 数据目录 / pid / 网页版管理状态）、`req`、`event`、`bye`，Rust 下发 `res` 与 `cmd`（shutdown / restartWebAdmin / restartRegistry / showWebAdmin / console.log）；Node 子进程崩溃自动重启（最多 3 次，间隔 1s / 3s / 5s）。
- **桌面 HTTP API**：`GET /desktop/info`、`GET /desktop/files`、`GET/DELETE /desktop/console`、`GET /desktop/scripts`、`POST /desktop/action`（pickFolder / pickFile / setDataDir / autostart / openPath / app.restart / app.quit / window.show|hide / script.run|script.cancel / service.restartRegistry|restartWebAdmin）；非桌面模式返回 400「仅桌面版可用」。
- **版本与发版工具**：`node tools/version.js [<x.y.z>|--bump patch|minor|major]` 同步 `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 三处版本；`tools/release.ps1` 串起 bump → 构建 → 提交 → `tag v<版本>` → GitHub Release（网络受限时保留 commit/tag 并输出人工发布指引）。

### 变更

- 桌面模式下旧 `/service/*` 接口语义适配：「重启管理界面」只重绑网页版管理监听、「重启镜像源服务」只重绑镜像源监听、「重启程序」与「退出程序」走桥命令；桌面模式忽略 `openBrowserOnStart`，不再自动弹浏览器。
- `PUT /config` 在桌面模式下保存后立即重绑网页版管理监听，响应附带 `webAdmin: { enabled, url, listenError }`，并广播 `webAdminChanged` 事件。
- 桌面配置（窗口位置等）保存在 `%LOCALAPPDATA%\LiYueNpmMirror\desktop.json`，不写入 `data\config.json`。

### 安全

- 路径穿越防护：`resolveWithinDataRoot()` 对存储目录 / 数据根下的相对路径做规范化校验，`..`、绝对路径、NUL、磁盘根一律拒绝；`PUT /config` 的 `storage.dir` 穿越返回 400 中文错误；单测 `test/desktop-path-test.js` 覆盖。
- 桌面版内部管理接口只监听 `127.0.0.1` 随机端口（仅窗口内使用）；默认不监听固定 admin 端口（`admin.enabled=false`），打开后仍受 `127/8` 回环校验与令牌鉴权。
- 单实例互斥体避免多开抢端口与并发写同一份数据。

### 测试

- 新增 `test/desktop-path-test.js`（数据根 / 路径穿越单测）与 `test/desktop-bridge-test.js`（stdio 桥协议，用子进程模拟 Rust 端）。
- 新增 `test/desktop-e2e.ps1` 桌面版端到端验收：dist exe 存在与版本信息、启动与窗口、内部管理 API、控制台 API、一键脚本 doctor/status、`admin.enabled` 端口监听开关、默认数据目录、关闭窗口后服务仍在线、退出后无残留进程与监听；使用临时数据目录 `tmp/e2e-data` 与端口 14873/14874，不碰真实 `data\`。
- 桌面版实测结果与逐条验收证据见 `tmp/audit-desktop.md`（发布审计报告）与 `tmp/release-checklist.md`。

## [1.0.0] - 2026-10-17

首个开源版本。零第三方依赖、可离线迁移的私人 npm 镜像源。

### 新增

- **npm registry 协议**：`npm install / publish / unpublish / deprecate / dist-tag / search / audit`，支持 scoped 包与 `npm:` 别名依赖
- **三种运行模式**：`cache`（本地优先，默认）、`proxy`（按 TTL 回源更新）、`offline`（纯离线）
- **公共包缓存**：自动回源 `https://registry.npmmirror.com`，缓存元数据与 tarball；记录每个版本的真实发布时间
- **私有包仓库**：私有包与上游同名包隔离，私有包不回源合并（防依赖混淆）
- **中文可视化管理界面**：概览、包管理、迁移备份（含本机缓存导入）、配置、日志、服务控制共 6 个页面，包详情与任务进度以抽屉/弹窗呈现；整页的网格 / 扫描线 / 光晕 / 噪点动态背景同样铺进弹窗、抽屉、面板与统计卡的内部背景（不挡点击）；任务进度弹窗的「取消」在等待取消完成期间置灰，取消失败才恢复可点；界面上所有原生下拉的展开列表都换成项目风格自绘（深色面板、青色选中/悬停、键盘 ↑↓/Enter/Esc、点面板外关闭，底层保留原生 `value`/`change` 语义），搜索框原生清除叉与数字框原生上下箭头收掉，`:focus-visible` 统一青色描边，原生 `window.confirm` 换成项目风格确认框；下拉按钮右侧的小箭头在悬停、键盘聚焦与展开时一起变青（改为边框三角绘制，无渐变接缝），复选框对勾加粗更清晰、全选「半选」态显示横杠，勾选单行时表头全选框同步半选
- **离线迁移**：导出整个镜像为单个 `.tgz` bundle，在无网络环境导入；支持按 `all / private / upstream / selected / added` 范围导出（`added` = 按「首次添加进本地镜像」的时间段筛选；起止时间点为「只读输入框 + 项目风格自绘日历弹层」：月历 + 时/分自绘下拉 + 清除/现在/取消/确定）
- **本机 npm 缓存导入**：扫描 `~/.npm/_cacache`（含 `.npmrc` 自定义缓存目录），按页展示候选包，支持全部导入 / 仅导入不存在的包 / 覆盖导入，带逐包进度并可取消
- **依赖递归添加**：自动解析依赖闭包，支持层级/数量限制、多版本共存、非注册表依赖识别、带空格版本范围与 `npm:` 别名
- **批量补 tarball**：按版本、只补最新、全部包批量补齐，后台任务可看进度、可取消、失败明细可查
- **完整的命令行**：`start/stop/restart/status/open/init/config/token/use/unuse/list/add/remove/stats/export/import/scan-cache/import-cache/doctor/logs/autostart` 共 21 个命令
- **开机自启**：写入用户「启动」文件夹（`.vbs`，登录后隐藏启动），启动后与双击 `启动镜像源.cmd` 一样注册托盘图标与右键快捷菜单（打开 / 隐藏控制台、打开管理界面、退出镜像源），无需管理员权限
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

两轮独立代码审计累计修复问题 60 余项，涵盖：令牌泄露、任意文件读取、路径穿越写入/删除、配置校验缺失导致鉴权被放大、semver 与 npm 行为不符、上游超时与重试语义、并发发布丢版本、任务表内存泄漏、日志伪造、前端契约不一致等。另修复概览页「上游与来源分布」条形图一直只显示深色轨道的问题（填充 `<i>` 是内联元素，`width`/`height` 不生效；改为 `display:block` 并对非零来源给最小 2% 宽度）。逐条记录见 [报告.md](报告.md)。

### 测试

- `test/api-test.js`：**153 项**（默认执行 150 项 + 3 项显式跳过，0 失败），覆盖 registry 协议、管理接口、发布/删除、离线导入导出、安全回归
- `test/ui-check.js`：**47/47** 前端与后端契约静态检查
- `test/acceptance-npm.ps1`：**16/16** 真实 npm 客户端验收（Windows）
- `test/ui-e2e-*.js`：浏览器端端到端脚本（需要本机 Chrome 调试端口，可选）
- 破坏性用例（重启服务、清空日志）默认跳过，加 `--destructive` 才执行

[0.0.1]: https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.1
[1.0.0]: https://github.com/SuLiyue-s/npm-mirror/releases/tag/v1.0.0
