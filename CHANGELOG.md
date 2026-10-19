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

## [0.0.7] - 2026-10-19

**桌面版安全与交互修复版（本地构建交付，暂未发布 GitHub）**：内部管理端口增加「每次启动随机令牌」门禁；单实例在「旧实例退出中启动新实例」时等待并接管；托盘新增「重启窗口的管理界面」并把菜单调整为默认 5 项 / 网页版管理开启后 7 项（实时切换）；低完整性修复后的重启改为由提权 cmd 助手完成（icacls 改标签 → 约 2 秒 → explorer 以普通权限拉起）。

> 本版本按用户要求**只在本机构建交付**，产物保留在 `dist\npm-mirror-desktop-0.0.7.exe`，**不推送 GitHub、暂不创建 Release**（是否发布待用户确认）；GitHub 最近发布版仍为 [v0.0.5](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.5)。

### 修复

- **内部管理端口令牌门禁（用户反馈：桌面窗口的内部管理界面可被本机其它程序 / 浏览器直接访问）**：桌面窗口使用的 `127.0.0.1:<随机端口>` 内部管理监听，启动时生成一个随机访问令牌；无令牌或错误令牌访问页面 / 静态资源 / 管理 API 一律 **403**（中文提示），正确令牌首次访问返回 **302** 并写入 `HttpOnly; SameSite=Strict` 会话 Cookie，之后带 Cookie 访问返回 200。Rust 外壳改用 ready 消息中的 `internalAdminUrl`（`?__mirror_token=<令牌>`）打开窗口；令牌每次启动不同，**不写入日志、不在 `/desktop/info` 暴露**；网页版管理端口（`admin.enabled` 开启时）与命令行模式行为不变。
- **单实例等待与接管竞态**：第二个实例发现已有实例时最多等待约 **15 秒**（期间周期性唤醒旧窗口）；已有实例健康时唤醒后退出；若旧实例正在退出，则等待其退出后**接管**启动，避免「旧实例刚退出、新实例启动失败」的竞态。测试报告保留 `alreadyRunning` 并新增 `waitedMs`。
- 低完整性修复后的**重启方式**：提权进程不再直接拉起界面，而是写入临时批处理（cmd 助手）执行「`icacls` 修改 exe 完整性标签 → 等待约 2 秒 → `explorer.exe` 以当前用户（非提权）拉起 exe」，完成后自行清理；`IntegrityStatus` 新增 `relaunchMethod` / `relaunchScheduled` 字段便于诊断。

### 新增

- 托盘菜单新增 **「重启窗口的管理界面」**：只重启桌面窗口使用的内部管理界面（换新内部端口与令牌、窗口重新加载），不影响镜像源监听与网页版管理监听。
- 托盘菜单项调整：网页版管理**关闭时 5 项**（打开窗口 / 关闭窗口 / 重启窗口的管理界面 / 重启镜像源服务 / 退出程序）、**开启时 7 项**（多出「打开管理界面」「重启管理界面」）；开关后菜单 ≤2 秒实时切换。
- 测试报告新增 `internalAdminPort` / `internalAdminUrl`（动态更新）、`alreadyRunning` / `waitedMs`、`integrity.relaunchMethod` / `relaunchScheduled` 字段。

### 文档

- README / 使用说明：补充内部管理端口令牌门禁说明（含为何浏览器直接访问会 403、正常用户无需关心）、托盘 5 / 7 项菜单与「重启窗口的管理界面」、单实例等待接管、低完整性 v0.0.7 重启方式；版本更新为 0.0.7（本地构建交付，GitHub 下载链接仍指向 v0.0.5）。

### 测试

- `test/desktop-e2e.ps1` 适配 0.0.7：新增内部管理端口令牌门禁断言（无令牌 / 错误令牌 403、正确令牌 302 + `Set-Cookie`（HttpOnly / SameSite=Strict）→ 带 Cookie 200 + HTML、令牌不出现在 `desktop.log` 与 `/desktop/info`）；托盘断言 5 项 / 7 项与实时切换，新增 `menu:tray-restart-window-admin` 动作断言（报告 `internalAdminUrl` 端口 / URL 变化、旧端口停止监听、新地址门禁通过、窗口 URL 指向新地址）；单实例断言第二实例 `alreadyRunning` / `waitedMs` / 退出码 0、首实例存活；完整性断言新增 `relaunchMethod` / `relaunchScheduled`（smoke 不安排重启）；保留 v0.0.4–v0.0.6 全部阶段与退出码口径。
- **v0.0.7 实测（2026-10-19 20:53:28，`dist\npm-mirror-desktop-0.0.7.exe`，96,853,504 B，SHA256 `683319fa2ef434aa930a6814ad7cda1606b463fc76a1b8b8e34bf2b041cdb643`）：297 项 = 285 通过 / 6 失败（全部窗口类环境限制）/ 6 跳过，退出码 3，非窗口类失败 0**；v0.0.7 新增断言全部通过（内部管理端口令牌门禁、托盘 5/7 项与「重启窗口的管理界面」、单实例等待接管、`relaunchMethod`/`relaunchScheduled`、`%TEMP%` 无提权助手残留）。历史 v0.0.6：207 项 = 196 通过 / 5 失败（窗口类环境限制）/ 6 跳过，退出码 3，非窗口类失败 0；0.0.5：194 项 = 183/5/6，exit 3；0.0.4：166 项 = 155/5/6，exit 3。

## [0.0.6] - 2026-10-19

**桌面版低完整性修复算法修正版（本地构建交付，暂未发布 GitHub）**：v0.0.5 的「提权重启自身 exe」修复路径在 Windows 的 `min(用户令牌, 文件标签)` 规则下无效——提权后的进程面对自身仍是 Low 标签的文件依旧被强制低完整性运行。v0.0.6 改为「提权后调用系统 `icacls.exe` 修改 exe 文件标签 → 复查 Medium → 以普通权限自动重启」；修复失败时给出两条可操作退路。同时把 exe 版本信息的发布者固定为 `suliyue`。

> 本版本按用户要求**只在本机构建交付**，产物保留在 `dist\npm-mirror-desktop-0.0.6.exe`，**不推送 GitHub、暂不创建 Release**（是否发布待用户确认）；GitHub 最近发布版仍为 [v0.0.5](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.5)。

### 修复

- **修正低完整性标签一键修复算法**：v0.0.5 的实现是「请求 UAC → 提权重启同一个 exe → 提权实例里执行 `icacls`」，但按 Windows 完整性规则「进程完整性 = min(用户令牌, 文件标签)」，提权后的实例面对自身仍是 Low 标签的文件依旧低完整性，标签实际改不掉。v0.0.6 改为：**提权进程里调用系统 `icacls.exe` 修改 exe 文件本身的完整性标签**（`icacls "<exe>" /setintegritylevel Medium`）→ **复查文件标签确为 Medium** → **以普通权限自动重启程序**，之后配置目录写入、托盘注册恢复正常。
- **修复失败时给出两条退路**：弹框会提示 ① 把 exe **复制到其它文件夹**（如桌面）再双击——复制出的新文件继承目标目录的正常标签，一般可直接使用；② 右键「以管理员身份运行」命令提示符，执行 `icacls "<exe路径>" /setintegritylevel Medium` 手动修复。不再只显示一条无法解决的错误。

### 变更

- **exe 版本信息发布者固定为 `suliyue`**（`src-tauri/tauri.conf.json` 的 `bundle.publisher`，资源管理器 → 右键属性 → 详细信息中 `CompanyName` 可见）。程序**未做代码签名**，SmartScreen / UAC 仍显示「未知发布者」，属正常现象。
- 低完整性检测开关/参数不变：`--repair-integrity`（检查并修复后退出，未提权退出码 3、成功 0、失败 2）、`--skip-integrity-prompt`（跳过启动询问框）；smoke 测试模式仍不弹框。

### 文档

- README / 使用说明：低完整性小节改写为 v0.0.6 修复原理（提权后改文件标签，解释旧算法为何无效）与两条失败退路；新增「发布者 `suliyue`」说明（含未签名、SmartScreen/UAC 显示未知发布者的提示）；版本/产物/下载说明改为「0.0.6 本地构建交付版，暂不发布 GitHub，GitHub 最近发布版为 v0.0.5」。

### 测试

- `test/desktop-e2e.ps1` 适配 0.0.6：阶段 0 新增 exe 版本信息断言（`CompanyName=suliyue`、`FileVersion`/`ProductVersion`=0.0.6、`ProductName`/`FileDescription`=离月私人 npm 镜像源）；新增「普通目录副本」阶段（把 exe 复制到 `tmp\e2e-copy` 后用 smoke 启动，断言 `integrity` 字段完整）；阶段 0b / 0c / 0d 与既有完整性只读断言保持不变，**仍不执行真实 UAC / 提权/修复**（真实一键修复留人工验收项）。
- **v0.0.6 实测（2026-10-19 19:09:50 对 `dist\npm-mirror-desktop-0.0.6.exe`，96,832,000 B，SHA256 `5125d853…765526`）：207 项 = 196 通过 / 5 失败（全窗口类环境限制）/ 6 跳过，退出码 3，非窗口类失败 0**；v0.0.6 新增版本信息 5 项断言与普通目录副本阶段（8/8）全部通过；Lead 独立冒烟 71/71 PASS。历史 v0.0.5：194 项 = 183 通过 / 5 失败（全窗口类环境限制）/ 6 跳过，exit 3，非窗口类失败 0；0.0.4：166/155/5/6；0.0.3：153/143/5/5；0.0.2：143/133/5/5。

## [0.0.5] - 2026-10-19

**桌面版低完整性标签检测与一键修复版（发布到 GitHub Releases）**：用户反馈「双击 exe 后没有窗口/托盘、启动异常」的根因是 exe 文件继承了 Windows「低完整性（Low）」标签，被系统强制降级运行。v0.0.5 在 Rust 外壳启动流程中自动检测该标签，检测到即弹框提示并支持一键修复（UAC 提权 `icacls /setintegritylevel Medium` 重置后自动重启程序），同时新增手动修复与诊断脚本。

> 本版本**发布到 GitHub Releases**：[v0.0.5 发布页](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.5)（附件 `npm-mirror-desktop-0.0.5.exe` 与 `SHA256SUMS.txt`）。

### 新增

- **低完整性（Low）标签自动检测**：启动时检测 exe 文件完整性标签与当前进程令牌完整性（检测结果同时写入测试报告 `integrity` 对象：`token` / `tokenRid` / `file` / `elevated` / `repairPrompted` / `repairLaunched` / `exePath`），并在桌面日志记录；非测试模式下检测到 Low 标签会弹出可操作说明框，而不是让程序静默降级运行。
- **一键修复**：说明框选「是」→ 请求一次 UAC 提权 → 自动执行 `icacls "<exe 完整路径>" /setintegritylevel Medium` 把 exe 标签重置为 Medium → **自动重启程序**；选「否」则继续受限运行（窗口内警示条、无托盘、关闭窗口=退出程序）。新增命令 `--repair-integrity`（检查并修复完整性标签后退出）与 `--skip-integrity-prompt`（跳过启动时的低完整性询问框，供自动化 / 明确接受受限运行的用户使用）。
- `启动桌面版.cmd` 启动前自动检查 exe 低完整性标签，带标签时请求一次 UAC 修复后再启动（支持 `MIRROR_LAUNCH_DRYRUN=1` 只打印将执行的命令）；`修复-桌面版启动限制.cmd` 提供检查 / 一键修复（`check` 退出码 0=正常、2=带 Low 标签；`repair` 内部提权后实际修复）；`诊断-桌面环境.cmd` / `tools\diagnose-desktop.ps1` 输出只读诊断（进程与文件完整性、权限、WebView2、托盘能力）到 `tmp\desktop-diagnose.txt`。

### 变更

- `tools\build-desktop.ps1` 构建完成后用 `icacls` 检查产物完整性标签：产物带 `Low Mandatory` 时打印黄色提示（继承 Low 标签、修复方式、每次重新编译都需重新修复），避免误判为构建失败。
- 托盘 / 窗口 / 关闭行为不变（4/6 项菜单、托盘不可用时关窗即退），仅在其之前增加完整性标签检查与修复引导。

### 文档

- README / 使用说明：新增「低完整性（Low）标签」原理说明与「启动必读」、新增使用说明 13.15「低完整性标签自动检测与一键修复」、常见问题补充「双击 exe 后弹框提示低完整性」条目；构建章节补充 Low 标签提示与修复脚本；版本与下载链接更新为 0.0.5（历史 v0.0.3 / v0.0.4 为本地构建未发布）。

### 测试

- `test/desktop-e2e.ps1` 适配 0.0.5：只读断言测试报告 `integrity` 对象字段齐全、`integrity.file` 与 `icacls` 读到的 dist exe 标签一致、smoke 模式检测到 Low 不弹框、`--help` 含 `--repair-integrity` 与 `--skip-integrity-prompt`、非 smoke 启动加 `--skip-integrity-prompt` 不被询问框阻塞；**不执行真实 UAC / 提权/修复**（真实一键修复留人工验收项 M29）。
- **v0.0.5 实测（2026-10-19 18:07:49 对 `dist\npm-mirror-desktop-0.0.5.exe`，96,829,440 B，SHA256 `727b994ad2ff81a482114b13cfb3e035c0f92a2b7cf610635f9f54e0deff644d`）：194 项 = 183 通过 / 5 失败（全窗口类环境限制）/ 6 跳过，退出码 3，非窗口类失败 0**；`--help` 三参数（阶段 0b 4/4）、只读 `--repair-integrity` 未提权退出码 3 + 「管理员权限」原因且不改产物（阶段 0c 6/6）、非 smoke + `--skip-integrity-prompt` 不被询问框阻塞（阶段 0d 6/6）、`integrity` 对象与 `icacls` 交叉一致=Low、smoke 不弹框（`promptSuppressed=true`）全部通过；图标一致性、托盘 4/6 项、配置目录回退 10/10、数据目录自动发现 9/9 无回归。历史 v0.0.4：166 项 = 155/5/6，exit 3；0.0.3：153/143/5/5；0.0.2：143/133/5/5。

## [0.0.4] - 2026-10-19

**桌面版托盘可见性修复版（本地构建，未发布到 GitHub Releases）**：修复托盘图标完全不显示的问题——托盘改为程序自绘 Win32 注册并检测注册结果，注册失败时重试、在窗口内给出可见提示并让「关闭窗口」直接退出程序；同时把 exe / 窗口 / 托盘图标统一换成网页版图标 `public/favicon.ico`。

> 本版本按用户要求**只在本机构建**，产物保留在 `dist\npm-mirror-desktop-0.0.4.exe`，**不推送 GitHub、不发布 Release**；需要从 GitHub 下载安装的用户请继续使用 [v0.0.2](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.2) 发布版。

### 修复

- 修复**托盘图标完全不显示**的问题（用户反馈）：旧实现依赖 tauri 托盘 API，只能表示「已尝试创建」、无法区分真正注册成功。v0.0.4 改为程序自绘 Win32 注册（`Shell_NotifyIcon`），注册结果可检测；失败时每秒重试、最多 15 秒，详情写入桌面日志。
- 受限启动环境（沙盒 / 受限终端 / 受限账户）下托盘注册被系统拒绝（`os error 5`）时不再静默：程序在**窗口内显示警示条**，并在 `desktop.log` 记录「托盘注册失败：…」；此时**关闭窗口 = 直接退出程序**，不会留下「没有托盘、进程却静默在后台」的状态。
- 新增托盘**自愈**：监听资源管理器广播的 `TaskbarCreated` 消息，任务栏重建（Explorer 重启 / 注销后重新登录）后自动重新注册托盘图标（约 1 秒内恢复），不需要重启程序。
- 托盘不可用状态可从 `/desktop/info` 与测试报告读取（`tray.available` / `tray.error`），便于用户与自动化判断。

### 变更

- **程序图标统一**：exe 文件图标、窗口图标、托盘图标全部改用网页版图标 `public\favicon.ico`（与浏览器标签页一致），不再使用「旧图标 + Tauri logo」合成图；`tools\compose-desktop-icon.ps1` 只负责从网页版图标生成窗口（256×256）与托盘（32×32）所需的 RGBA 素材。
- 托盘由 tauri 托盘 API 改为自绘 Win32 注册；菜单项与顺序不变（网页版管理关闭时 4 项 / 开启时 6 项）。

### 文档

- README / 使用说明：补充「托盘图标完全不出现」的两种原因与排查方法（受限环境注册被拒 `os error 5` → 窗口警示条 + 日志；Explorer 重启 → 自动重注册），说明用 `desktop.log` 中「托盘图标已注册 / 托盘注册失败」判断注册结果；补充图标统一说明；关闭窗口行为按托盘是否可区分；版本更新为 0.0.4（本地构建，GitHub 下载链接仍指向 v0.0.2）。

### 测试

- `test/desktop-e2e.ps1` 适配 0.0.4：断言测试报告 `tray.available` 存在；关闭窗口阶段按 `tray.available` 分支——可用时断言窗口隐藏、进程存活、服务在线，不可用时断言进程退出（退出码 0）且无 Node 残留（沙箱预期不可用）；`/desktop/info` 的 `tray.available` 与报告一致；受限环境 `restricted = home_fallback || !tray_available` 与 `tray.error` 含拒绝原因；新增图标一致性断言（`src-tauri\icons\icon.ico` 与 `public\favicon.ico` SHA256 相同、RGBA 素材尺寸正确）；`window:close` 测试命令模拟关闭窗口事件。
- **v0.0.4 实测：166 项 = 155 通过 / 5 失败 / 6 跳过，退出码 3（环境限制），非窗口类失败 0**（2026-10-19，`dist\npm-mirror-desktop-0.0.4.exe`，96,808,448 B，SHA256 `3c845384…4fff0c`；5 个失败全部为窗口/WebView2 类断言，属受限会话环境限制；阶段 1c-3 托盘不可用→关窗退出、图标一致性、托盘菜单 4/6 项与实时切换、数据目录自动发现、程序配置目录回退全部通过）。历史 v0.0.3：153 项 = 143 通过 / 5 失败（均为窗口类环境限制）/ 5 跳过，退出码 3，非窗口类失败 0；0.0.2：143 项 = 133/5/5，exit 3。

## [0.0.3] - 2026-10-19

**桌面版可观测性与启动方式修复版（本地构建，未发布到 GitHub Releases）**：修复受限环境启动后「没有窗口、没有托盘却进程在跑」的可见性问题，新增数据目录自动发现与一键启动脚本，并修复离线包导入取消卡死、进度弹窗并发路数被长包名截掉的问题。

> 本版本按用户要求**只在本机构建**，产物保留在 `dist\npm-mirror-desktop-0.0.3.exe`，**不推送 GitHub、不发布 Release**；需要从 GitHub 下载安装的用户请继续使用 [v0.0.2](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.2) 发布版。

### 修复

- 修复从受限环境启动后**看不到窗口和托盘、但进程仍在运行**的问题（用户反馈第 2、3 条）：v0.0.3 在创建窗口与托盘后会校验 WebView2 / 托盘是否真的可用；不可用时弹出**可操作的说明框**（提示「请用 Windows 资源管理器打开程序所在目录，双击 exe 运行；不要在聊天窗口 / 沙盒 / 受限终端中启动」，以及安装 WebView2 Runtime 的指引），随后清理 Node 子进程与托盘并退出，不再留下「静默跑着但看不到」的进程。用户 v0.0.2 的日志（`%LOCALAPPDATA%` 创建目录被拒 `os error 5`、WebView2 `runtime error: failed to receive message from webview`）表明其启动环境是受限环境。测试模式（`MIRROR_DESKTOP_SMOKE=1`）下不弹框、继续运行，以便自动化验收。
- 修复「配置目录不可写」时的回退**提示弹框**（用户反馈第 1 条）：去掉这个只有一行「创建目录失败」、关掉后仍无界面的弹框，改为**静默回退 + 桌面日志 WARN**；程序配置目录仍按五级顺序探测：`MIRROR_DESKTOP_HOME` → `%LOCALAPPDATA%\LiYueNpmMirror` → `<exe 所在目录>\LiYueNpmMirror` → `%TEMP%\LiYueNpmMirror` → `<exe 所在目录>\.LiYueNpmMirror`。
- 修复「导入离线包」在**解包阶段点取消后任务一直卡在「等待开始…」**永不结束的问题（用户反馈第 4 条）：取消现在会中止解包 / 扫描 / 写入存储各阶段并清理未完成包的临时目录，任务在约 1~2 秒内进入「已取消」终态；正常导入 / 导出 / 上传不受影响。
- 修复任务进度弹窗右栏的「包名 · N 路」在**包名过长时把并发路数截掉**的问题（用户反馈第 5 条）：并发路数改为独立、右对齐、不参与省略号的角标元素，包名再长也能看到「N 路」。
- 修复桌面版在 `dist\` 目录直接运行时把数据建到 `dist\data`、读不到项目根 `data\` 的问题（用户反馈第 1 条中「程序在运行目录建 data」）。

### 新增

- **数据目录自动发现**：启动优先级为 `--data-dir` > `MIRROR_DATA_DIR`（环境变量）> 上次「选择目录…」的记录 > `<exe 所在目录>\data`（若其下已有 `config.json` 或 `storage\`）> **若 `<exe 所在目录>\data` 不存在或为空、且上级目录 `..\data\config.json` 存在，则自动改用上级项目的 `data\`**（日志记「检测到上级目录现有数据」，数据来源上报 `parent-project`）> 否则 `<exe 所在目录>\data`（来源 `default`）。把 exe 放进项目的 `dist\` 内双击即可直接读到 `项目根\data` 的现有数据。
- **`启动桌面版.cmd`**：在仓库根（或放有 `dist\` 的目录）双击即可启动 `dist\` 下最新的 `npm-mirror-desktop-*.exe`，启动前打印窗口 / 托盘 / 网页版管理与启动方式提示；找不到 exe 时给出构建或放置提示。网页版 / 命令行的 `启动镜像源.cmd` 流程保持不变。
- 启动诊断信息增强：桌面日志与测试报告增加程序配置目录解析结果（`home.path` / `home.fallback`）、实际数据目录来源（`dataDirSource`）与窗口初始化失败原因（`window.failureReason`），便于排查启动环境问题。

### 文档

- README / 使用说明新增 **「启动必读」**：桌面版**必须从 Windows 资源管理器双击 exe（或 `启动桌面版.cmd`）运行**；从聊天窗口、沙盒、IDE 预览面板、受限终端启动会继承受限权限，导致 WebView2 窗口 / 托盘不可用（v0.0.3 会弹出说明框并退出）；补充托盘图标可能收在任务栏「^」溢出区、数据目录自动发现规则、以及「本版本为本地构建、未发布 GitHub Releases」的说明。

### 测试

- `test/desktop-e2e.ps1` 适配 0.0.3：新增**「数据目录自动发现」**阶段——把 exe 复制到 `tmp` 布局的 `portable\dist\`、在上一级 `portable\data\config.json` 放测试配置、使用临时程序配置目录（`MIRROR_DESKTOP_HOME`），断言报告里 `dataDir` 指向上级 `data`、`dataDirSource=parent-project`、镜像源 ready；新增 smoke 报告 `window.failureReason` 可观测性断言；「程序配置目录回退」阶段保留（0.0.3 改静默回退）；版本 / 产物断言自动跟随 `package.json`（0.0.3）。
- **v0.0.3 实测（`dist\npm-mirror-desktop-0.0.3.exe`，96,870,400 B，SHA256 `8f89fcb2…790c6`，2026-10-19 11:54:49）：153 项 = 143 通过 / 5 失败（均为窗口类环境限制）/ 5 跳过，退出码 3（ENVIRONMENT-LIMITED），非窗口类失败 0**；新增断言全部通过：程序配置目录回退 9/9、数据目录自动发现 9/9（`dataDirSource=parent-project`）、托盘关闭 4 项 / 开启 6 项（含「打开管理界面」「重启管理界面」）与实时切换（≤2s / ≤1s）、`window.failureReason` 非空。补充：`desktop-path-test.js` 24/24、`desktop-bridge-test.js` 11/11、`desktop-cancel-test.js` 13/13（取消 122ms 内收敛）；Lead 独立冒烟 42/42。历史 0.0.2：143 项 = 133/5/5，exit 3。

## [0.0.2] - 2026-10-19

**桌面版修复版**：修复以受限权限启动时无法创建程序配置目录导致启动失败的问题，并新增托盘「打开管理界面」菜单项。

> 下载：[GitHub Releases v0.0.2](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.2)（附件含 exe 与 `SHA256SUMS.txt`）。

### 修复

- 修复在受限环境（沙盒 / IDE 预览面板 / 继承受限 token 的启动方式）双击 exe 时报「创建桌面配置目录 … 拒绝访问 (os error 5)」并直接退出的问题：程序配置目录（运行时解压缓存 / 桌面日志 / 上次选择的目录记录）在默认位置 `%LOCALAPPDATA%\LiYueNpmMirror\` 不可写时，**自动回退到 `<exe 所在目录>\LiYueNpmMirror\`** 并在桌面日志中给出提示，不再启动即失败。仍建议从资源管理器直接双击 exe 运行；受限环境下的窗口（WebView2）功能不保证。

### 新增

- 托盘右键菜单新增 **「打开管理界面」**：用系统默认浏览器打开网页版管理页面（`http://<admin.ip>:<admin.port>/`），仅当「配置 → 桌面 / 网页管理」开启网页版管理后出现。
- 托盘菜单随网页版管理开关**实时变化（≤1 秒）**：关闭时 4 项（打开窗口 / 关闭窗口 / 重启镜像源服务 / 退出程序），开启时 6 项（多出「打开管理界面」「重启管理界面」）。

### 文档

- README / 使用说明更新托盘菜单为 4 / 6 项说明，新增「v0.0.1 启动报 `拒绝访问 (os error 5)`」排障（根因 + 正确启动方式 + 0.0.2 回退机制），版本号与下载链接更新到 0.0.2。

### 测试

- `test/desktop-e2e.ps1`：托盘断言改为关闭时 4 项 / 开启时 6 项并覆盖菜单实时切换与「打开管理界面」菜单动作；新增「程序配置目录回退」阶段（`%LOCALAPPDATA%` 不可写 → 回退 `<exe目录>\LiYueNpmMirror`）。0.0.2 实测：143 项 = 133 通过 / 5 失败（均为窗口类环境限制）/ 5 跳过，exit 3，非窗口类失败 0（0.0.1 历史：119 通过 / 5 失败 / 4 跳过，exit 3）。

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

[0.0.5]: https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.5
[0.0.2]: https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.2
[0.0.1]: https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.1
[1.0.0]: https://github.com/SuLiyue-s/npm-mirror/releases/tag/v1.0.0
