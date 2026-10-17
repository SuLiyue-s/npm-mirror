#!/usr/bin/env node
'use strict';
/*
 * 可视化管理界面冒烟自检（不需要浏览器）：
 *   1. 静态资源是否都能取到（/、/app.js、/style.css，MIME 是否正确）
 *   2. 页面里是否引用了外网资源（离线环境必须为 0）
 *   3. 前端代码里调用的每个 /__admin/api 接口，后端是否都有实现
 *   4. 界面依赖的只读接口是否都能返回 { ok: true }
 * 用法：node test/ui-check.js [--base http://127.0.0.1:4873]
 * 说明：本脚本只能证明“接口通、资源在、无外链”；界面渲染请在浏览器中打开确认。
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');

config.load();
const cfg = config.get();
const BASE = (() => {
  const i = process.argv.indexOf('--base');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1].replace(/\/+$/, '');
  return `http://127.0.0.1:${cfg.server.port}`;
})();

const PUB = path.join(__dirname, '..', 'public');
let pass = 0; let fail = 0;
function check(title, ok, detail) {
  if (ok) { console.log(`  \x1b[32m✓\x1b[0m ${title}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${title}  ${detail || ''}`); fail++; }
}
async function get(p, { json = false } = {}) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type') || '', text, json: json ? JSON.parse(text) : null };
}

(async () => {
  console.log(`\n\x1b[1m可视化管理界面冒烟自检\x1b[0m  目标：${BASE}\n`);

  console.log('\x1b[1m一、静态资源\x1b[0m');
  const home = await get('/');
  check('GET / 返回 200', home.status === 200, `status=${home.status}`);
  check('首页是 HTML', /text\/html/.test(home.type), home.type);
  check('首页包含六个功能页签', ['概览', '包管理', '迁移备份', '配置', '日志', '服务'].every((t) => home.text.includes(t)));
  check('首页引用了 app.js 与 style.css', home.text.includes('app.js') && home.text.includes('style.css'));
  check('首页无 BOM/乱码（中文可读）', home.text.includes('私人 npm 镜像源') || home.text.includes('npm'));

  const js = await get('/app.js');
  check('GET /app.js 返回 200 且为 JavaScript', js.status === 200 && /javascript/.test(js.type), `${js.status} ${js.type}`);
  const css = await get('/style.css');
  check('GET /style.css 返回 200 且为 CSS', css.status === 200 && /css/.test(css.type), `${css.status} ${css.type}`);
  const icon = await fetch(BASE + '/favicon.ico', { signal: AbortSignal.timeout(10000) });
  check('GET /favicon.ico 不报错（204/200）', icon.status === 200 || icon.status === 204, `status=${icon.status}`);

  console.log('\x1b[1m二、离线性：前端不得引用外网资源\x1b[0m');
  const externals = (home.text + js.text + css.text).match(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/gi) || [];
  // 排除 XML/SVG 命名空间（不会发起网络请求）
  const uniq = Array.from(new Set(externals.filter((u) => !/^https?:\/\/www\.w3\.org$/i.test(u))));
  check('页面/脚本/样式里没有外网地址', uniq.length === 0, uniq.join(', '));
  check('没有使用 CDN / 框架（无 <script src="http）', !/<script[^>]+src=["']https?:/i.test(home.text));

  // 回归检查：作者样式里的 display:flex 会盖掉浏览器默认的 [hidden]{display:none}，
  // 曾导致 #cfg-restart（配置页重启横幅）与 #pkg-selbar（包管理已选栏）永远可见。
  const hiddenEls = Array.from((home.text.match(/<[^>]+\shidden[\s>/]/gi) || []));
  const hasHiddenRule = /\[hidden\][^{]*\{[^}]*display\s*:\s*none/i.test(css.text);
  check(`样式表有 [hidden] 兜底规则（页面有 ${hiddenEls.length} 处用 hidden 控制的元素）`, hasHiddenRule,
    '缺少 [hidden]{display:none!important}，用 hidden 属性隐藏的元素会被 display:flex 覆盖而一直显示');

  const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.js'), 'utf8');

  console.log('\x1b[1m三、前端调用的管理接口后端都有实现\x1b[0m');
  {
    const ADMIN_API = (apiSrc.match(/const API\s*=\s*'([^']+)'/) || [])[1] || '/__admin/api';

    // ① 收集前端真正会请求的相对路径：api('...')、api(`...`)、API + '...'（upload 等 fetch 直接把
    //    URL 存进变量再 fetch(url)，只扫 fetch(API + ...) 会漏），模板变量统一记成 :x。
    const used = new Set();
    const dynPrefixes = new Set();   // 形如 api('/service/' + action) 的拼接前缀：静态无法得知完整路径
    const addPath = (raw) => {
      let v = String(raw).replace(/\$\{[^}]*\}/g, ':x').split('?')[0].split('#')[0];
      if (!v.startsWith('/')) return;
      if (v !== '/' && v.endsWith('/')) { dynPrefixes.add(v.replace(/\/+$/, '')); return; }
      used.add(v.replace(/\/+$/, '') || '/');
    };
    for (const re of [/\bapi\(\s*'([^']+)'/g, /\bapi\(\s*"([^"]+)"/g, /\bapi\(\s*`([^`]+)`/g,
      /\bAPI\s*\+\s*'([^']+)'/g, /\bAPI\s*\+\s*`([^`]+)`/g]) {
      let m;
      while ((m = re.exec(js.text))) addPath(m[1]);
    }

    // ② 解析后端路由：handleAdmin 里 `rel === '/x'` 精确匹配 + `rel.startsWith('/tasks/')` 前缀匹配；
    //    /packages/... 由 parsePackageRoute 动态解析，故补一条通配路由。
    const routes = new Set();
    for (const m of apiSrc.matchAll(/\brel\s*===\s*['"]([^'"]+)['"]/g)) routes.add(m[1]);
    for (const m of apiSrc.matchAll(/\brel\.startsWith\(\s*['"]([^'"]+)['"]\s*\)/g)) routes.add(m[1].replace(/\/+$/, '') + '/*');
    if (/function parsePackageRoute\s*\(/.test(apiSrc)) routes.add('/packages/*');
    const routeList = Array.from(routes);

    // ③ 按段比较：段数必须相等；:param / <param> / * 视为通配（不再用「前缀互相 startsWith」兜底，
    //    那会让 /logs 掩盖 /logs/xxx 之类的缺失）。
    const segs = (p) => p.split('/').filter(Boolean);
    const segEq = (r, u) => r === '*' || r === ':x' || /^:/.test(r) || /^<.*>$/.test(r) || r === u;
    const matchRoute = (route, usedPath) => {
      const r = segs(route); const u = segs(usedPath);
      for (let i = 0; i < r.length; i++) {
        if (r[i] === '*') return u.length > i;          // 前缀通配：后面至少还有一段
        if (i >= u.length || !segEq(r[i], u[i])) return false;
      }
      return u.length === r.length;
    };

    // ④ 拼接前缀（/service/、/tasks/、/packages/）只要求后端存在同前缀的路由，不猜具体动作名
    const dynMissing = Array.from(dynPrefixes).filter((p) => !routeList.some((r) => r.startsWith(p + '/')));
    const usedList = Array.from(used).sort();
    let missing = usedList.filter((u) => !routeList.some((r) => matchRoute(r, u)));

    // ⑤ 静态比对不了的（无模板变量的真实路径）用 GET 探测兜底：404=后端缺失，其它状态（含 401/403/405/400）
    //    说明路径存在。只读 GET，不写数据；带 :x 的模板路径无法探测，交由静态比对。
    const probed = [];
    if (missing.length) {
      const still = [];
      for (const u of missing) {
        if (u.includes(':x')) { still.push(u); continue; }
        try {
          const r = await fetch(BASE + ADMIN_API + u, { signal: AbortSignal.timeout(10000) });
          probed.push(`${u}→${r.status}`);
          if (r.status === 404) still.push(u);
        } catch { still.push(u); }
      }
      missing = still;
    }

    check(`前端用到 ${usedList.length} 个管理接口（${usedList.join(' ')}${dynPrefixes.size ? '；拼接前缀 ' + Array.from(dynPrefixes).join(' ') : ''}），均有后端实现`,
      missing.length === 0 && dynMissing.length === 0,
      `缺失=${missing.concat(dynMissing).join(', ') || '无'}${probed.length ? ' 探测=' + probed.join(' ') : ''}`);
  }

  console.log('\x1b[1m四、界面首屏依赖的接口\x1b[0m');
  const probes = [
    ['/__admin/api/session', '会话信息'],
    ['/__admin/api/overview', '概览统计'],
    ['/__admin/api/packages?size=5', '包列表'],
    ['/__admin/api/config', '配置（令牌打码）'],
    ['/__admin/api/logs?lines=5', '日志'],
    ['/__admin/api/search?text=ms&size=5', '搜索'],
    ['/__admin/api/bundles', '离线包列表'],
  ];
  for (const [p, title] of probes) {
    try {
      const r = await get(p, { json: true });
      check(`GET ${p} → ok:true（${title}）`, r.status === 200 && r.json && r.json.ok === true, `status=${r.status} body=${r.text.slice(0, 120)}`);
    } catch (e) {
      check(`GET ${p} → ok:true（${title}）`, false, e.message);
    }
  }

  console.log('\x1b[1m五、批量入口：「全部包补 dist-tag 版本 / 全部包补最新版本」\x1b[0m');
  {
    const bothBtns = ['pkg-fill-tags-all', 'pkg-fill-latest-all'].every((id) => new RegExp(`id="${id}"`).test(home.text));
    check('包管理工具栏有「全部包补 dist-tag 版本」「全部包补最新版本」两个按钮', bothBtns,
      bothBtns ? '' : 'index.html 里缺少 #pkg-fill-tags-all / #pkg-fill-latest-all 之一');
    const labels = /全部包补 dist-tag 版本/.test(home.text) && /全部包补最新版本/.test(home.text);
    check('两个按钮文案齐全（不用勾选任何包就能跑）', labels);

    const handlers = ['pkg-fill-tags-all', 'pkg-fill-latest-all'].every((id) => js.text.includes(`'${id}'`));
    const helper = /function fillAllTarballs\s*\(/.test(js.text);
    check('app.js 绑定了这两个按钮并复用 runFill 的「全部包」模式（fillAllTarballs）', handlers && helper,
      `handlers=${handlers} fillAllTarballs=${helper}`);

    const sendsAll = /\{\s*mode:\s*mode,\s*all:\s*true/.test(js.text) || /all:\s*true,\s*concurrency/.test(js.text);
    const backAll = /body\.all === true \|\| body\.scope === 'all'/.test(apiSrc);
    check('前端确实发 all:true、后端 /packages/pull 与 /packages/prefetch 都认这个作用域', sendsAll && backAll,
      `前端=${sendsAll} 后端=${backAll}`);

    const skipLocal = /function allPackageNames\s*\(/.test(apiSrc) && /src !== 'upload' && src !== 'private'/.test(apiSrc);
    check('全部包模式会跳过只在本地的包（上传包 / 私有包），不会每次跑完都报失败', skipLocal);
  }

  console.log('\x1b[1m六、导出时连带依赖 / 缓存导入分页与批量 / 下载进度双栏\x1b[0m');
  {
    // ① 指定导出库时其依赖也一并导出
    const expHtml = /id="exp-with-deps"/.test(home.text) && /id="exp-deps-row"/.test(home.text);
    check('导出区有「同时导出选中包的依赖（递归）」勾选框', expHtml && /同时导出选中包的依赖/.test(home.text));
    const expJs = js.text.includes('withDeps: true') && /payload\.withDeps/.test(js.text) && /exp-deps-row/.test(js.text);
    check('导出选中的包时前端默认带上 withDeps', expJs);
    const expBack = /function collectDepClosure\s*\(/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'bundle.js'), 'utf8'))
      && /withDeps && scope === 'selected'/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'bundle.js'), 'utf8'));
    const expApi = /body\.withDeps/.test(apiSrc);
    check('后端按依赖闭包扩大导出名单（collectDepClosure），接口透传 withDeps', expBack && expApi,
      `bundle=${expBack} api=${expApi}`);
    check('导出结果会提示连带依赖数量、缺的依赖会提醒先补进镜像',
      /含连带依赖/.test(js.text) && /missingDeps/.test(js.text));

    // ② 本机 npm 缓存导入：分页 + 全部导入 + 仅导入不存在的包 + 提示 bug 修复
    const scanBtns = ['scan-import-new', 'scan-import-all', 'scan-pager'].every((id) => new RegExp(`id="${id}"`).test(home.text));
    check('缓存导入区有「仅导入不存在的包」「全部导入」与分页容器', scanBtns
      && /仅导入不存在的包/.test(home.text) && /全部导入/.test(home.text));
    check('缓存表格按页渲染（SCAN_PAGE_SIZE + 分页器）',
      /SCAN_PAGE_SIZE/.test(js.text) && /function paintScanPager\s*\(/.test(js.text) && /items\.slice\(start/.test(js.text));
    check('勾选项按包名去版本后缀再提交（修复「成功 0，失败 0，跳过 N」）',
      /function scanSelNames\s*\(/.test(js.text) && /replace\(\/@\[\^@\]\*\$\/,\s*''\)/.test(js.text) && /importScan\('sel'\)/.test(js.text));
    check('导入结果提示写明成功/新增版本/tarball/失败/跳过',
      /缓存导入完成：成功 \d*' \+\s*/.test(js.text) || /缓存导入完成：成功/.test(js.text));
    check('扫描结果带「镜像里已有」标记（local 字段），后端补上该字段',
      /function withLocalFlags\s*\(/.test(apiSrc) && /local: store\.index\.has/.test(apiSrc));
    check('「全部导入」需显式确认后才真的跑（all:true + confirm:true）',
      /body\.all = true; body\.names = \[\]; body\.confirm = true/.test(js.text) && /ECONFIRM/.test(apiSrc));

    // ③ 下载进度弹窗右侧「正在下载的包」栏：样式同单包大进度条、两栏等高、滚动独立
    check('下载进度弹窗有右侧「正在下载 · 单包进度」栏工厂', /function runningPane\s*\(/.test(js.text)
      && /正在下载 · 单包进度/.test(js.text) && /fill-col-right/.test(js.text));
    check('补 tarball 与递归添加依赖两个弹窗都接上了右栏（runPane.paint 至少 5 处调用）',
      (js.text.match(/runPane\.paint\(/g) || []).length >= 5, `n=${(js.text.match(/runPane\.paint\(/g) || []).length}`);
    check('右栏每包一条大进度条（tr-fillrow + tr-fill 宽度随进度）',
      /tr-fillrow busy' \}/.test(js.text) || /taskrow tr-fillrow busy/.test(js.text), '');
    const twoCol = /\.fill-cols\{[^}]*display:flex/.test(css.text) && /\.fill-col\{[^}]*height:300px/.test(css.text)
      && /\.fill-col\{[^}]*overflow:auto/.test(css.text)
      && /\.fill-col-right\{[^}]*border-left/.test(css.text);
    check('样式表：两栏等高（各 300px）、各自 overflow:auto、右栏有分隔线', twoCol);
    check('弹窗加宽到 wide 才能并排两栏（补 tarball 弹窗已用 wide）',
      /title: scopeAll \? '补 tarball · 全部包' : '补 tarball', sub: 'FETCH TARBALLS', body: body, sticky: true, wide: true/.test(js.text));

    // ④ 从本机缓存导入的「具体导入进度」弹窗：正在导入的包 + 逐包导入详情
    const cacheModal = /function runCacheImport\s*\(/.test(js.text) && /从本机缓存导入/.test(js.text)
      && /正在导入 · 当前包/.test(js.text) && /取消导入/.test(js.text);
    check('缓存导入有进度弹窗（runCacheImport：正在导入 · 当前包 / 取消导入）', cacheModal);
    check('缓存导入走长任务 + 轮询（progress:true → taskId → /tasks/<id>）',
      /progress:\s*true/.test(js.text) && /d\.taskId/.test(js.text) && /api\('\/tasks\/' \+ taskId\)/.test(js.text));
    check('导入进度弹窗复用两栏布局（fill-cols + runningPane 参数化文案）',
      /var runPane = runningPane\(1, \{/.test(js.text) && /head: '正在导入 · 当前包'/.test(js.text) && /\.fill-cols\{[^}]*display:flex/.test(css.text));
    check('逐包导入详情标出「新增 N 个版本 / N 个 tarball」「跳过原因」「失败原因」',
      /✓ 新增 /.test(js.text) && /· 跳过：/.test(js.text) && /导入完毕/.test(js.text));
    check('整体进度行写明「已处理 k / N 个包」+ 成功/失败/跳过/新增版本与 tarball',
      /已处理 /.test(js.text) && /个包（' \+ \(d\.percent/.test(js.text) && /个版本 \/ /.test(js.text));
    const importApi = /body\.progress === true/.test(apiSrc) && /type: 'cache-import'/.test(apiSrc) && /async: true, total/.test(apiSrc);
    const importMod = /phase: 'version'/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'npmcache.js'), 'utf8'))
      && /isCanceled/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'npmcache.js'), 'utf8'))
      && /canceled: false/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'npmcache.js'), 'utf8'));
    check('后端 /npmcache/import 支持 progress:true（建 cache-import 任务 + 立即返回 taskId）', importApi);
    check('后端逐包上报 start/version/done 事件并可取消（isCanceled → canceled）', importMod);
    check('任务快照带 current/currentDone/currentTotal（右栏「当前包」大进度条的数据源）',
      /currentDone: t\.currentDone/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'tasks.js'), 'utf8')));
  }

  console.log(`\n\x1b[1m结果：${pass}/${pass + fail} 通过\x1b[0m\n`);
  finish(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('自检异常：', e); finish(1); });

/*
 * 退出方式说明：Node 24（Windows）下，fetch（undici）的 keep-alive 句柄正在关闭时直接调用
 * process.exit() 会触发 libuv 断言：
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 * 进程退出码会变成 0xC0000409（-1073740791），让本来通过的验收看起来像崩溃。
 * 这里改为「先设退出码 → 等句柄关闭 → 再退出」。
 */
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 400);
}
