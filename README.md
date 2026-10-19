# 私人 npm 镜像源（离线版）

**零第三方依赖、可离线迁移的私人 npm 镜像源**：本地缓存公共包 + 私有包仓库 + 中文可视化管理界面 + 离线 bundle 导出导入，一个 Node.js 进程跑起来，不需要数据库、不需要构建、不需要联网安装依赖。

- 运行环境：Node.js **>= 18**（实测 Node.js 24），Windows / macOS / Linux 均可运行服务本体（一键脚本为 Windows `.cmd` / PowerShell）
- 默认地址：镜像源（npm registry）<http://127.0.0.1:4873>，管理界面 <http://127.0.0.1:4874>（**两个独立监听**：管理界面只监听 `127.0.0.0/8` 本地回环，只有本机访问才能打开；端口不可与镜像源端口相同，可在配置页/`data/config.json` 的 `admin` 段修改）
- 依赖数量：**0**（`dependencies` 与 `devDependencies` 均为空）
- 桌面版：**单 exe（版本 0.0.7，本地构建交付版）**，`dist/npm-mirror-desktop-0.0.7.exe`，双击即用、内嵌 Node 运行时，带托盘 / 控制台页 / 工具页 / 主数据目录选择 / 开机自启；**exe / 窗口 / 托盘图标统一使用网页版图标 `public/favicon.ico`**；**启动时自动检测 exe「低完整性（Low）」标签并可一键修复（UAC 提权 `icacls` 重置后自动重启）**；**必须从资源管理器双击运行**（见 [启动必读](#启动必读重要)），详见 [桌面版（单 exe）](#桌面版单-exe)
- 许可证：[MIT](LICENSE)

![管理界面概览](截图/管理界面-概览.png)

## 它能做什么

- **公共包缓存**：`npm install` 走本镜像时自动回源上游（默认 `https://registry.npmmirror.com`）并缓存元数据与 tarball（**支持配置多个「加速镜像源」下载 tarball**：版本元数据仍从上游源取，下载时并行探测各加速镜像，优先走「有这个版本且响应最快」的，缺版本或内容校验不通过会自动换下一个，全部不可用再回上游源，下载后同样做 integrity/shasum 校验；配置页多行输入框使用项目风格自绘拖拽角标，保存/测试前自动清理空行与每行首尾空白，并可一键「测试连通性」只读探测每个加速源的元数据与测试包 tarball（逐源显示耗时与中文原因））；支持 `cache`（本地优先）/ `proxy`（过期即回源）/ `offline`（纯离线）三种模式
- **私有包仓库**：支持 `npm publish`、`npm unpublish`、`npm deprecate`、`npm dist-tag`，私有包与上游同名包隔离，不会混淆
- **离线迁移**：导出整个镜像为单个 `.tgz` bundle，拷贝到无网络电脑后导入；也支持直接导入本机 `~/.npm/_cacache` 已有缓存。**导出选中包时默认连带递归依赖，镜像里没有的依赖会在联网模式下自动从上游下载并入库再一起打包**；下载失败不会中断导出，失败依赖会连原因一起记进 bundle 清单并在界面/命令行提示。**导出选中包还可以只导出指定版本**（`versions` 白名单，留空=全部本地版本）；带依赖导出时按所选版本的 `dependencies` 解析出精确依赖版本，并保证这些依赖版本的 tarball 一起打包（本地缺的自动补下，确实取不到会明确报错而不是静默漏包）。**导出和导入都有详细进度弹窗**：一条总进度（导出按字节/文件数，导入按解包字节与包数）+ 逐包明细（已打包 / 新增 / 失败 / 跳过）+ 右栏并行进度（导出「并行文件」一行一个正在压缩的文件，导入「并行包」一行一个在导入的包），长任务可取消；**导出压缩完成后把并行分片拼成最终 `.tgz` 也有进度**（压缩阶段进度条最多停在 95%，统计行显示「正在拼接分片写入最终 .tgz：X / Y GB」、右栏标题切「正在写入 · 拼接分片」，写完再显示「正在写入 · 收尾」，49.4GB 的整机备份这段约 30~60 秒，不会再出现「100% 却不动」的错觉）。**导出还支持「按添加时间」范围**（只带走某段时间内首次添加进本地镜像的包，留空一端表示不限，时间按本机时区；起止时间点点击输入框会弹出**项目风格的自绘日历弹层**：月历 + 时/分自绘下拉 + 清除/现在/取消/确定，不是浏览器原生日历）；**导出/导入都支持多包并行**（默认 4 路，可配置），备份再导入不会因为 tarball 根目录名不叫 `package/` 而误判成坏包（`@types/*` 这类历史包也能正常导入）。**导入结束后弹窗底部会整理出一块「导入结果详情」**：失败逐条列出（`包名@版本：原因`）、跳过按原因归类计数，右上角一键复制清单，不用再去左栏一条条翻。**从本机 npm 缓存导入时会保留完整版本号**：扫描到的元数据里那些本机没有缓存 tarball 的版本只写元数据、不下载 tarball，避免导入后 packument 残缺导致后续「递归添加依赖」报「没有满足 xxx 的版本」；依赖解析发现本地元数据残缺时还会自动回源补全一次（联网 `cache`/`proxy` 模式；`offline` 模式不联网）。**导出选中包时还可以只导出指定版本**：迁移页「指定版本」多行框每行写 `包名@版本`（留空 = 全部本地版本，可一键「生成模板」列出已选包的全部版本），带依赖导出时依赖按所选版本的 `dependencies` 逐个解析出确定版本、只打包真正需要的版本——bundle 里的 `packument.json`/`meta.json` 也会裁剪成只含被导出的版本（`dist-tags.latest` 同步收敛），体积明显变小；命令行用 `--versions vue@3.4.1,react@18.2.0` 或位置参数 `包名@版本`。**「按添加时间」导出可选口径**：按包（整包）或按版本（只导出区间内新写入本地 tarball 的版本，旧包里没更新的版本不用重复打包；版本时间取本地 tarball 文件写入时间，bundle 内 `packument.json`/`meta.json` 同步裁剪），命令行用 `--added-by package|version`。
- **可视化管理界面**：概览、包管理、迁移备份（含本机缓存导入）、配置、日志、服务控制共 6 个页面，中文界面，全按钮操作；**顶栏实时区分显示「管理界面 / 镜像源服务」两种连接状态**（两个独立 chip，「管理界面 · 已连接 / 断开」探测管理界面监听本身：每 1 秒同源请求一次 `/__admin/api/session`，页面重新可见 / 窗口聚焦时立即补测，断线自动重试并在悬停提示里显示重试次数，**断开恢复或管理界面实例标记（`pid` + `admin.startedAt`）变化后自动刷新界面**；「镜像源服务 · 已连接 / 断开 / 未知」来自同一次响应的 `registry.reachable`——后端在管理界面里向镜像源监听探测 `/-/ping`，与镜像源端口分离，**镜像源服务状态变化只更新该 chip 和 toast，不刷新页面**）；管理界面、镜像源服务、整个程序可分别重启（配置页黄条按改动类别出现「重启镜像源服务 / 重启管理界面 / 重启程序」按钮，服务页也有对应入口，CLI 为 `restart` / `restart-admin` / `restart-process`）；**顶栏「运行 xx」每秒实时刷新**（以概览接口的 `uptimeSec` 快照为基准、由本地时钟每秒累加，不额外请求后端；概览页与系统-服务页的「运行时长」卡片同步跳动，服务重启后自动重新计时）；包详情、依赖解析、任务进度以抽屉/弹窗呈现；**所有鼠标悬停提示都是项目风格的自绘浮层**（深色面板 + 青色强调条 + 等宽小字），不是浏览器原生 `title` 小黄框；**所有原生下拉的展开列表都换成了项目风格的自绘下拉**（触发按钮 + 深色面板、青色选中/悬停，支持鼠标、键盘 ↑↓/Enter/Esc/Tab 与点外面关闭；底层保留原生 `<select>` 语义，`value`/`change` 读写不变，动态创建/重建选项的下拉也会自动接管），搜索框的原生清除叉、数字框的原生上下箭头一并收掉，浏览器原生 `confirm` 换成项目风格确认框；**整页的动态背景（32px 网格 + 扫描线 + 光晕 + 噪点 + 9 秒扫过亮带）同样铺进每个弹窗、抽屉、面板与统计卡的内部背景**（动效层 `pointer-events:none`，不挡点击、不影响滚动）；**任务进度弹窗里的「取消」在等待取消完成期间会禁用置灰，只有取消失败才恢复可点**；**下拉按钮右侧的小箭头在悬停、键盘聚焦与展开时也会一起变成项目青色**；**复选框对勾加粗更清晰，全选「半选」态显示横杠**
- **补齐工具链**：勾选的包一键补 tarball（dist-tag / 只补最新 / 全部版本），包管理页还有三个**不用勾选**的批量入口：「全部包补 dist-tag 版本」「全部包补最新版本」「**全部包补全部版本**」（最全，把每个包所有缺失版本都补齐，确认框会先给出还要补多少个版本的估计）；递归添加依赖（含 `npm:` 别名），后台任务可看进度、可取消（进度弹窗右栏按**每个并发下载的版本**实时显示单文件字节数）；包管理列表还有**「缺 tarball / 不缺 tarball」快捷筛选**（点一下只看还没补全的包，再点一次同一个按钮取消）；补 tarball 进度弹窗左栏最多保留 500 行，超出后自动收起「已完成」的包，给还没下完的包腾位置（出错的包永远保留，顶部提示条写明已收起多少行）；导出/导入备份的进度弹窗右栏会列出**正在并行处理的项**：导出时一行一个正在压缩的文件（`包名 · tarballs/xxx.tgz` + 文件大小 +「压缩中…」，行数＝真正并发的路数，收尾阶段也不会塌成 1 行），导入时一行一个正在导入的包（已处理版本数 / 总数，一个 worker 一个包），不再只剩 1 个「当前包」
- **零依赖实现**：HTTP 服务、tar.gz 打包解包、semver 比较、npm 协议、断点与完整性校验全部手写，无任何第三方包

## 快速开始

```bash
# 1. 获取代码（本仓库不包含 data/ 运行时数据）
git clone https://github.com/SuLiyue-s/npm-mirror.git
cd npm-mirror

# 2. 初始化配置（生成 data/config.json 与访问令牌）
node cli.js init

# 3. 启动镜像源（npm 源默认 http://127.0.0.1:4873，管理界面默认 http://127.0.0.1:4874，会自动打开管理界面）
node cli.js start
```

也可以在 Windows 上直接双击 **`启动镜像源.cmd`**。服务已经在运行时再双击（或开机自启重复触发）**不会重复启动**：脚本会先执行 `node cli.js prestart` 检查——同一端口已在运行就提示「已在运行」（并自动打开管理界面），并**补注册托盘图标**（托盘被关掉/崩掉后靠这一步恢复；已有托盘时单实例互斥体保证不会出现两个图标），检测到运行在其它端口则提示先停止，不会再抢端口或重复启动服务。

> 首次启动后，管理界面的「配置」页与 `data/config.json` 里都能看到访问令牌（`security.token`）。

### Windows：托盘图标

双击 `启动镜像源.cmd` 后，命令行窗口会在服务就绪后自动隐藏，右下角通知区域出现**项目图标**（薄荷绿圆角方块，与网页 favicon 同一套自绘图标）：

| 操作 | 效果 |
| --- | --- |
| 左键单击托盘图标 | 打开网页端管理界面（`http://127.0.0.1:<管理界面端口>/`），不用记地址 |
| 右键 → 「打开控制台」 | 显示命令行窗口，可看日志、按 `Ctrl+C` 停止；窗口已显示时这一项换成「隐藏控制台」 |
| 右键 → 「隐藏控制台」 | 重新把命令行窗口收到后台，服务继续运行 |
| 右键 → 「打开管理界面」 | 用系统默认浏览器打开网页端管理页面（`http://127.0.0.1:<管理界面端口>/`），不用记地址 |
| 右键 → 「重启管理界面」 | 只重启管理界面监听（改过 `admin.ip/admin.port` 后用它生效），镜像源服务不中断，网页会自动重连并刷新 |
| 右键 → 「重启镜像源服务」 | 让镜像服务自己重启：旧进程退出、新进程用相同端口与配置接管，托盘和命令行窗口都不关；改过镜像源 `server` 配置需要重启时最方便 |
| 右键 → 「退出镜像源」 | 停止镜像服务并关闭托盘（命令行窗口一并关闭） |

- 托盘图标可能被 Windows 收进通知区域的 **「^」溢出区**：点「^」拖到任务栏即可固定显示。
- 用的是系统自带的 Windows PowerShell，不需要额外安装任何东西；脚本在 `tools/tray.ps1`，图标由 `tools/make-icon.ps1` 自绘生成（`public/favicon.ico`）。
- 停止服务也可以双击 `停止镜像源.cmd`，托盘会在几秒内检测到服务已停止并自动退出。
- 在 Windows Terminal 里手动输入命令启动时托盘不参与（直接把窗口留着即可）；需要托盘就双击 `.cmd`。若托盘没有出现，命令行窗口会保持显示并给出提示，服务本身不受影响。

## 桌面版（单 exe）

不想装 Node.js、也不想开命令行窗口？用桌面版：**一个 exe 双击即用**，把 Node 运行时、镜像源服务、管理界面与托盘图标打包在一起。

### 启动必读（重要）

- **必须从 Windows 资源管理器里双击 exe 运行**（或双击 `启动桌面版.cmd`）。exe 位于 `dist\` 时，双击 `dist\npm-mirror-desktop-0.0.7.exe`。
- **不要在聊天窗口 / IDE 预览面板 / 沙盒 / 受限终端里启动**：这些环境会让程序继承受限权限，`%LOCALAPPDATA%` 无法写入、WebView2 无法创建窗口、系统托盘注册会被拒绝（`os error 5`），表现为「没有窗口 / 没有托盘图标 / 没有右键菜单，但任务管理器里有进程」。v0.0.2 的用户日志已证实这一点（`%LOCALAPPDATA%` 写入被拒 `os error 5`、WebView2 `runtime error: failed to receive message from webview`）。
- **低完整性（Low）标签（v0.0.5 检测，v0.0.6 修复算法修正，v0.0.7 重启方式改进）**：Windows 用「用户令牌完整性级别」与「exe 文件完整性标签」中**较低的那个**启动进程。开发 / 沙箱工作区可能给整个项目目录打上 Low 标签，构建出来的 exe 会继承它，双击后进程被强制降级——写不了 `%LOCALAPPDATA%`、托盘注册被拒。**v0.0.5 起启动会自动检测这种标签并弹框；v0.0.6 修正了修复算法**：选「是」→ 请求一次 UAC → **提权后调用系统 `icacls.exe` 把 exe 文件标签改为 Medium**（只改文件标签，不是「提权重启自身」——`min(用户,文件)` 规则下提权实例对自身 Low 文件仍是 Low 完整性，这条旧路走不通）→ 复查标签为 Medium 后**以普通权限自动重启**程序，之后正常。若修复失败，按提示两条退路：①**把 exe 复制到其它文件夹**（如桌面）再双击——复制出的文件继承目标目录的正常标签；②右键「以管理员身份运行」命令提示符，执行 `icacls "<exe路径>" /setintegritylevel Medium`。选「否」则继续受限运行（窗口内显示警示条、关闭窗口=退出程序）。也可直接双击 `修复-桌面版启动限制.cmd`（或 `启动桌面版.cmd`，它会在启动前自动检查并修复）。
- 版本行为差异：v0.0.2 回退配置目录但仍可能只留下无界面进程；v0.0.3 在窗口 / 托盘异常时弹可操作说明框后清理退出；**v0.0.4 起托盘改为程序自绘 Win32 注册**——注册失败会每秒重试、最多 15 秒，仍失败则在日志记录「托盘注册失败：…」并在**窗口内显示警示条**，此时**关闭窗口会直接退出程序**（不会静默隐藏到后台），请按提示改用资源管理器双击；配置目录写不了时仍**静默回退**到 `<exe 所在目录>\LiYueNpmMirror\`，只写日志不弹框。**v0.0.5 增加低完整性标签检测/一键修复，v0.0.6 修正修复算法（提权后改文件标签，不再是提权重启自身），v0.0.7 把修复后的重启改为提权 cmd 助手（icacls 修标签 → 约 2 秒 → explorer 非提权拉起）**（见上一条）。
- **程序图标（v0.0.4）**：exe、窗口、托盘统一使用网页版图标 `public\favicon.ico`，不再是「旧图标 + Tauri logo」合成图，托盘和浏览器标签页视觉一致。
- **托盘图标可能被 Windows 收进任务栏右侧的「^」溢出区**：点「^」把图标拖到任务栏即可固定显示；程序不会因为图标被收起而停止。
- 数据目录默认 `<exe 所在目录>\data`；把 exe 放在项目的 `dist\` 里时，**会自动发现并使用上级项目的 `data\`**（详见下表与「使用要点」）。
- **本次 0.0.7 为本地构建交付版，暂不发布 GitHub**：构建产物保留在 `dist\npm-mirror-desktop-0.0.7.exe`；是否发布待用户确认。最近一次 GitHub 发布仍是 [v0.0.5](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.5)；v0.0.3 / v0.0.4 / v0.0.6 为按用户要求只在本地构建、未发布的版本。

| 项目 | 说明 |
| --- | --- |
| 版本 | **0.0.7**（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 三处一致；**本地构建交付版，暂不发布 GitHub**） |
| 构建产物 | `dist/npm-mirror-desktop-0.0.7.exe`（单文件，内嵌 Node 运行时与全部程序文件） |
| 下载 | 0.0.7 暂未发布、无下载链接（本地构建）；GitHub 最近发布版为 [v0.0.5](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.5)，历史版本 [v0.0.2](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.2) / [v0.0.1](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.1) 仍可下载；v0.0.3 / v0.0.4 / v0.0.6 未发布（仅本机构建） |
| 发布者（版本信息） | **v0.0.6 起** exe 的「发布者 / CompanyName」固定为 `suliyue`（资源管理器 → 右键属性 → 详细信息可看到）；**未做代码签名**，所以 SmartScreen / UAC 仍显示「未知发布者」，属正常现象 |
| 程序图标 | **v0.0.4 起** exe / 窗口 / 托盘统一使用网页版图标 `public\favicon.ico`（与浏览器标签页同一套图标） |
| 启动方式 | **Windows 资源管理器双击 exe**，或双击仓库根目录的 `启动桌面版.cmd`（自动检查「低完整性」标签并在需要时请求一次 UAC 修复，然后启动 `dist\` 里最新的桌面版 exe） |
| 系统要求 | Windows 10/11 x64；需要系统自带 **WebView2 运行时**（Win11 默认已装，Win10 可装 Evergreen Runtime） |
| 数据目录 | 默认 `<exe 所在目录>\data`，与网页版 / 命令行版共用同一套数据格式；**v0.0.3 起会自动发现上级项目 `data\`**（见「桌面版特性」），也可在配置页用「选择目录…」更换 |
| 程序配置目录 | 启动前按五级顺序探测可写目录：`MIRROR_DESKTOP_HOME` → `%LOCALAPPDATA%\LiYueNpmMirror\` → `<exe 所在目录>\LiYueNpmMirror\` → `%TEMP%\LiYueNpmMirror\` → `<exe 所在目录>\.LiYueNpmMirror\`；v0.0.3 起回退时**只写日志、不弹框** |
| 与网页版的关系 | 窗口里显示的就是现有管理界面（同一套 `public/`），另外多出「控制台」「工具」两个页面。窗口通过**带本次运行随机令牌的内部回环地址**加载管理界面（v0.0.7：内部管理端口无令牌/错误令牌一律 403，正确令牌 302 + `Set-Cookie` 后才可访问；令牌不写日志、不出现在 `/desktop/info`）；网页版管理端口（开启 `admin.enabled` 后）仍是原来的 `admin.ip/admin.port` 访问方式，不受内部令牌门禁影响；镜像源监听、管理 API、令牌机制一致 |

### 桌面版特性

- **单文件运行**：exe 内嵌 node.exe 与全部程序文件，首次运行解压到程序配置目录的 `runtime\<版本>\`，之后直接复用；目标机器无需安装 Node.js。程序配置目录不可写（受限账户 / 沙盒 / 安全软件拦截）时，**v0.0.2 起自动回退**到 `<exe 所在目录>\LiYueNpmMirror\`（v0.0.3 起回退只写日志、不再弹框），不再直接启动失败。
- **图标与网页版一致（v0.0.4）**：exe 文件图标、窗口图标、托盘图标全部改用 `public\favicon.ico`（网页版标签页图标），不再使用「旧图标 + Tauri logo」的合成图；`tools\compose-desktop-icon.ps1` 只负责从网页版图标生成窗口 / 托盘所需的 RGBA 素材。
- **启动失败可见化（v0.0.3 起，v0.0.4 增强）**：创建窗口 / 托盘后校验实际可用性。窗口创建失败仍弹出可操作说明框（用资源管理器双击 exe、安装 WebView2 Runtime、不要在受限终端启动）后清理退出；**v0.0.4 托盘改为自绘 Win32 注册**，每秒重试、最多 15 秒，仍失败则写日志「托盘注册失败：…」并在窗口内显示警示条，此时**关闭窗口 = 直接退出程序**，不会再出现「进程在跑却看不到窗口和托盘」的静默状态。
- **托盘自愈（v0.0.4）**：Windows 资源管理器重启后，程序会收到 `TaskbarCreated` 消息并自动重新注册托盘图标，不需要重启程序。
- **低完整性标签自动检测与一键修复（v0.0.5 检测，v0.0.6 修复算法修正，v0.0.7 重启方式改进）**：启动时检测「当前进程令牌完整性级别」和「exe 文件完整性标签」；若 exe 带 **Low（低完整性）** 标签，会弹出说明框。**v0.0.6 的修复流程**：选「是」→ 请求 UAC 提权 → 在提权进程里调用**系统 `icacls.exe`** 执行 `icacls "<exe>" /setintegritylevel Medium` 修改的是**文件标签**（不是提权重启自身：按 `min(用户,文件)` 规则，提权后的进程面对自身 Low 文件仍是 Low 完整性，旧方案因此无效）→ 复查文件标签确为 Medium → **以普通权限自动重启**程序。**v0.0.7 起重启改为「提权 cmd 助手」**：修复进程写入一个临时批处理后由提权命令行执行「icacls 修复 → 等待约 2 秒 → 用 explorer 以普通权限拉起 exe」，不再尝试从提权进程直接重启自身界面，兼容性和可观察性更好。若修复失败（UAC 取消、文件只读、组策略限制等），提示两条退路：①**把 exe 复制到其它文件夹**（如桌面）再双击——复制出的文件继承目标目录的正常标签；②右键「以管理员身份运行」命令提示符，执行 `icacls "<exe路径>" /setintegritylevel Medium`。选「否」则继续以受限方式运行并显示警示条。该问题常见于**从开发 / 沙盒目录构建出的 exe**（整个目录被打了 Low 标签，产物继承标签）；从 GitHub Release 下载到普通目录的 exe 一般不受影响。每次重新编译 exe 后都会重新继承 Low 标签，再次启动时会再次提示（或双击 `修复-桌面版启动限制.cmd` 修复）。
- **数据目录自动发现（v0.0.3）**：启动顺序 `--data-dir` > `MIRROR_DATA_DIR` > 上次「选择目录…」记录 > `<exe 目录>\data`（已有 `config.json` 或 `storage\` 时）> 上级项目 `data\`（`<exe 目录>\data` 不存在/为空且上级 `data\config.json` 存在时）> `<exe 目录>\data`（默认）。因此把 exe 放在项目的 `dist\` 里双击，会直接读到 `项目根\data` 的现有配置与包。
- **`启动桌面版.cmd`（v0.0.3）**：仓库根双击即启动 `dist\` 下最新的桌面版 exe，并打印窗口 / 托盘 / 网页版管理与启动方式提示；找不到 exe 时给出构建或放置提示。
- **托盘常驻（v0.0.7）**：托盘可用时，关闭窗口只是隐藏，托盘图标继续运行镜像源；左键单击打开窗口。右键菜单随网页版管理开关实时变化（**≤2 秒**）：关闭时 **5 项**「打开窗口 / 关闭窗口 / 重启窗口的管理界面 / 重启镜像源服务 / 退出程序」；开启时 **7 项**「打开窗口 / 关闭窗口 / 重启窗口的管理界面 / 打开管理界面 / 重启管理界面 / 重启镜像源服务 / 退出程序」。新增的「打开管理界面」用系统默认浏览器打开网页版管理页面（`http://<admin.ip>:<admin.port>/`）；「重启管理界面」只重建网页版管理监听；**「重启窗口的管理界面」只重启窗口 GUI 使用的内部管理界面（127.0.0.1 随机端口 + 每次启动的新令牌）**，镜像源与网页版管理都不受影响，重启后窗口会重新打开并换发新令牌。**托盘注册失败时（受限环境）没有托盘菜单，且关闭窗口 = 退出程序**。
- **控制台页**：把服务日志、一键脚本输出、桌面端操作日志实时汇总（最多保留 3000 行），可暂停 / 继续 / 清空 / 复制 / 下载，按级别与来源筛选。
- **工具页**：桌面程序信息（版本 / 程序路径 / 主数据目录 / 运行模式）、重启程序 / 退出程序 / 隐藏窗口、重启镜像源 / 重启管理界面 / 打开网页版管理、开机自启开关、一键脚本（环境自检 / 查看状态 / 从 npm 缓存补包 / 一键导出全部包 / 一键导入离线包）、打开数据目录 / 日志目录 / 配置文件。
- **网页版管理开关**（`admin.enabled`，默认 **关闭**）：默认桌面版不开放浏览器可访问的管理端口，只能从桌面窗口管理；需要浏览器 / 局域网访问时在「配置 → 桌面 / 网页管理」打开，端口即 `admin.ip` / `admin.port`（默认 `127.0.0.1:4874`），保存即时生效、不用重启程序。
- **主数据目录可选**：「配置 → 桌面 / 网页管理」里的只读输入框显示当前数据目录，点「选择目录…」用系统原生文件夹选择器换到其它磁盘（如空间更大的 D 盘），切换后程序自动重启并使用新目录。
- **开机自启**：工具页一键开关，写入当前用户注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（值名 `LiYueNpmMirror`），登录后隐藏窗口启动到托盘，不需要管理员权限。
- **单实例（v0.0.7 等待与接管）**：重复双击 exe 不会起第二个服务：新实例发现已有实例时最多等待约 **15 秒**（期间周期性把已在运行的窗口调到前台），确认已有实例健康后自行退出；如果旧实例恰好在此期间退出，新实例会接管并启动服务，避免「双击后什么都没发生」或出现两个服务。
- **路径穿越防护**：主数据目录 / `storage.dir` 统一走数据根校验，相对路径不能逃出数据目录（`../`、`..\`、绝对路径、NUL 等一律拒绝），并有单测 `test/desktop-path-test.js` 覆盖。
- **旧数据直接兼容**：把 exe 放进现有项目根目录（默认数据目录就是 `项目根\data`），即可直接读到原 `config.json`、`storage/` 里的包与日志；旧的 `storage.dir: "data/storage"` 也能正确解析。

### 构建桌面版（本机离线）

```powershell
# 在仓库根目录执行：校验三处版本号一致 → 嵌入 node.exe → 校验/生成图标（源图 = public/favicon.ico）→ 离线 cargo build → 输出 dist
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-desktop.ps1

# 可选参数
#   -NodeExe <路径>   指定要内嵌的 node.exe（默认取 PATH 里的 node）
#   -ForceIcon        强制重新合成图标
#   -DebugBuild       构建 debug 版（产物 dist/npm-mirror-desktop-debug.exe）
#   -NoOffline        允许 cargo 走网络（默认强制离线）
```

- 构建环境：Windows + Rust（msvc toolchain）+ Visual Studio 生成工具 + Windows SDK；仓库已把 cargo 依赖缓存放在 `tmp/cargo-home`（约 357MB，**不要删**），构建脚本默认用 `CARGO_HOME=<repo>\tmp\cargo-home` + `CARGO_NET_OFFLINE=true` 离线构建，无网络也能编译。
- 产物：`dist/npm-mirror-desktop-<版本>.exe` + `dist/SHA256SUMS.txt`（SHA256 校验清单，可用 `Get-FileHash` 或 `certutil -hashfile` 对照）。
- 图标：v0.0.4 起 exe / 窗口 / 托盘统一使用网页版图标 `public\favicon.ico`；构建脚本校验 `src-tauri\icons\icon.ico` 等素材，缺失或加 `-ForceIcon` 时调用 `tools\compose-desktop-icon.ps1` 从网页版图标重新生成。
- **低完整性标签提示（v0.0.5 构建脚本）**：构建完成后 `tools/build-desktop.ps1` 会用 `icacls` 检查产物；若新 exe 继承了工作区的 **Low（低完整性）** 标签，会打印黄色提示说明原因与修复方式（程序启动时可一键修复，也可双击 `启动桌面版.cmd` / `修复-桌面版启动限制.cmd`）。**这属于开发/沙盒环境的正常现象，不是构建失败**；发布到 GitHub 前一般不会带该标签（从仓库正常构建的 exe 不会继承）。每次重新编译后新 exe 会再次继承 Low，需要再次修复。
- **发布者信息（v0.0.6 起）**：`src-tauri/tauri.conf.json` 中 `bundle.publisher = "suliyue"`，构建出的 exe 版本信息 `CompanyName` 固定为 `suliyue`（资源管理器 → 右键属性 → 详细信息可见）。程序**未做代码签名**，所以 SmartScreen / UAC 仍会显示「未知发布者」，这是正常现象，不是文件损坏。
- **本次 0.0.7 为本地构建交付版，暂不发布 GitHub**：产物 `dist\npm-mirror-desktop-0.0.7.exe` 与 `dist\SHA256SUMS.txt` 只在本机交付；是否发布待用户确认。最近一次 GitHub 发布仍是 [v0.0.5](https://github.com/SuLiyue-s/npm-mirror/releases/tag/v0.0.5)；v0.0.3 / v0.0.4 / v0.0.6 为本地构建、未发布。
- 版本号唯一来源是 `package.json`，`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 用 `node tools/version.js --bump patch` 同步；发版用 `tools/release.ps1`（bump → 构建 → 提交 → tag → GitHub Release）。
- 构建后若需要手动确认/修复完整性标签，可双击根目录的 **`修复-桌面版启动限制.cmd`**（不带参数=检查并在需要时请求 UAC 修复；`check`=只检查，退出码 0 正常 / 2 带 Low 标签；`repair`=内部提权后实际修复）；环境诊断可双击 **`诊断-桌面环境.cmd`**（只读，输出 `tmp\desktop-diagnose.txt`）。
- `dist/`、`src-tauri/target/`、`src-tauri/embed/node.exe` 均不入库（见 `.gitignore`）。

### 桌面版使用要点

1. **从资源管理器双击** `dist\npm-mirror-desktop-0.0.7.exe`（或双击 `启动桌面版.cmd`）。首次启动会自动初始化数据目录并生成配置与访问令牌：默认用 `<exe 所在目录>\data`；若 exe 在项目的 `dist\` 里而 `<exe 目录>\data` 不存在/为空、上级 `data\config.json` 存在，则**自动改用项目根 `data\`**（v0.0.3 新增）。**不要从聊天窗口 / IDE 预览面板 / 沙盒 / 受限终端启动**：会因继承受限权限导致 WebView2 窗口不可用、托盘注册被系统拒绝（v0.0.5 起会先检测低完整性标签并弹框修复，v0.0.6 修正修复算法，v0.0.7 修复后的重启改为提权 cmd 助手；v0.0.4 会在窗口内显示警示条；v0.0.3 会弹说明框并清理退出；v0.0.1/v0.0.2 则可能只留下看不到界面的进程）。
2. 窗口打开的就是管理界面；「控制台」「工具」页在左侧导航里（`MONITOR` / `SYSTEM` 分组）。若托盘图标没出现在任务栏右下角，点「^」到溢出区里找（可拖到任务栏固定）。
3. 托盘可用时，点窗口右上角 **×** 只是隐藏窗口，镜像源继续运行；要彻底退出请用托盘右键「退出程序」或工具页的「退出程序」。托盘右键还有「**重启窗口的管理界面**」（只重启窗口 GUI 用的内部管理界面并换发新令牌，不打断镜像源与网页版管理）。**若托盘注册失败（受限环境，窗口内有警示条）**，关闭窗口会直接退出程序。
4. 换数据目录：配置页 →「桌面 / 网页管理」→「选择目录…」→ 选一个**已存在**的文件夹 → 确认后程序自动重启并切到新目录。**数据不会自动搬迁**，需要迁移时先退出程序，把旧 `data\` 整个复制到新位置再启动。
5. 从旧版迁移：把 exe 放进现有项目的 `dist\` 或项目根目录运行，v0.0.3 会自动发现并使用 `项目根\data`；也可以把旧 `data\` 复制到 exe 同级的 `data\`，或在配置页用「选择目录…」指过去。
6. 卸载：退出程序后删除 exe 与 `data\` 即可；开机自启在工具页关掉（或删除注册表 `LiYueNpmMirror` 值），程序配置目录（默认 `%LOCALAPPDATA%\LiYueNpmMirror\`，不可写时是 `<exe 所在目录>\LiYueNpmMirror\`，含运行时解压缓存 / 桌面日志 / 目录记录）可一并删除。

完整图文操作见 **[使用说明.md 第十三章「桌面版（Tauri 单 exe）」](使用说明.md#十三桌面版tauri-单-exe)**。

### 桌面版常见问题

**Q：启动报「创建桌面配置目录 … 拒绝访问 (os error 5)」/ 双击后没有窗口也没有托盘，但任务管理器里有进程？**
根因都是**从受限环境启动**（聊天窗口、沙盒、IDE / 本会话预览面板、受限终端）：程序继承受限 token，`%LOCALAPPDATA%` 写不了（`os error 5`），WebView2 也拿不到窗口与托盘（`runtime error: failed to receive message from webview`）。
正确处理：到 **Windows 资源管理器里双击** `dist\npm-mirror-desktop-0.0.7.exe`（或双击 `启动桌面版.cmd`，也可把 exe 复制到桌面再双击）。版本差异：v0.0.1 直接报错退出；v0.0.2 会回退配置目录但仍可能只留下无界面进程；v0.0.3 会弹出一段可操作说明框后清理退出；**v0.0.4 托盘注册失败前会重试 15 秒，失败后在窗口内显示警示条并在日志记录「托盘注册失败」**；**v0.0.5 起启动时先检测低完整性标签，弹框选「是」可一键修复（UAC）并自动重启；v0.0.6 修正为「提权后改 exe 文件标签、复查 Medium、再以普通权限重启」；v0.0.7 把修复后的重启改为提权 cmd 助手（icacls 修标签 → 约 2 秒 → explorer 非提权拉起），修复失败会提示复制到其它文件夹或管理员 cmd 执行 `icacls` 两条退路**。受限环境下的窗口 / 托盘功能不保证，**请始终用资源管理器启动**。

**Q：双击 exe 后弹框提示「低完整性（Low）」/ 修复后要 UAC？**
这是 **Windows 完整性标签**机制：进程会按「用户令牌完整性」和「exe 文件完整性」中**较低**的那个运行。若 exe 继承自被打上 Low 标签的开发 / 沙盒目录，双击后进程会被强制降级——`%LOCALAPPDATA%` 写不了、托盘注册被拒（`os error 5`），表现为没有窗口 / 没有托盘。
**v0.0.5 起启动时会自动检测**并弹框说明。**v0.0.6 的修复流程**：选「是」→ 弹一次 UAC → 提权后调用系统 `icacls.exe` 执行 `icacls "<exe>" /setintegritylevel Medium` **修改 exe 文件标签**（不是「提权重启自身」：`min(用户,文件)` 规则下提权进程面对自身 Low 文件仍是 Low 完整性，旧算法因此无效）→ 复查标签确为 Medium → **以普通权限自动重启**程序。**v0.0.7 起重启方式改为提权 cmd 助手**：提权进程把「icacls 修复 + 等待约 2 秒 + 用 explorer 以普通权限拉起 exe」写进临时批处理交给提权命令行执行，不再从提权进程直接拉起自身界面，兼容性更好（smoke / 自动化场景下不弹框，只记录状态）。选「否」则继续受限运行（窗口内警示条、关闭窗口=退出程序）。若修复失败（取消 UAC / 文件只读 / 组策略限制），按提示两条退路：①把 exe **复制到其它文件夹**（如桌面）再双击——复制出的文件继承目标目录的正常标签；②右键「以管理员身份运行」命令提示符，执行 `icacls "<exe路径>" /setintegritylevel Medium`。也可以退出程序后双击根目录的 **`修复-桌面版启动限制.cmd`**（或直接双击 `启动桌面版.cmd`，它会在启动前自动检查并修复）。每次重新编译 exe 后都会重新继承 Low 标签，需要再次修复；从 GitHub Release 下载到普通目录的 exe 一般不受影响。

**Q：右下角托盘图标完全不出现（没有图标、也没有右键菜单）？**
先看桌面日志 `desktop.log`（默认 `%LOCALAPPDATA%\LiYueNpmMirror\desktop.log`，回退时在 `<exe 所在目录>\LiYueNpmMirror\desktop.log`）：出现「**托盘图标已注册**」表示注册成功（图标可能只是被收进任务栏「^」溢出区，拖到任务栏即可固定）；出现「**托盘注册失败：…**」表示系统拒绝注册，常见于从受限环境 / 受限账户启动（日志含「拒绝访问 / os error 5」），此时 v0.0.4 会在窗口内显示警示条，**关闭窗口 = 退出程序**，请改用资源管理器双击 exe。另一种情况是 Windows 资源管理器重启（任务栏重建）导致图标消失：**v0.0.4 会自动重新注册**（收到 `TaskbarCreated` 消息，约 1 秒内恢复），旧版本则需重启程序。若组策略禁用了通知区域，任何程序都无法显示托盘图标。

**Q：把 exe 放在 `dist\` 里运行，数据却建到了 `dist\data`、读不到项目原来的数据？**
v0.0.2 及更早版本默认用 `<exe 目录>\data`，所以会新建一个空数据目录。**v0.0.3 起会自动发现上级项目数据**：当 `<exe 目录>\data` 不存在或为空、而 `<exe 目录>\..\data\config.json` 存在时，自动使用 `项目根\data`（桌面日志与 `/desktop/info` 的数据目录来源会显示 `parent-project`）。若想强制指定：用「配置 → 桌面 / 网页管理 → 选择目录…」，或启动参数 `--data-dir <路径>`。

**Q：启动后看不到窗口 / 托盘图标？**
先按上一条确认是从资源管理器启动；确定是普通桌面会话时，检查系统是否安装 **WebView2 运行时**（Win11 自带），并查看程序配置目录下的 `desktop.log`（默认 `%LOCALAPPDATA%\LiYueNpmMirror\desktop.log`，不可写时在 `<exe 所在目录>\LiYueNpmMirror\desktop.log`）：窗口问题看 `window.failureReason` 一类记录，托盘问题看「托盘图标已注册 / 托盘注册失败」。托盘图标也可能只是被收进了任务栏「^」溢出区。

**Q：导入离线包时点了取消，一直显示「等待开始…」？**
这是 v0.0.2 及更早版本的缺陷，**v0.0.3 已修复**：取消会中止解包 / 扫描 / 写入各阶段并在约 1~2 秒内进入「已取消」，未完成包的临时目录会清理，不影响之后的正常导入导出。

**Q：进度弹窗右栏的包名太长，看不到「N 路」并发数？**
**v0.0.3 已修复**：并发路数改为独立右对齐角标，包名再长也不会被省略号截掉。

**Q：双击没反应 / 窗口白屏？**
先确认系统装了 **WebView2 运行时**（Win11 自带；Win10 可从微软官网安装 Evergreen Runtime）。仍失败可看桌面日志 `desktop.log`（默认在 `%LOCALAPPDATA%\LiYueNpmMirror\desktop.log`，回退时在 `<exe 所在目录>\LiYueNpmMirror\desktop.log`）与数据目录 `logs\` 下的日志。

**Q：杀毒软件报毒 / SmartScreen 拦截？**
exe 未做代码签名，SmartScreen 会提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。杀软对「单文件内嵌 node.exe」比较敏感，可把 exe 与程序配置目录（`%LOCALAPPDATA%\LiYueNpmMirror\`，或回退的 `<exe 所在目录>\LiYueNpmMirror\`）加入白名单；发布资产在 GitHub Releases 附带 `SHA256SUMS.txt`，可先校验再运行。

**Q：端口被占用 / 启动失败？**
桌面版镜像源默认用 `server.port`（4873），被别的程序占用时改 `data\config.json` 的 `server.port`。`admin.port`（4874）只在开启网页版管理时才监听，同样不能与 `server.port` 相同。

**Q：数据目录选不了 / 提示路径非法？**
只接受**已存在的文件夹**；根目录（如 `D:\`）、文件路径、相对路径都会被拒绝。想用新磁盘就先在资源管理器里建好文件夹再选。权限受限的目录（如 `C:\Program Files` 下）可能写不进去，建议放用户目录或数据盘。

**Q：托盘图标不见了？**
Windows 可能把图标收进「^」溢出区，拖到任务栏即可固定；如果是资源管理器重启导致的任务栏重建，**v0.0.4 会自动重新注册**（约 1 秒内恢复）；程序退出后重新双击 exe 即可恢复。

> 网页版 / 命令行版的完整功能在桌面窗口中同样可用；桌面版专属操作细节见 [使用说明.md](使用说明.md)。

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

> 本机回环访问默认免令牌（`security.trustLocalhost: true`，覆盖整个 `127.0.0.0/8` 网段与 `::1`）；局域网共享或需要严格鉴权时，在配置里开启 `requireRead` / `requirePublish` 并分发令牌。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `node cli.js start [--port 4873] [--mode cache\|proxy\|offline] [--no-open]` | 启动服务 |
| `node cli.js stop` / `restart` / `restart-admin` / `restart-process` / `status` / `open` | 停止 / 重启镜像源服务（只重建镜像源监听） / 重启管理界面（只重建管理界面监听） / 重启整个程序 / 查看状态 / 打开管理界面 |
| `node cli.js init` / `config [--reveal]` / `token` | 初始化配置 / 查看配置（含明文令牌）/ 显示令牌 |
| `node cli.js use [--project]` / `unuse` | 切换本机 npm 源 / 还原 |
| `node cli.js list [--q 关键字] [--source all\|upstream\|private\|upload\|cache]` | 列出本地包 |
| `node cli.js add <包名[@版本]> [--with-deps] [--depth 8] [--limit 300]` | 添加公共包（可递归依赖） |
| `node cli.js remove <包名> [--version 1.2.3] [--yes]` | 删除包或单个版本 |
| `node cli.js stats` | 统计包 / 版本 / 占用空间 |
| `node cli.js export [--scope all\|private\|upstream\|selected\|added] [--from 时间] [--to 时间] [--out 文件名] [--no-deps] [--no-fetch-deps] [--versions 包名@版本,...] [--added-by package|version] [包名...]` | 导出离线 bundle（选中包默认连带依赖并自动补齐缺失依赖；`--scope added` 按添加时间导出，配 `--from/--to` 与 `--added-by package|version`（默认按包口径；version 只导区间内新增的版本）；选中包可用 `--versions` 或位置参数 `包名@版本` 只导出指定版本，依赖按所选版本解析） |
| `node cli.js import <文件.tgz\|文件.json> [--overwrite]` | 导入离线 bundle |
| `node cli.js scan-cache [--cache 目录] [--any-registry] [--refresh]` | 扫描本机 npm 缓存 |
| `node cli.js import-cache [--all] [--overwrite] [包名...]` | 从本机 npm 缓存导入 |
| `node cli.js doctor` / `logs [--lines 100] [--level info]` | 环境自检 / 查看日志 |
| `node cli.js autostart on\|off\|status` | 开机自启（登录后隐藏启动并注册托盘图标与右键快捷菜单，写入「启动」文件夹，无需管理员） |

完整参数与界面操作见 **[使用说明.md](使用说明.md)**。

## 离线迁移流程

```bash
# 有网电脑：导出整个镜像（单个 .tgz，含全部包与元数据）
node cli.js export --scope all --out npm-mirror-all.tgz

# 只带走项目用到的包：选中包 + 递归依赖（镜像里没有的依赖会自动下载入库）
node cli.js export --scope selected --out npm-mirror-used.tgz lodash express

# 拷贝 npm-mirror-all.tgz 到无网络电脑后：
node cli.js init          # 首次使用先初始化
node cli.js start         # 启动服务
# 然后打开管理界面「迁移备份」页导入，或执行：
node cli.js import npm-mirror-all.tgz
```

> 导出选中包（`--scope selected` + 包名，或界面里勾选包后点「导出选中」）默认连带递归依赖。`cache`/`proxy` 模式下，镜像里没有的依赖会自动从上游下载并入库后再一起打包；下载失败不会中断导出，失败项会写进 bundle 清单的 `missingDeps`（带原因）和 `autoFetch` 摘要，界面与命令行都会提示。`--no-deps` 关闭连带依赖，`--no-fetch-deps` 只连带已经在本地的依赖、不自动下载。纯 `offline` 模式不会联网，只会在结果里提示缺哪些依赖。

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
| `server.ip` / `server.port` | `127.0.0.1` / `4873` | 镜像源（npm registry）监听地址与端口 |
| `admin.ip` / `admin.port` | `127.0.0.1` / `4874` | 管理界面监听地址与端口。`admin.ip` **只能是 `127.0.0.0/8` 网段的本地回环地址**（如 `127.0.0.1`、`127.0.0.2`；不允许 `0.0.0.0`、`::1`、局域网地址或主机名——只有本机访问这个监听地址才能打开管理界面）；`admin.port` 不能与 `server.port` 相同。修改后只需「重启管理界面」即可生效 |
| `admin.enabled` | `false` | **是否开放网页版管理界面**（浏览器可访问 `admin.ip:admin.port`）。默认关闭：桌面版只从窗口管理、不监听固定 admin 端口；网页版 / 命令行模式固定开启，不受此项影响。桌面版在配置页打开/关闭后**即时生效**（不用重启程序），保存响应里会带回 `webAdmin` 监听状态；`admin.ip` / `admin.port` 改动仍需「重启管理界面」 |
| `mode` | `cache` | `cache` / `proxy` / `offline` |
| `upstream.registry` | `https://registry.npmmirror.com` | 上游公共源 |
| `upstream.accelerators` | `[]` | 加速镜像源列表（最多 8 个 `http(s)://` 地址）。补 tarball 时并行探测这些镜像，优先走「有这个版本且响应最快」的，缺失/超时/校验不通过自动换下一个，全部不可用再回上游源；保存即热生效，不用重启；配置页可点「测试连通性」逐源只读探测（元数据 + 测试包 tarball，失败显示中文原因），保存时自动忽略空行与首尾空白 |
| `upstream.timeoutMs` / `retries` | `30000` / `2` | 回源超时与重试次数 |
| `upstream.metadataTtlSec` | `300` | 元数据回源缓存时长（秒） |
| `upstream.concurrency` / `maxTarballMB` | `6` / `512` | 并发下载数 / 单个 tarball 上限（MB） |
| `security.token` | 随机生成 | 访问令牌（**不要提交到仓库**） |
| `security.requirePublish` / `requireRead` | `true` / `false` | 发布 / 读取是否需要令牌 |
| `security.trustLocalhost` | `true` | 本机回环地址（整个 `127.0.0.0/8` 网段与 `::1`）免令牌 |
| `storage.dir` / `storage.maxUploadMB` | `data/storage` / `500` | 包存储目录 / 单包上传上限（MB，1-4096） |
| `storage.maxBundleUploadMB` | `4096` | 网页上传整机备份（离线包）的上限（MB，1-65536）。上传走流式落盘，不占内存；更大的包可放进 `data/bundles` 后用界面「导入」 |
| `storage.bundleExportConcurrency` | `4` | 导出整机备份时的并行压缩线程数（1-64）。整数备份大、机器核数多时可调大（高核机器可调到接近逻辑处理器数），设 1 回到单线程 |
| `storage.bundleImportConcurrency` | `4` | 导入整机备份时的总并行路数（1-64）。包多时每路各管一个包；剩余包少于路数时，空闲的路会自动抢同一个包里还没导入的版本。设 1 回到串行，机械硬盘或 CPU 忙时调小更稳 |
| `storage.bundleImportExtractConcurrency` | `8` | 离线包解包（解压 + 写盘）的并发路数（1-64）。机械硬盘上并发太高反而慢，可调低到 2-4；SSD 多核可调大到 16-32 |
| `storage.bundleUploadChunkMB` / `storage.bundleUploadConcurrency` | `8` / `4` | 网页上传离线包的分片大小（MB，1-64）与并发上传路数（1-64）。浏览器同域约 6 个连接，太大反而排队 |
| `storage.localScanConcurrency` | `8` | 本地扫描 / 统计并发（1-64）：补 tarball 前统计缺失、导出备份时统计包、依赖闭包、npm 缓存扫描 / 导入、启动时索引加载等多处本地读盘阶段共用这一路并发数。SSD 多核可调大，机械硬盘调小更稳 |
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
│  ├─ console.js          桌面版控制台环形缓冲（服务日志 / 脚本输出 / 桌面事件）
│  ├─ desktop-scripts.js  桌面版一键脚本白名单执行器
│  ├─ desktop-bridge.js   Rust ↔ Node stdio 桥（桌面模式）
│  ├─ desktop.js          桌面模式初始化接线
│  └─ util.js             工具函数（semver、原子写、包名/版本校验、数据根与路径穿越防护等）
├─ public/                原生前端（app.js / index.html / style.css / favicon.ico；桌面版新增控制台页、工具页）
├─ src-tauri/             Tauri 2 桌面壳（Rust：窗口/托盘/单实例/原生对话框/自启/桥协议；embed/ 内嵌 node.exe）
├─ tools/                 辅助脚本（tray.ps1 托盘宿主、make-icon.ps1 自绘图标、compose-desktop-icon.ps1 桌面图标合成（v0.0.4 源图 = public/favicon.ico）、build-desktop.ps1 桌面版构建、diagnose-desktop.ps1 桌面环境诊断、version.js 版本同步、release.ps1 发版）
├─ test/                  自动化测试与验收脚本（desktop-e2e.ps1 桌面版端到端、desktop-path-test.js 路径穿越单测）
├─ dist/                  桌面版构建产物（exe + SHA256SUMS.txt，已 gitignore；0.0.7 本地构建交付，0.0.5 为最近 GitHub Release）
├─ data/                  运行时数据（包存储/日志/配置/离线包，已 gitignore）
├─ 启动桌面版.cmd         桌面版入口（自动检查低完整性标签并在需要时请求 UAC 修复，启动 dist 里最新的桌面版 exe）
├─ 修复-桌面版启动限制.cmd 完整性标签检查/修复（check=只检查 / repair=内部提权后修复；v0.0.5 新增）
├─ 诊断-桌面环境.cmd      桌面启动环境诊断（只读，输出 tmp\desktop-diagnose.txt）
├─ 使用说明.md            详细操作手册（第十三章为桌面版）
├─ 报告.md                开发过程与验收记录
├─ 启动镜像源.cmd 等       Windows 一键脚本（网页版 / 命令行版）
└─ 截图/                  界面截图
```

## 测试与验收

先启动服务，然后：

```bash
node test/run-all.js                 # 一键自检（约 40~60 秒；不含会大量导包的耗时用例）
node test/api-test.js                # 只跑接口自检（--destructive 另含重启/清日志）
node test/ui-check.js                # 前端静态契约检查
node test/tray-check.js              # 只跑托盘/图标/启动脚本自检（Windows）
powershell -NoProfile -ExecutionPolicy Bypass -File test/tray-e2e.ps1   # 托盘端到端（手工，需真实桌面）
pwsh -File test/acceptance-npm.ps1   # 真实 npm 客户端验收（Windows / PowerShell 7）
node test/desktop-path-test.js       # 桌面版数据根 / 路径穿越单测（纯 node，无需服务）
node test/desktop-bridge-test.js     # 桌面版 stdio 桥协议单测（纯 node，无需服务）
node test/desktop-cancel-test.js     # 桌面版导入取消收敛单测（纯 node，无需服务）
powershell -NoProfile -ExecutionPolicy Bypass -File test/desktop-e2e.ps1  # 桌面版端到端（需先构建 dist exe）
```

| 脚本 | 内容 | 最近结果（2026-10-19，本机） |
| --- | --- | --- |
| `test/api-test.js` | **276 项**（本机实测 269 通过 + 7 跳过、0 失败，约 26 秒）：npm 协议、管理接口、发布/删除、离线导入导出、进度任务（含逐版本 `downloads[]` 实时进度）、并行导出导入与根目录/版本写法兼容、导出时自动补齐缺失依赖、安全回归、包管理页「缺 tarball / 不缺 tarball」快捷筛选、**本地扫描 / 统计全并发（`storage.localScanConcurrency`：补包规划、导出统计、依赖闭包、缓存扫描导入）、`cli.js prestart` 同端口不重复启动（退出码 10/11）、回环免鉴权覆盖 127.0.0.0/8（`util.isLoopback` 与 Host: 127.0.0.5）、**统计阶段进度展示（补 tarball 规划 `phase:'plan'` 快照带「已统计 N / M 个包」、导入解包后的扫描 `phase:'scan'`）**、**加速镜像源（`upstream.accelerators` 多源配置、`buildMirrorCandidates` 地址推导、`probeTarball` HEAD/Range 并发探测按延迟排序、`downloadTarballPreferred` 失败换源、全部失败回退上游、私有网段加速源放行与重定向限制）12 项**、**加速镜像源连通性测试 7 项（`POST /upstream/accelerators/test` 只读探测元数据与测试包 tarball、HEAD 被拒时 Range 兜底、逐源可用/不可用 + 中文原因、地址去重与校验）**等 **只导出指定版本 12 项（`versions` 白名单三种写法与非法形状 `EBADVERSION`、依赖按所选版本 `dependencies` 解析出精确版本、bundle 内 packument/meta 裁剪与 dist-tags 收敛、裁剪包可正常导入且 tarball 齐全、点名不存在版本 `EVERSIONMISSING`、非选中范围 `EBADSCOPE`、接口层 400 校验）**等**（本次双监听改造新增：管理界面独立监听与 `admin.ip/admin.port` 校验、管理 API/页面只挂在管理界面监听、镜像源监听不提供管理 API（403 `EADMINONLY`）、本机访问镜像源首页 302 跳转管理界面、`/service/restart` 只重启镜像源监听、`/service/restart-admin` 只重启管理界面且两者实例标记各自变化；上一轮起：npm 缓存导入保留仅元数据版本 + 依赖解析强制回源补全 5 项、加速镜像源 12 项、连通性测试 7 项、只导出指定版本 12 项、接口层 versions 预规范化幂等回归 2 项、指定版本导出的依赖版本 tarball 校验回归 2 项、按添加时间「版本口径」导出 4 项（`addedBy` 只认 package/version 且非法 400 `EBADMODE`、按 tarball mtime 选区间内新增版本并裁剪 packument/meta、包口径同区间仍整包、接口层真实数据版本口径只带新增版本）） | **269 通过 + 7 跳过，0 失败**（共 276 项、约 26 秒；跳过数随上游可达性/镜像数据状态小幅浮动；另含「最新日志行时间戳为本机时区（带偏移）」断言） |
| `test/ui-check.js` | 前端与后端接口/页面元素契约（含导入结果的失败/跳过详情面板、导出自动补依赖勾选项、全部包补全部版本入口、补 tarball 弹窗「版本进度」栏、「缺 tarball / 不缺 tarball」快捷筛选、悬停提示自绘浮层（首页无原生 title、el() 把 title 映射成 data-tip、uiTip 控制器、`.ui-tip` 样式与项目配色变量）、补 tarball 左栏行数上限回收（`reclaimRow` 只收已完成行、失败行保留、提示条）、导出/导入进度弹窗右栏多行进度（`inFlight`：导出按「并行文件」一行一个正在压缩的条目、导入一个包一行）、导出收尾写盘阶段（`concat` 字节进度 → 任务快照 `concatDone/concatTotal` → 右栏「正在写入 · 拼接分片」，压缩阶段最多 95%）、**弹窗/抽屉/面板/统计卡内部背景复用整页动态背景（`.fx-box` 动效层 + `isolation:isolate`，与整页 32px 网格/扫过亮带一致、不挡点击）**、**导出「按添加时间」范围（segbar 与自绘日期时间选择器 `#exp-added-row`、payload `addedFrom/addedTo`、后端 `addedTimeRange` 清单、非法/空范围 400 与提示）与进度弹窗「取消」等待期禁用（`requestTaskCancel` 置灰/「正在取消…」、成功保持禁用、失败恢复可点）**、**原生下拉改项目风格自绘下拉（`csel*` 实现：7 个静态 `<select>` + 动态创建/重建选项的接管、`.csel-btn/.csel-menu` 样式、键盘与点外关闭、保留原生 `change` 语义）**、**搜索框清除叉 / 数字框上下箭头收掉、`:focus-visible` 统一青色描边、原生 `window.confirm` 换 `confirmBox`**、**下拉按钮箭头三态（悬停/键盘聚焦/展开）变青、复选框对勾加粗与全选「半选」横杠、勾选单行时表头全选框同步半选**、**概览页「上游与来源分布」条形图能真正渲染彩色填充（`fill` 用 `display:block`、非零来源最小 2% 宽）**、favicon 声明、**导入备份分片并发上传（`uploadBundleChunked` 与 `/bundles/upload/init|chunk|complete|abort` 四接口）**、**多并发解包（`extractTarGz` 并发写盘）**、**版本级并行调度器（`laneCount/stealTask/runVersionTask/laneLoop`）与右栏「· N 路」显示**、**本地扫描 / 统计全并发（九之四 8 项：`storage.localScanConcurrency` 配置页字段、规划 `mapLimit`、导出统计并发、解包后扫描并发、缓存扫描 / 导入并发、`initAsync` 启动索引并发、详情 cached 用内存索引、CLI 传并发参数）**、**并发异常点审计修复（九之五 7 项：`mapLimit` NaN 兜底与字节预算队列、`__error` 行防护、`verifyFileIntegrity` 流式校验、`putTarballFromFileAsync` 边写边算哈希、altName 拒绝 `.` / `..`、同一分片并发写保护、合并期间 abort 保护）**、**统计阶段进度展示（九之六 6 项：补包规划 `phase:'plan'` 与「已统计 N / M 个包」文案、导入扫描 `phase:scan`/`scan-done`、缓存扫描长任务、`runFill`/`runScan`/导出导入弹窗的进度分支）**、**包详情抽屉版本表表头全选/半选复选框与快捷排序（九之七 6 项：表头三态同步、本页全选/取消、排序下拉 6 种方式、切排序回第 1 页、semver 比较）**、**残缺元数据自愈（九之八 4 项：npm 缓存导入保留仅有元数据的版本号、`meta.metadataComplete` 标记、依赖解析强制回源补全一次、进度明细「N 个仅补元数据」）**、**加速镜像源（九之九 6 项：多源地址推导、HEAD/Range 探测按延迟排序、校验失败自动换源、全部失败回退上游、配置校验与热生效、托盘右键「重启镜像源」与左键打开管理界面）**、**加速镜像源输入框自绘角标与连通性测试（九之十 5 项：隐藏浏览器原生 resize 把手换成项目风格自绘斜纹角标并可指针拖动调整高度、自动清理空行与首尾空白、`POST /upstream/accelerators/test` 只读探测元数据与测试包 tarball、逐源展示可用/不可用 + 耗时 + 中文原因）**、**导出指定版本与依赖按版本解析（九之十一 5 项：迁移页「指定版本」多行框与「生成模板」、`versions` 解析进 payload、bundle 裁剪 packument/meta、接口层 `EBADVERSION/EBADSCOPE`、CLI `--versions` 与位置参数 `包名@版本`）**、**顶栏「管理界面 / 镜像源服务」双连接状态与分项重启（九之十二 11 项：`#chip-conn` 与 `#chip-svc` 两个 chip 的文案与 `.chip-conn.is-red/.is-idle` 样式区分、同一次同源 `/__admin/api/session` 心跳同时得出「管理界面请求成败」与「镜像源 `registry.reachable`」两种探测、只有管理界面断连恢复或管理界面实例标记（`pid` + `admin.startedAt`）变化才 `location.reload()`、镜像源服务状态变化只更新 chip 与 toast、快探测 `CONN_FAST_MS`=250、重启收尾与断线重试文案；另含 4 条真接口断言：管理界面 `/session` 返回 `admin`/`registry` 探测字段、镜像源监听 `/__admin/api/session` 403、镜像源 `/-/ping` 200、本机访问镜像源首页 302）、**运行时长实时刷新与零依赖导出提示（九之十三 4 项：顶栏「运行 xx」以概览快照为基准由本地时钟每秒累加、概览/服务页卡片同步刷新、概览/服务快照重置基准、带依赖导出但所选版本无运行时依赖时成功文案明确提示「只打包了选中的包」）**、**按添加时间导出可选「包 / 版本」口径（九之十四 4 项：迁移页 `#exp-added-by` 下拉、payload `addedBy`、后端 `normalizeAddedBy` 只认 package/version 非法 400 `EBADMODE`、版本口径按 tarball mtime 选版本并复用版本白名单裁剪、CLI `--added-by`）**、**导出面板表单布局与自绘角标（九之十五 3 项：指定版本多行框复用项目风格自绘拖拽角标、表单标签列统一分栏使右列输入框铺满加宽、按添加时间行与上方口径下拉右边缘对齐且两个时间框等宽）**） | **231/231 通过** |
| `test/tray-check.js` | 托盘脚本/项目图标/启动脚本/favicon 路由契约（含右键菜单 5 项「打开/隐藏控制台」「打开管理界面」「重启管理界面」「重启镜像源服务」「退出镜像源」、左键单击打开管理界面、`Restart-AdminUi` / `Restart-MirrorService` 分项重启、重启期间健康检查暂停、自检输出 `adminPort`/`registryPort`/`managementUrl` 且管理地址与镜像源地址分离）、**开机自启（`.vbs` 隐藏启动项 / UTF-16LE BOM / 旧 `.cmd` 清理 / `off` 幂等，临时目录真跑）**，并真跑一次托盘自检（Windows）、**托盘健康检查的进程存活保护（服务忙但进程还活着只提示「忙碌」、不关窗口）、启动脚本 prestart 同端口不重复启动（退出码 10/11）**、**服务已在运行时补注册托盘（退出码 10 分支前台拉起 `tools\tray.ps1` 并置 `MIRROR_TRAY_RESTORE`、单实例互斥体、按标题接管被隐藏的原命令行窗口、`data\logs\tray.pid`、托盘图标注册日志）、退出镜像源按 `mirror.pid` 进程是否真的退出做 `Stop-Process -Force` 兜底、健康检查连续失败先重读配置** | **66/66 通过** |
| `test/tray-e2e.ps1` | 托盘端到端：隔离副本启动 → 窗口隐藏 → 可重新显示 → **强杀托盘进程模拟图标没了 → 再跑一次启动脚本 → 断言托盘补注册成功、接管原来被隐藏的控制台、服务不受影响（场景 A）** → 停服务后托盘退出并关窗 | **12/12 通过（手工）** |
| `test/desktop-path-test.js` | 桌面版数据根与路径穿越防护单测：普通相对路径、旧 `data/` 前缀、`../` / `..\` / `a/../../x`、绝对路径、NUL、磁盘根、空串、`C:foo` 等 | **24/24 通过（exit 0）** |
| `test/desktop-bridge-test.js` | 桌面版 stdio 桥协议单测：`ready` / `req` / `res` / `event` / `bye` 消息、请求 id 与并发、错误包装、超时与非法消息处理等 | **11/11 通过（exit 0）** |
| `test/desktop-cancel-test.js` | 桌面版导入取消收敛单测：解包/扫描/写存储阶段取消 ≤2s 收敛（实测 122ms）、临时目录清理、已导入数据不被破坏、取消后可重新导入 | **13/13 通过（exit 0）** |
| `test/desktop-e2e.ps1` | 桌面版端到端验收（Windows / PowerShell 7）：`dist` exe 存在与版本信息 → 启动进程/窗口（窗口标题、URL=内部回环管理端口、加载现有管理界面；v0.0.3 起同时断言窗口失败原因字段 `window.failureReason`）→ 内部管理 API → 控制台 API 与增量 `after` → 一键脚本 `doctor`/`status` → `admin.enabled` 端口监听开关与即时生效 → 默认数据目录 `<exe目录>\data` → **v0.0.3 数据目录自动发现（`parent-project`：exe 在 `dist\`、上级 `data\config.json` 存在时自动使用上级 `data\`）** → `/desktop/files` 白名单与穿越参数 → `PUT /config` 路径穿越 400 → 单实例（**v0.0.7**：第二实例最多等待约 15 秒，报告 `alreadyRunning` / `waitedMs`，确认已有实例健康时激活其窗口并退出、旧实例恰好退出则接管）→ **v0.0.7 内部管理端口令牌门禁**（报告 `internalAdminUrl` 形如 `http://127.0.0.1:<port>/?__mirror_token=<token>`；无令牌 / 错误令牌访问 `/`、`/app.js`、`/__admin/api/session` → 403 中文提示；正确令牌 → 302 + `Set-Cookie`（`HttpOnly; SameSite=Strict`）→ 带 cookie 200 + HTML；`/desktop/info` 不含令牌；网页版管理端口不受门禁影响）→ **v0.0.4 托盘可用性（`tray.available`）：可用时关闭窗口=隐藏且服务在线；不可用时关闭窗口=退出程序、退出码 0、无 Node 残留；`/desktop/info.tray.available` 与报告一致；受限环境 `restricted=true`（`home_fallback || !tray_available`）与 `tray.error` 含拒绝原因** → **v0.0.5 完整性标签：exe `--help` 退出码 0 且输出含 `--repair-integrity` / `--skip-integrity-prompt` / `--data-dir`；把 exe 复制到临时目录后以 smoke 模式执行 `--repair-integrity` 做只读验证（未提权→退出码 3 + 「管理员权限」原因、不改副本；已提权→退出码 0 + repairResult），绝不请求真实 UAC、不改 dist 产物；测试报告含 `integrity` 对象且字段齐全（token/tokenRid/tokenSid/file/lowDetected/elevated/repairPrompted/repairLaunched/promptSuppressed/repairResult/repairError/error/exePath）、`integrity.file` 与 `icacls` 读到的 dist exe 标签一致、smoke 模式不弹框（`repairPrompted`/`repairLaunched=false`，Low 时 `promptSuppressed=true`）、exe 为 Low 时进程令牌完整性也为 Low；**v0.0.6 修正修复算法后断言不变（提权后改 exe 文件标签、复查 Medium、普通权限重启，失败时给出复制到其它文件夹 / 管理员 cmd `icacls` 两条退路，e2e 只做只读验证、不弹 UAC）**；**v0.0.6 起版本信息断言：`CompanyName=suliyue`、`FileVersion`/`ProductVersion`=被测版本、`ProductName`/`FileDescription=离月私人 npm 镜像源`**；**v0.0.6 新增「普通目录副本」阶段：把 exe 复制到 `tmp\e2e-copy` 后用 smoke 启动，断言 `integrity` 字段完整（验证复制到普通目录后不受 Low 标签影响）**；**v0.0.7 起 `integrity` 断言新增 `relaunchMethod` / `relaunchScheduled` 字段** → **v0.0.7 托盘菜单（关闭网页版管理时 5 项：打开窗口 / 关闭窗口 / 重启窗口的管理界面 / 重启镜像源服务 / 退出程序；开启时 7 项，另含「打开管理界面」「重启管理界面」；开关后 ≤2 秒实时切换、关闭后 ≤1 秒缩回；「重启窗口的管理界面」用 smoke 命令 `menu:tray-restart-window-admin` 驱动，断言内部管理端口与令牌已更换、旧端口停止监听、新地址可正常访问）**→ 程序配置目录回退（五级探测，`%LOCALAPPDATA%` 不可写时回退 `<exe目录>\LiYueNpmMirror`，只写日志不弹框）→ 图标一致性（`src-tauri\icons\icon.ico` 与 `public\favicon.ico` SHA256 相同、RGBA 素材尺寸正确）→ 开机自启注册表往返（已开启时只读跳过）→ 退出后无残留进程与监听。临时数据目录 `tmp/e2e-data`、桌面 home `tmp/e2e-home`、测试端口 14873/14874；退出码 `0`=通过、`1`=失败、`3`=仅因当前会话无法创建/显示 WebView2 窗口的环境限制 | **v0.0.7 实测（2026-10-19 20:53:28，`dist\npm-mirror-desktop-0.0.7.exe`，96,853,504 B，SHA256 `683319fa…cdb643`）：297 项 = 285 通过 / 6 失败（全部窗口类环境限制）/ 6 跳过，退出码 3（环境限制），非窗口类失败 0**；v0.0.7 新增断言全部通过（内部管理端口令牌门禁：无/错令牌 403、正确令牌 302 + `Set-Cookie`（HttpOnly/SameSite=Strict）→ 带 Cookie 200 + HTML、令牌不进 `desktop.log` 与 `/desktop/info`；托盘 5/7 项与 `menu:tray-restart-window-admin` 换端口/令牌、旧端口停止；单实例 `alreadyRunning`/`waitedMs`/退出码 0；`relaunchMethod`/`relaunchScheduled`；`%TEMP%` 无提权助手残留）。历史 **v0.0.6 实测（2026-10-19 19:09:50，`dist\npm-mirror-desktop-0.0.6.exe`，96,832,000 B，SHA256 `5125d853…765526`）：207 项 = 196 通过 / 5 失败（全窗口类环境限制）/ 6 跳过，exit 3（环境限制），非窗口类失败 0**；v0.0.6 新增断言全部通过（阶段 0 版本信息 5 项：`CompanyName=suliyue` 等；阶段 0e 普通目录副本 8/8）。历史 **v0.0.5 实测（2026-10-19 18:07:49，`dist\npm-mirror-desktop-0.0.5.exe`，96,829,440 B，SHA256 `727b994a…ff644d`）：194 项 = 183 通过 / 5 失败（全窗口类环境限制）/ 6 跳过，exit 3（环境限制），非窗口类失败 0**；v0.0.5 新增断言全部通过（阶段 0b `--help`、阶段 0c 只读 `--repair-integrity`、阶段 0d 非 smoke 跳过询问框、阶段 1 `integrity` 对象与 `icacls` 交叉一致=Low）。历史：0.0.4：166 项 = 155/5/6，exit 3；0.0.3：153/143/5/5；0.0.2：143/133/5/5；0.0.1：119/5/4 |
| `test/acceptance-npm.ps1` | 真实 `npm install / publish / dist-tag / deprecate / unpublish` | **16/16 通过** |
| `test/ui-e2e-*.js` | 浏览器端端到端（需要 Chrome 调试端口，可选） | 需本机 Chrome CDP 环境 |

> 一键自检约 40~60 秒：已不包含「递归添加依赖 / 全部包补 tarball / 本机 npm 缓存导入真实扫描 / 大名单规划」这些耗时导包用例（原 `--full` 模式已移除）。破坏性用例（重启服务、清空日志）默认也跳过，`node test/api-test.js --destructive` 才会执行；依赖上游的 3 项自动补依赖用例在上游不可达时显式跳过（总数会随上游可达性 / 本机镜像数据状态小幅浮动，本机最近一次为 276 项（269 通过 + 7 跳过）、0 失败）。

## 安全说明

- 默认只监听 `127.0.0.1`，仅本机可访问；**管理界面与镜像源（npm registry）是两个独立监听**：管理界面只监听 `admin.ip`（只能是 `127.0.0.0/8` 本地回环地址，默认 `127.0.0.1:4874`），管理页面与管理 API 只在管理界面监听提供——镜像源监听上 `/__admin/api/*` 一律 403，本机访问镜像源首页 302 跳管理界面、非本机 403 提示；`admin.port` 不能与 `server.port` 相同（保存配置时强校验）。映射到局域网/公网前请先阅读 **[使用说明.md](使用说明.md) 的「安全提示」**。
- 访问令牌保存在 `data/config.json`，`data/` 已列入 `.gitignore`；**提交代码前确认没有把 `data/` 或令牌带进仓库**。
- 已实现的防护：包名/版本与路径穿越校验、tarball 路由防任意文件读取、管理接口 Host/Origin 校验与令牌鉴权、常量时间令牌比较、上游重定向逐跳校验与 SSRF 防护、下载完整性校验、tar 解压上限与符号链接拦截、上传大小/格式校验、私有包不回源合并（防依赖混淆）、管理界面独立回环监听（`admin.ip` 强校验 127/8、`admin.port` 不得等于 `server.port`、管理 API/页面不挂在镜像源监听上，满足「只有本机访问管理监听地址才能打开管理界面」）。
- 桌面版：内部管理接口只监听 `127.0.0.1` 的随机端口（仅窗口内加载页面使用），默认不监听固定 admin 端口（`admin.enabled=false`）；**v0.0.7 起该内部端口每次启动生成随机访问令牌**：窗口用 `http://127.0.0.1:<port>/?__mirror_token=<token>` 打开，无令牌 / 错误令牌直接访问（`/`、`/app.js`、`/__admin/api/session`）一律返回 403；正确令牌会先 302 并在响应里 `Set-Cookie`（`HttpOnly; SameSite=Strict`），之后凭 cookie 访问；令牌不写日志、不在 `/desktop/info` 暴露，防止本机其它程序直接读取内部管理页面。打开网页版管理后才按 `admin.ip/admin.port` 监听（仍受 `127/8` 校验与令牌鉴权），网页版端口不受内部令牌门禁影响。主数据目录与 `storage.dir` 统一经 `resolveWithinDataRoot()` 校验（`..` 穿越、绝对路径、NUL、磁盘根等拒绝，单测 `test/desktop-path-test.js` 覆盖）；单实例互斥体避免多开抢端口、重复写数据（v0.0.7 起第二实例最多等待约 15 秒，确认已有实例健康后把其窗口激活并退出，旧实例若恰好退出则接管）。
- 发现安全问题请按 **[SECURITY.md](SECURITY.md)** 私下上报，不要直接开公开 issue。

## 文档

- **[使用说明.md](使用说明.md)**：安装、界面、命令行、离线迁移、局域网共享、常见问题
- **[报告.md](报告.md)**：开发过程、问题修复与验收记录
- **[CHANGELOG.md](CHANGELOG.md)**：版本变更
- **[CONTRIBUTING.md](CONTRIBUTING.md)**：参与开发与提交规范
- **[SECURITY.md](SECURITY.md)**：安全策略与漏洞上报

## 许可证

[MIT](LICENSE)，可自由使用、修改与分发。

