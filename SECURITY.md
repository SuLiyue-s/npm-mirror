# 安全策略

本项目的定位是**私人 npm 镜像源**：默认只监听 `127.0.0.1`，供本机开发使用。把管理界面或 registry 端点暴露到局域网/公网属于「自行加固」场景，请先阅读第 3 节。

## 1. 支持范围

- 当前维护版本：`1.x`（`master` 分支）
- 仅对最新提交接受安全修复；历史版本不单独发补丁
- 依赖：本项目无第三方依赖，依赖链带来的风险为 0

## 2. 上报漏洞

**请不要在公开 issue、Pull Request 或讨论区披露未修复的安全问题**，以免被利用。

推荐方式：

1. 打开仓库 **Security** 页 → **Report a vulnerability**（GitHub Security Advisories，仅维护者可见）
2. 如果该功能不可用，可在 issue 中只写「安全问题，请提供私下联系方式」，**不要附带细节**

报告时请尽量提供：

- 受影响的版本 / 提交（`git log -1 --oneline`）
- 复现步骤或最小 PoC（curl 命令、脚本）
- 影响面（令牌泄露、任意文件读写、远程代码执行、拒绝服务……）
- 你的部署方式（是否改过 `server.ip`、`requireRead`、`requirePublish` 等）

维护者会尽快确认并给出处理计划；修复发布后会在 [CHANGELOG.md](CHANGELOG.md) 中致谢（如果愿意署名）。

## 3. 部署安全建议

默认配置已经做了较严格的限制，但请按实际环境加固：

| 场景 | 建议 |
| --- | --- |
| 仅本机自用（默认） | 保持 `server.ip = 127.0.0.1`，不要改 `trustLocalhost` |
| 局域网共享 | 设 `server.ip = 0.0.0.0`，开启 `security.requireRead = true`、`security.requirePublish = true`，通过安全渠道分发令牌；建议用防火墙只放行可信网段 |
| 公网/跨机房 | 必须放在 HTTPS 反向代理之后（Nginx/Caddy），并由代理做认证与访问控制；不要直接暴露 `node cli.js start` 的端口 |
| 多用户 | 本项目只有「一个管理令牌」的单用户模型，没有账号/权限体系；多人场景请每个团队独立部署实例 |

其它要点：

- `data/config.json` 含明文令牌，`data/` 已在 `.gitignore` 中；**永远不要提交或打包分享 `data/`**
- 令牌通过管理界面「重置令牌」轮换；轮换后旧令牌立即失效
- 离线 bundle（`.tgz`）可能包含私有包源码，按敏感文件保管
- 日志会记录请求路径与状态码，不含令牌明文，但分享日志前建议自查

## 4. 已实现的防护

- **鉴权**：Bearer / `X-Mirror-Token` / npm 兼容的 `_authToken` / Basic 密码；常量时间比较；`?token=` 仅限本机回环；管理 API 的 `Origin: null` 与跨站来源一律拒绝
- **路径安全**：包名、版本、tarball 文件名严格校验（拒绝 `..`、分隔符、Windows 保留名）；存储路径 `path.relative` 包含校验；tar 解包拒绝 `..`、符号链接、设备文件
- **防任意文件读取**：registry tarball 路由只允许「真实存在的包 + 纯文件名」，不再拼接任意路径
- **CSRF / DNS 重绑定**：管理接口校验 `Host` 与 `Origin`；写请求额外校验来源
- **上游安全**：tarball 必须与配置的上游同注册域（或 CDN），重定向逐跳校验，拒绝内网/回环目标（SSRF）；下载超时覆盖响应体；完整性（`integrity` / `shasum`）校验
- **资源限制**：上传大小、tarball 大小、tar 解压总字节/条目数/单条目大小、body 读取空闲与总时长上限；tar 全零块计入总量
- **防依赖混淆**：同名私有包永远不会被上游元数据合并覆盖，私有包的 `tarball`/`integrity` 保持本地值
- **响应头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`，管理页面带 CSP

## 5. 已知边界（非漏洞）

- 令牌即管理员：拿到令牌即可发布/删除/改配置/停服，这是单用户模型的预期行为
- `security.trustLocalhost = true` 时，本机进程访问管理接口无需令牌；能访问本机回环的恶意程序已具备同等权限，不属于本项目的防护边界
- 没有内置限流/防爆破；公网部署请在反向代理层做
- 未实现多副本/集群一致性，文件存储依赖单机磁盘

## 6. 处理流程

1. 确认问题与影响面，必要时先做最小化缓解（关闭相关端点、建议轮换令牌）
2. 在私有分支修复并补充回归测试（参考 `test/api-test.js` 第十节「安全回归」的写法）
3. 发布版本，更新 [CHANGELOG.md](CHANGELOG.md)；严重问题会同时发布公告
