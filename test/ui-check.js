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
  const iconType = icon.headers.get('content-type') || '';
  check('GET /favicon.ico 返回项目图标（200 且 image/x-icon）', icon.status === 200 && /^image\/x-icon/i.test(iconType), `status=${icon.status} type=${iconType}`);
  check('首页声明了 favicon（<link rel="icon" href="favicon.ico">）', /<link[^>]+rel=["']icon["'][^>]*favicon\.ico/i.test(home.text));

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
  const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');

  console.log('\x1b[1m二之二、自绘悬浮提示（替代浏览器原生 title 弹窗）\x1b[0m');
  {
    const nativeTitles = (home.text.match(/[\s"']title=/g) || []).length;
    const tipAttrs = (home.text.match(/[\s"']data-tip=/g) || []).length;
    check('首页不再用原生 title 提示，全部改成 data-tip（交给自绘浮层）',
      nativeTitles === 0 && tipAttrs >= 15, `原生 title=${nativeTitles} data-tip=${tipAttrs}`);
    const mapTitle = /k === 'title'\) n\.setAttribute\('data-tip'/.test(js.text) && /function setTip\(n, s\)/.test(js.text);
    check('app.js 的 el() 把 title: 自动映射成 data-tip，动态文案统一走 setTip',
      mapTitle && !/\.title\s*=/.test(js.text), mapTitle ? '' : 'el() 没把 title 映射成 data-tip');
    const ctrl = /var uiTip = \(function \(\)/.test(js.text) && /'\[data-tip\]'/.test(js.text)
      && /addEventListener\('mouseover'/.test(js.text) && /addEventListener\('mouseout'/.test(js.text)
      && /--tip-ax/.test(js.text) && /window\.innerWidth/.test(js.text);
    check('自绘浮层逻辑齐全（悬停延迟显示、跟随鼠标目标、按视口自动翻转/夹边、箭头对准目标）', ctrl);
    const tipCss = /\.ui-tip\{[^}]*position\s*:\s*fixed/.test(css.text)
      && /\.ui-tip\.on\{[^}]*opacity\s*:\s*1/.test(css.text)
      && /\.ui-tip::after\{/.test(css.text) && /\.ui-tip\.above::after\{/.test(css.text);
    check('样式表有 .ui-tip 浮层样式（固定定位、显示态、小箭头、上方翻转）', tipCss);
    const themed = /\.ui-tip\{[^}]*var\(--mono\)/.test(css.text)
      && /\.ui-tip\{[^}]*var\(--line-2\)/.test(css.text) && /\.ui-tip\{[^}]*var\(--cy-2\)/.test(css.text);
    check('浮层用项目自有配色/字体变量（--mono、--line-2、--cy-2），与整体风格一致', themed);
  }

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

  console.log('\x1b[1m五、包管理工具栏：批量入口 + 「缺 tarball / 不缺 tarball」快捷筛选\x1b[0m');
  {
    const allBtns = ['pkg-fill-tags-all', 'pkg-fill-latest-all', 'pkg-fill-all-all'];
    const bothBtns = allBtns.every((id) => new RegExp(`id="${id}"`).test(home.text));
    check('包管理工具栏有「全部包补 dist-tag 版本」「全部包补最新版本」「全部包补全部版本」三个按钮', bothBtns,
      bothBtns ? '' : 'index.html 里缺少 #pkg-fill-tags-all / #pkg-fill-latest-all / #pkg-fill-all-all 之一');
    const labels = /全部包补 dist-tag 版本/.test(home.text) && /全部包补最新版本/.test(home.text) && /全部包补全部版本/.test(home.text);
    check('三个按钮文案齐全（不用勾选任何包就能跑）', labels);

    const handlers = allBtns.every((id) => js.text.includes(`'${id}'`));
    const helper = /function fillAllTarballs\s*\(/.test(js.text);
    check('app.js 绑定了这三个按钮并复用 runFill 的「全部包」模式（fillAllTarballs）', handlers && helper,
      `handlers=${handlers} fillAllTarballs=${helper}`);

    // 「补全部版本」是下载量最大的入口：走 mode='all'，确认框要写清范围，并给出「还差多少个版本」的估计
    const allMode = /fillAllTarballs\('all'\)/.test(js.text) && /全部包 · 补全部版本/.test(js.text)
      && /所有缺失版本/.test(js.text) && /个版本的 tarball 没缓存/.test(js.text) && /ALL VERSIONS/.test(js.text);
    check('「全部包补全部版本」走 mode=all，确认框写明补「所有缺失版本」并给出未缓存版本数估计',
      allMode);
    const allBack = /body\.mode === 'all' \? 'all'/.test(apiSrc) && /全部版本/.test(apiSrc) && /planTargets/.test(apiSrc);
    check('后端 /packages/pull 的 scope=all 支持 mode=all（服务端规划全部缺失版本），标题会写「全部包补 全部版本」',
      allBack);

    const sendsAll = /\{\s*mode:\s*mode,\s*all:\s*true/.test(js.text) || /all:\s*true,\s*concurrency/.test(js.text);
    const backAll = /body\.all === true \|\| body\.scope === 'all'/.test(apiSrc);
    check('前端确实发 all:true、后端 /packages/pull 与 /packages/prefetch 都认这个作用域', sendsAll && backAll,
      `前端=${sendsAll} 后端=${backAll}`);

    const skipLocal = /function allPackageNames\s*\(/.test(apiSrc) && /src !== 'upload' && src !== 'private'/.test(apiSrc);
    check('全部包模式会跳过只在本地的包（上传包 / 私有包），不会每次跑完都报失败', skipLocal);

    // 快捷筛选：缺 tarball / 不缺 tarball（再点一次同一个按钮回到全部）
    const tbHtml = /id="pkg-tb"/.test(home.text) && /data-tb="missing"/.test(home.text) && /data-tb="complete"/.test(home.text)
      && /缺 tarball/.test(home.text) && /不缺 tarball/.test(home.text);
    check('包管理工具栏有「缺 tarball / 不缺 tarball」两个快捷筛选按钮', tbHtml,
      tbHtml ? '' : 'index.html 里缺少 #pkg-tb 或 data-tb="missing|complete"');
    const tbJs = /tarballs: 'all'/.test(js.text) && /&tarballs=/.test(js.text)
      && /function paintPackages/.test(js.text) && /data-tb/.test(js.text);
    check('前端把 tarballs 筛选带进包列表请求，并在每次渲染时同步按钮高亮', tbJs);
    const tbToggle = /state\.pkg\.tarballs === v \? 'all' : v/.test(js.text);
    check('点同一个筛选按钮可取消筛选（再点一下回到「全部」）', tbToggle);
    const tbBack = /tarballs: q\.get\('tarballs'\) \|\| 'all'/.test(apiSrc)
      && /tarballs === 'missing' && missing === 0/.test(storeSrc)
      && /tarballs === 'complete' && missing > 0/.test(storeSrc);
    check('后端 /packages 透传 tarballs，store.list 按「版本数 - 已缓存数」判定缺/不缺', tbBack);
    try {
      const r1 = await get('/__admin/api/packages?size=5&tarballs=missing', { json: true });
      const d1 = r1.json && r1.json.data;
      const r2 = await get('/__admin/api/packages?size=5&tarballs=complete', { json: true });
      const d2 = r2.json && r2.json.data;
      const ok1 = r1.status === 200 && d1 && Array.isArray(d1.items) && d1.items.every((x) => x.hasAllTarballs === false);
      const ok2 = r2.status === 200 && d2 && Array.isArray(d2.items) && d2.items.every((x) => x.hasAllTarballs === true);
      check('GET /packages?tarballs=missing / complete 返回的每一行都符合筛选条件（真接口）', ok1 && ok2,
        `missing=${d1 && d1.total} complete=${d2 && d2.total}`);
    } catch (e) {
      check('GET /packages?tarballs=missing / complete 返回的每一行都符合筛选条件（真接口）', false, e.message);
    }
  }

  console.log('\x1b[1m五之二、补 tarball 进度弹窗左栏：超过行数上限时收起已完成的行\x1b[0m');
  {
    // 大任务（全部包补全部版本）会先塞满 500 个「✓」行，后面的包拿不到行，看起来像「全部完成」。
    // 规则：超上限时从最老的开始收起「已完成」的行；错误 / 下载中 / 未开始的行绝不动（错误行永远保留）。
    const hasReclaim = /function reclaimRow\s*\(/.test(js.text) && /var MAX_ROWS = 500;/.test(js.text)
      && /function hiddenCount\s*\(/.test(js.text) && /fill-hidden-note/.test(js.text);
    check('左栏保留 500 行上限，超上限时收起已完成的行并提示「已收起 N 个」', hasReclaim);
    const onlyOk = /if \(\(' ' \+ r\.className \+ ' '\)\.indexOf\(' ok '\) < 0\) continue;/.test(js.text);
    check('回收只挑「已完成」（ok）的行：错误、下载中、还没开始的行都不动', onlyOk);
    const guard = /if \(hiddenDone\[p\.name\] && !p\.error\) return;/.test(js.text)
      && /if \(Object\.keys\(rows\)\.length >= MAX_ROWS && !reclaimRow\(\)\) return;/.test(js.text);
    check('已收起的包不再重复建行（真出错了才重建），建行前先检查行数上限', guard);
    const noteCssBlock = (css.text.match(/\.fill-hidden-note\{[^}]*\}/) || [''])[0];
    check('提示条样式 .fill-hidden-note 与项目风格一致（等宽字 + 虚线边框，暗色小字）',
      /var\(--mono\)/.test(noteCssBlock) && /dashed/.test(noteCssBlock));

    // 从 app.js 里抠出真实实现（hiddenCount / showHiddenNote / reclaimRow），注入假 DOM 跑一遍
    try {
      const from = js.text.indexOf('function hiddenCount()');
      const to = js.text.indexOf('function mkRow(n)');
      const snippet = from >= 0 && to > from ? js.text.slice(from, to) : '';
      check('能从 app.js 中提取出回收逻辑（源码结构未被改乱）', snippet.length > 0);
      const mkList = () => {
        const kids = [];
        const l = {
          children: kids,
          firstChild: null,
          appendChild(node) { kids.push(node); l.firstChild = kids[0] || null; return node; },
          insertBefore(node) { kids.unshift(node); l.firstChild = kids[0] || null; return node; },
          removeChild(node) { const i = kids.indexOf(node); if (i >= 0) kids.splice(i, 1); l.firstChild = kids[0] || null; return node; }
        };
        return l;
      };
      const elStub = (tag, attrs) => ({
        tag,
        className: (attrs && attrs.class) || '',
        textContent: (attrs && attrs.text) || '',
        parentNode: null
      });
      const list = mkList();
      const rows = {};
      const order = [];
      const hiddenDone = {};
      const addRow = (name, cls) => {
        const r = elStub('div', { class: 'taskrow tr-fillrow ' + cls });
        r.__tv = { textContent: '' };
        r.parentNode = list;
        list.appendChild(r);
        rows[name] = r;
        order.push(name);
      };
      addRow('a', 'ok');       // 已完成 → 可收起
      addRow('b', 'err');      // 出错 → 永远保留
      addRow('c', 'busy');     // 下载中 → 不动
      addRow('d', 'ok');       // 已完成 → 第二个被收起
      const factory = new Function('rows', 'order', 'hiddenDone', 'hiddenNote', 'list', 'el', 'fmtNum', 'MAX_ROWS',
        snippet + '\n; return { reclaimRow: reclaimRow, hiddenCount: hiddenCount, showHiddenNote: showHiddenNote };');
      const impl = factory(rows, order, hiddenDone, null, list, elStub, (n) => String(n), 500);
      const first = impl.reclaimRow();
      const noteNode = list.children.find((x) => x.className === 'fill-hidden-note');
      check('回收时跳过排在前面的出错行，收起最老的 completed 行并记录到 hiddenDone',
        first === true && !rows.a && !!rows.b && !!rows.c && hiddenDone.a === true && order.join(',') === 'b,c,d');
      check('回收后左栏顶部出现提示条，文案写明已收起数量和上限',
        !!noteNode && /已收起 1 个已完成的包/.test(noteNode.textContent) && /左栏最多保留 500 行/.test(noteNode.textContent)
        && /不会被收起/.test(noteNode.textContent));
      const second = impl.reclaimRow();
      const third = impl.reclaimRow();
      check('再收一行后没有可收的就返回 false（出错/下载中的行一直保留，不会被清掉）',
        second === true && !rows.d && !!rows.b && !!rows.c && third === false && impl.hiddenCount() === 2);
    } catch (e) {
      check('回收逻辑单测（源码注入假 DOM）', false, e.message);
    }
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

    // ①-b 镜像里没有的依赖：cache 模式下自动下载入库后再导出
    const autoHtml = /id="exp-auto-fetch"/.test(home.text) && /自动从上游下载并入库/.test(home.text);
    check('导出区有「镜像里没有的依赖自动从上游下载并入库」勾选框', autoHtml);
    const autoJs = /payload\.autoFetchDeps/.test(js.text) && /depsFetched/.test(js.text);
    check('前端把 autoFetchDeps 透传给后端，并在结果里展示自动下载数量', autoJs);
    const bundleSrcAuto = fs.readFileSync(path.join(__dirname, '..', 'src', 'bundle.js'), 'utf8');
    const autoBack = /autoFetchDeps/.test(apiSrc) && /function autoFillDeps\s*\(/.test(bundleSrcAuto)
      && /pullTarballs/.test(bundleSrcAuto) && /resolveClosure/.test(bundleSrcAuto);
    check('后端 cache/proxy 模式下自动补依赖（autoFillDeps → resolveClosure + pullTarballs），接口透传 autoFetchDeps', autoBack);
    check('自动补依赖失败不会中断导出：失败原因写进 missingDeps.reason，离线/未联网时给 skippedReason',
      /自动下载失败/.test(bundleSrcAuto) && /纯离线模式/.test(bundleSrcAuto) && /skippedReason/.test(bundleSrcAuto));

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

    // ③-b 右侧改成「版本进度」：每个正在并发下载的版本（tarball 文件）一条，实时显示自身字节进度
    const pullSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pull.js'), 'utf8');
    const upSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'upstream.js'), 'utf8');
    const regSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'registry.js'), 'utf8');
    check('补 tarball 弹窗右栏换成「正在下载 · 版本进度」栏（downloadsPane：每个并发下载一条实时进度）',
      /function downloadsPane\s*\(/.test(js.text) && /正在下载 · 版本进度/.test(js.text)
      && /runPane\.paint\(d\.downloads\)/.test(js.text) && /同时 ' \+ list\.length/.test(js.text));
    check('版本进度行显示「已下载 / 总共（百分比）」字节数，并按采样算实时速度',
      /fmtBytes\(recv\) \+ ' \/ ' \+ fmtBytes\(total\)/.test(js.text) && /it\.speed > 0/.test(js.text));
    check('服务端把每个 tarball 的下载字节数逐块上报：readBodyBuffer/downloadTarball → ensureTarballEx(opts) → pullTarballs 的 downloads',
      /onProgress/.test(upSrc) && /onProgress,/.test(upSrc) && /ensureTarballEx\(ctx, name, version, opts\)/.test(regSrc)
      && /downloads: \[\]/.test(pullSrc) && /active\.delete\(ak\)/.test(pullSrc));
    check('任务快照带 downloads 字段（api.js 把 info.downloads 透传，前端据此渲染版本级进度）',
      /downloads: \(info\.downloads \|\| \[\]\)/.test(apiSrc));

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

  console.log('\x1b[1m七、导入备份：网页上传上限预检 + 本地文件通路\x1b[0m');
  {
    const httpSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'http-util.js'), 'utf8');
    const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    // ① 页面：上限提示 + 六步指引里的本地文件通路
    check('导入备份面板有上传上限提示（#imp-limit-hint）', /id="imp-limit-hint"/.test(home.text) && /离线包上传上限/.test(home.text));
    check('迁移指引写明「超过上传上限的大包放进 data\\bundles 再点导入」',
      /data\\bundles/.test(home.text) && /一键导入离线包\.cmd/.test(home.text));
    check('配置页有「离线包上传上限」字段（storage.maxBundleUploadMB）',
      /label: '离线包上传上限（MB）'/.test(js.text) && /'storage\.maxBundleUploadMB'/.test(js.text));
    // ② 前端预检：超限不发请求，直接给可行通路；网络错误文案不再是一句没头没尾的「上传失败（网络错误）」
    check('前端有上限 helper（bundleUploadLimitMB / uploadLimitMB）并渲染真实上限',
      /function bundleUploadLimitMB\s*\(/.test(js.text) && /function uploadLimitMB\s*\(/.test(js.text) && /function paintImpLimitHint\s*\(/.test(js.text));
    check('拖入文件超上限时前端直接拦截（超过网页上传上限 + 放进 data\\bundles 指引）',
      /超过网页上传上限/.test(js.text) && /不受上传上限限制/.test(js.text) && /file\.size > limitMB \* 1024 \* 1024/.test(js.text));
    check('上传网络错误文案写明原因与替代通路（上传中断（网络错误））',
      /上传中断（网络错误）/.test(js.text) && !/'上传失败（网络错误）'/.test(js.text));
    check('单包上传也有体积预检（超过单包上传上限）', /超过单包上传上限/.test(js.text) && /storage\.maxUploadMB/.test(js.text));
    // ③ 后端：离线包上传流式落盘、独立上限、体积/时长、可见日志
    check('原始体上传改为流式落盘（readBodyToFile，不再整包读内存）',
      /function readBodyToFile\s*\(/.test(httpSrc) && /createWriteStream/.test(httpSrc)
        && /readBodyToFile\(req, temp/.test(apiSrc));
    check('离线包上传用独立上限 storage.maxBundleUploadMB（与单包 maxUploadMB 分开）',
      /maxBundleUploadMB \|\| 4096/.test(apiSrc) && /maxBundleUploadMB:\s*clampInt/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8')));
    check('声明体积就超限时立刻 413（不必收完几个 GB）', /content-length/.test(apiSrc) && /拒绝上传离线包/.test(apiSrc));
    check('服务端 requestTimeout 放宽到大离线包够用（≥ 10 分钟）',
      Number((srvSrc.match(/server\.requestTimeout\s*=\s*(\d+)/) || [])[1]) >= 600000);
    check('413/408 记 warn 日志（原来只在 debug，日志里完全看不到上传失败）', /code === 413 \|\| code === 408\) log\.warn/.test(srvSrc));
  }

  console.log('\x1b[1m八、导出 / 导入备份：详细进度条（上传进度 → 任务进度 → 逐包明细）\x1b[0m');
  {
    const bundleSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'bundle.js'), 'utf8');
    const tarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'tar.js'), 'utf8');
    const tasksSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'tasks.js'), 'utf8');

    // ① 页面入口：导出、导入（网页上传 + 服务器已有文件）都走进度弹窗
    check('导出备份走进度弹窗（#exp-run 绑定调用 runBundleExport）',
      /function runBundleExport\s*\(/.test(js.text) && /runBundleExport\(payload, btn\)/.test(js.text)
        && !/#exp-run'\)\.addEventListener\('click'[\s\S]{0,2000}?api\('\/bundles\/export'/.test(js.text));
    check('导入备份两条通路都走进度弹窗（服务器已有 bundle / 网页上传 → runBundleImport）',
      /function runBundleImport\s*\(/.test(js.text)
        && /runBundleImport\(\{ name: file, overwrite: !!ow \}\)/.test(js.text)
        && /runBundleImport\(\{ file: file, overwrite: !!ow \}\)/.test(js.text));
    check('进度弹窗有整体进度条 + 统计行 + 左右两栏（复用缓存导入的样式）',
      /function bundleProgressModal\s*\(/.test(js.text)
        && /class: 'progressbar'/.test(js.text) && /class: 'fill-stat'/.test(js.text)
        && /class: 'fill-cols'/.test(js.text) && /function runningPane\s*\(/.test(js.text));

    // ② 细节：逐包明细一行一包、当前包大进度条、上传字节进度、轮询与取消
    check('逐包明细行区分 已打包 / 已导入 / 失败 / 跳过（左栏数据源）',
      /function bundlePkgRow\s*\(/.test(js.text) && /✓ 已打包/.test(js.text) && /✓ 新增 /.test(js.text)
        && /· 跳过：/.test(js.text) && /✕ /.test(js.text));
    check('网页上传用 XHR 的 upload.onprogress 显示上传字节进度（fetch 拿不到上传进度）',
      /function uploadBundleXhr\s*\(/.test(js.text) && /new XMLHttpRequest\(\)/.test(js.text)
        && /xhr\.upload\.onprogress/.test(js.text) && /kind: 'upload'/.test(js.text)
        && /\/bundles\/import\?progress=1/.test(js.text));
    check('上传完成后切到任务进度：轮询 /tasks/<id>（500ms，连续失败重试 2 次再放弃）',
      /api\('\/tasks\/' \+ taskId\)/.test(js.text) && /setInterval\(poll, 500\)/.test(js.text)
        && /pollFails <= 2/.test(js.text));
    check('进度弹窗可取消（调用 /tasks/<id>/cancel，并提示当前包处理完就停）',
      /\/tasks\/' \+ taskId \+ '\/cancel'/.test(js.text) && /已请求停止/.test(js.text));
    check('导出/导入结束仍写页面状态行（#exp-status 已导出、#imp-status 导入完成）且导出后自动下载',
      /'已导出 ' \+ r\.file/.test(js.text) && /'导入完成：'/.test(js.text) && /downloadBundle\(r\.file\)/.test(js.text));
    check('导出成功后自动关窗、导入保留详情窗（与缓存导入一致）',
      /成功导出自动关窗/.test(js.text) && /taskFinishedButtons\(m\)/.test(js.text));

    // ③ 后端：长任务范式 + 事件流
    check('后端 export/import 支持 progress 长任务（startBundleTask → {taskId,async:true}）',
      /function startBundleTask\s*\(/.test(apiSrc) && /taskId, async: true/.test(apiSrc)
        && /body\.progress === true/.test(apiSrc) && /get\('progress'\)/.test(apiSrc));
    check('导出进度事件：collect / package / pack（逐包已打包 + 当前包 tarball 进度）',
      /phase: 'collect-start'/.test(bundleSrc) && /phase: 'collect-done'/.test(bundleSrc)
        && /phase: 'package'/.test(bundleSrc) && /phase: 'pack'/.test(bundleSrc));
    check('导入进度事件：extract / extract-done / package-start / version / package',
      /phase: 'extract'/.test(bundleSrc) && /phase: 'extract-done'/.test(bundleSrc)
        && /phase: 'package-start'/.test(bundleSrc) && /phase: 'version'/.test(bundleSrc)
        && /phase: 'package'/.test(bundleSrc));
    check('打包可中断（packTarGz 支持 shouldAbort，取消时删半成品）',
      /shouldAbort/.test(tarSrc) && /ECANCELED/.test(bundleSrc) && /导出已取消/.test(bundleSrc));
    check('任务快照暴露 bytesTotal（解包阶段按字节画整体进度条）', /bytesTotal: t\.bytesTotal/.test(tasksSrc));
    check('弹窗的说明文字随阶段变化（phaseNote：统计/打包、解包/写入本地）',
      /opts\.phaseNote/.test(js.text) && /d\.status === 'running' && opts\.phaseNote/.test(js.text)
        && /正在统计要导出的包/.test(js.text) && /正在打包并压缩/.test(js.text)
        && /正在解包备份文件…（可以取消/.test(js.text) && /正在把包写入本地存储/.test(js.text));

    // ④ 并行进度：右栏「同时在处理的包」多行（原来并行 10 路也只显示 1 条「当前包」）
    check('后端记录并行包：tar 上报 active、bundle 导出/导入事件带 inFlight、任务快照透传',
      /active: Array\.from\(active\)/.test(tarSrc) && /inFlight/.test(bundleSrc)
        && /const flight = \(\) =>/.test(bundleSrc) && /inFlight: Array\.isArray\(ev\.inFlight\)/.test(apiSrc)
        && /inFlight: t\.inFlight \|\| \[\]/.test(tasksSrc));
    check('右栏按 inFlight 渲染多行，标题改成「并行文件/并行包」，并发上限来自任务快照',
      /Array\.isArray\(d\.inFlight\) && d\.inFlight\.length/.test(js.text)
        && /runPane\.setMax\(d\.concurrency \|\| 1\)/.test(js.text)
        && /setMax: function \(n\)/.test(js.text)
        && /正在打包 · 并行文件/.test(js.text) && /正在导入 · 并行包/.test(js.text));
    check('任务收尾清空 inFlight（导出/导入结束后右栏不留残行）',
      /update\(\{ inFlight: \[\] \}\)/.test(apiSrc) && /o\.update\(\{ inFlight: \[\] \}\)/.test(apiSrc));
    /* 导出右栏改成条目级「并行文件」：一个正在压缩的文件一行（带文件名/大小），
     * 行数就是真正在干活的路数，收尾只剩一个包时也不会塌成 1 行；导入仍是一包一路。 */
    check('导出右栏是条目级「并行文件」：inFlight 带 file/size，界面一行一个文件显示「压缩中…」',
      bundleSrc.includes("file: String(e.name || '').replace(/^storage\\/[^/]+\\//, '')")
        && js.text.includes("if (p.file) {") && js.text.includes("target: 0, spin: true, size: Number(p.size) || 0")
        && js.text.includes("'压缩中…'") && js.text.includes('正在打包 · 并行文件')
        && js.text.includes('paneCountUnit'));
    /* 收尾写盘阶段也要看得见：用户反馈「显示 100% 却不结束」，其实是压缩完在拼接分片写最终 .tgz。 */
    check('导出收尾写盘阶段有进度：tar 报 concat 字节进度 → 任务快照 concatDone/concatTotal → 界面显示「正在拼接分片」',
      /stage: 'concat'/.test(tarSrc) && /concatDone: Number\(s\.copied\)/.test(bundleSrc)
        && /concatDone: Number\(ev\.concatDone\)/.test(apiSrc) && /concatDone: t\.concatDone \|\| 0/.test(tasksSrc)
        && js.text.includes('正在把') && js.text.includes('拼接写入最终 .tgz')
        && js.text.includes('正在写入 · 拼接分片')
        && js.text.includes('paneHeadFor') && js.text.includes('barPct')
        /* 右栏的 text 行（只有字节进度、没有 target）必须能过筛选，否则真机上这一行会被过滤掉、界面上看不到 */
        && js.text.includes('!p.spin && !p.text') && js.text.includes('isWritePhase')
        && /current: '', currentDone: 0, currentTotal: 0/.test(apiSrc));
  }

  console.log('\x1b[1m九、离线包并行导出 / 导入 + 「根目录名不是 package」兼容\x1b[0m');
  {
    const bundleSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'bundle.js'), 'utf8');
    const tarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'tar.js'), 'utf8');
    const tasksSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'tasks.js'), 'utf8');
    const configSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
    const cliSrc = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');

    // ① 配置项：默认值、范围校验、界面字段
    check('配置有离线包导出/导入并发项（storage.bundleExportConcurrency / bundleImportConcurrency，默认 4）',
      /bundleExportConcurrency:\s*4/.test(configSrc) && /bundleImportConcurrency:\s*4/.test(configSrc)
        && /clampInt\(st\.bundleExportConcurrency, 1, 16, 4\)/.test(configSrc)
        && /clampInt\(st\.bundleImportConcurrency, 1, 16, 4\)/.test(configSrc));
    check('PUT /config 校验并发项必须是 1-16 的整数',
      /bundleExportConcurrency', 'bundleImportConcurrency'/.test(apiSrc) && /1-16 的整数/.test(apiSrc));
    check('配置页「存储」段有「离线包导出并发 / 离线包导入并发」两个字段',
      /k: 'storage\.bundleExportConcurrency'/.test(js.text) && /k: 'storage\.bundleImportConcurrency'/.test(js.text)
        && /离线包导出并发/.test(js.text) && /离线包导入并发/.test(js.text));

    // ② 后端：并发真正接到打包/导入流程，任务快照带并发度
    check('导出按配置并发打包（packTarGz concurrency + 多段 gzip 拼接成标准 tar.gz）',
      /concurrency: conc/.test(apiSrc) && /bundleExportConcurrency/.test(apiSrc)
        && /concurrency = 1 } = \{\}\)/.test(tarSrc) && /function concatFiles/.test(tarSrc)
        && /\.p\$\{idx\}\.tar\.gz/.test(tarSrc));
    check('导出逐包明细改用 onEntryDone 的条目下标映射（并行下顺序不固定）',
      /onEntryDone/.test(tarSrc) && /entryPkg/.test(bundleSrc) && /pkgSeen/.test(bundleSrc));
    check('导入按配置并发处理不同包（worker 池 + 每包只锁自己，包内版本仍顺序）',
      /bundleImportConcurrency/.test(apiSrc) && /async function importOneDir/.test(bundleSrc)
        && /const worker = async \(\)/.test(bundleSrc) && /withLock\(name/.test(bundleSrc)
        && /concurrency: Math\.max\(1, Number\(cfg\.storage\.bundleImportConcurrency\)/.test(apiSrc));
    check('并行导入的包进度按「已完成包数」推进（不再用包的起始序号）',
      /done: pkgs\.length/.test(apiSrc) && !/done: Number\(ev\.index\) \|\| pkgs\.length/.test(apiSrc));
    check('任务快照带并发度（tasks.create 收 concurrency，前端显示「并行 N 路」）',
      /concurrency: Number\(init\.concurrency\) \|\| 1/.test(tasksSrc)
        && /concurrency: conc/.test(apiSrc) && /并行 ' \+ d\.concurrency \+ ' 路压缩/.test(js.text)
        && /并行 ' \+ d\.concurrency \+ ' 路导入/.test(js.text));

    // ③ 根目录名不是 package 的 tarball：读取/校验改为「一层目录 + package.json」
    check('读取包描述不再硬编码 package/package.json（readRootPackageJson + 一层目录正则）',
      /const ROOT_PACKAGE_JSON = \/\^\[\^\/\]\+\\\/package\\\.json\$\/;/.test(tarSrc)
        && /async function readRootPackageJson/.test(tarSrc)
        && /wanted instanceof RegExp/.test(tarSrc));
    check('导入校验与 .tgz 上传都改用根级 package.json，找不到时按兼容方式处理（不再整包丢弃）',
      /tar\.readRootPackageJson\(useFile\)/.test(bundleSrc) && /tar\.readRootPackageJson\(file\)/.test(bundleSrc)
        && /按兼容方式导入/.test(bundleSrc));
    check('跳过原因写清楚（bundle 内缺少 tarball / 版本已存在），界面不再只显示一句含糊的「已存在或不可导入」',
      /bundle 内缺少 \$\{metadataOnlySkipped\} 个版本的 tarball/.test(bundleSrc)
        && /'版本已存在'/.test(bundleSrc));

    // ④ 命令行也走并发配置（保持与服务端一致的默认行为）
    check('命令行 export/import 读取配置里的并发度',
      /bundleExportConcurrency\) \|\| 4/.test(cliSrc) && /bundleImportConcurrency\) \|\| 4/.test(cliSrc));
  }

  console.log('\x1b[1m十、导入备份结束后的「失败 / 跳过详情」（整理在弹窗最下方，可一键复制）\x1b[0m');
  {
    const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

    check('进度弹窗支持结束后追加内容（onFinalize 钩子，拿到弹窗 body 与左栏列表）',
      /opts\.onFinalize/.test(js.text) && /opts\.onFinalize\(d, \{ body: bodyEl, list: list \}\)/.test(js.text));

    check('导入结束会调用失败详情面板（bundleImportFailPanel + runBundleImport 传 onFinalize）',
      /function bundleImportFailPanel\(d\)/.test(js.text) && /bundleImportFailPanel\(d\)/.test(js.text)
        && /onFinalize: function \(d, ui\)/.test(js.text) && /ui\.body\.appendChild\(box\)/.test(js.text));

    check('详情块放在弹窗最下方：可滚动容器 + 顶部标题 + 「复制清单」按钮',
      /class: 'fill-err bundle-fail'/.test(js.text) && /fill-err-head/.test(js.text)
        && /text: '复制清单'/.test(js.text) && /\.fill-err\.bundle-fail\{max-height:230px\}/.test(cssSrc)
        && /\.fill-err \.fill-err-head\{/.test(cssSrc));

    check('失败逐条列出「name@version：error」（错误文案自带前缀时不重复），条数很多时提示复制拿全部',
      /var pre = f\.name \+ \(f\.version \? '@' \+ f\.version : ''\)/.test(js.text)
        && /if \(why\.indexOf\(pre \+ '：'\) === 0\) why = why\.slice\(pre\.length \+ 1\)/.test(js.text)
        && /var line = '✕ ' \+ pre \+ '：' \+ why/.test(js.text)
        && /var MAX_SHOW = 500/.test(js.text) && /其余 ' \+ fmtNum\(fails\.length - MAX_SHOW\) \+ ' 条/.test(js.text)
        && /点右上角「复制清单」可拿到全部/.test(js.text));

    check('跳过按原因归类计数（不认识的写法原样保留），并给出示例包名',
      /var groups = \{\}, order = \[\]/.test(js.text) && /p\.reason \|\| '其它原因'/.test(js.text)
        && /跳过（按原因归类，/.test(js.text) && /× ' \+ fmtNum\(names\.length\)/.test(js.text)
        && /例：' \+ sample/.test(js.text));

    check('复制走剪贴板 API，失败时回退到 execCommand，并给出已复制条数提示',
      /navigator\.clipboard\.writeText\(txt\)\.then\(copied, fallback\)/.test(js.text)
        && /document\.execCommand\('copy'\)/.test(js.text)
        && /已复制 ' \+ fmtNum\(lines\.length\) \+ ' 条到剪贴板/.test(js.text));
  }

  console.log('\x1b[1m十之二、页面背景动效铺进弹窗与容器框内部背景\x1b[0m');
  {
    const cssFx = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    const jsFx = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

    const boxRule = /\.fx-box\{[\s\S]*?position\s*:\s*absolute[\s\S]*?inset\s*:\s*0[\s\S]*?z-index\s*:\s*-1[\s\S]*?pointer-events\s*:\s*none[\s\S]*?border-radius\s*:\s*inherit[\s\S]*?overflow\s*:\s*hidden[\s\S]*?\}/.test(cssFx);
    check('样式表有 .fx-box 动效层（绝对定位铺满容器、z-index:-1 垫在内容下面、pointer-events:none 不挡点击、圆角裁剪）',
      boxRule, boxRule ? '' : '缺少 .fx-box 基础规则');

    const layers = /\.fx-box\{[\s\S]*?linear-gradient\(rgba\(38,56,74,\.22\) 1px,transparent 1px\)[\s\S]*?linear-gradient\(90deg,rgba\(38,56,74,\.22\) 1px,transparent 1px\)[\s\S]*?radial-gradient\(620px 340px at 12% -16%,rgba\(46,230,196,\.05\)[\s\S]*?repeating-linear-gradient\(to bottom,rgba\(46,230,196,\.018\)/.test(cssFx);
    const anim = /\.fx-box::before\{[\s\S]*?animation\s*:\s*fx-sweep 9s linear infinite/.test(cssFx)
      && /@keyframes fx-sweep\{from\{transform:translateY\(-160px\)\}\s*to\{transform:translateY\(1200px\)\}\}/.test(cssFx)
      && /will-change\s*:\s*transform/.test(cssFx);
    const grain = /\.fx-box::after\{[\s\S]*?opacity\s*:\s*\.03[\s\S]*?feTurbulence/.test(cssFx);
    const iso = /\.panel,\.stat,\.modal,\.drawer\{isolation\s*:\s*isolate\}/.test(cssFx);
    check('动效层与整页一致：32px 网格 + 双色光晕 + 扫描线 + 噪点，并有 9s 扫过亮带（transform 平移）',
      layers && anim && grain, `${layers ? '' : '背景层缺失 '}${anim ? '' : '扫过动画缺失 '}${grain ? '' : '噪点缺失'}`);
    check('弹窗/面板/统计卡/抽屉建立独立层叠上下文（isolation:isolate，动效层才不会跑到容器背景后面去）', iso);

    const helper = /function decorateFx\(node\)/.test(jsFx)
      && /class: 'fx-box', 'aria-hidden': 'true'/.test(jsFx)
      && /node\.__fxBox/.test(jsFx) && /node\.insertBefore\(node\.__fxBox, node\.firstChild\)/.test(jsFx);
    check('app.js 有 decorateFx()：给容器插一层 .fx-box（防重复插入、aria-hidden）', helper);

    const coverage = /var box = el\('div', \{ class: 'modal '[\s\S]{0,80}decorateFx\(box\)/.test(jsFx)
      && /var panel = el\('div', \{ class: 'drawer' \}[\s\S]{0,1200}decorateFx\(panel\)/.test(jsFx)
      && /return decorateFx\(el\('div', \{ class: 'stat ' \+ \(cls \|\| ''\)/.test(jsFx)
      && /decorateFx\(el\('div', \{ class: 'stat skeleton skel-card' \}\)\)/.test(jsFx)
      && /\$\$\('\.panel,\.stat'\)\.forEach\(decorateFx\)/.test(jsFx);
    check('覆盖到每个弹窗（modal）、抽屉（drawer）、面板（panel）与统计卡（stat，含骨架屏）', coverage,
      coverage ? '' : '有容器类型没铺动效');
  }

  console.log('\x1b[1m十之三、导出「按添加时间」与取消按钮等待期禁用\x1b[0m');
  {
    const htmlAdd = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const jsAdd = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const cssAdd = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    const apiAdd = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.js'), 'utf8');
    const bundleAdd = fs.readFileSync(path.join(__dirname, '..', 'src', 'bundle.js'), 'utf8');
    const cliAdd = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');

    check('导出面板新增「按添加时间」范围与起止时间输入框（自绘日期时间选择器，默认隐藏、空值占位样式）',
      /data-scope="added"[^>]*>按添加时间</.test(htmlAdd)
        && /id="exp-added-row" hidden/.test(htmlAdd)
        && /id="exp-added-from" class="dt-input is-empty" type="text" readonly placeholder="yyyy-mm-dd hh:mm"/.test(htmlAdd)
        && /id="exp-added-to" class="dt-input is-empty" type="text" readonly placeholder="yyyy-mm-dd hh:mm"/.test(htmlAdd));

    check('切换范围时显示/隐藏「按添加时间」行，导出前校验起止时间并换成 ISO 时间戳提交',
      /var arow = \$\('#exp-added-row'\);\s*\n\s*if \(arow\) arow\.hidden = state\.mig\.scope !== 'added';/.test(jsAdd)
        && /function dateTimePicker\(input\)/.test(jsAdd)
        && /input\.classList\.toggle\('is-empty', !v\)/.test(jsAdd)
        && /input\.__dtIso = dtIso\(draft\)/.test(jsAdd)
        && /请至少填写起始或结束时间/.test(jsAdd)
        && /起始时间不能晚于结束时间/.test(jsAdd)
        && /payload\.addedFrom = fms !== null \? new Date\(fms\)\.toISOString\(\) : null/.test(jsAdd)
        && /payload\.addedTo = tms !== null \? new Date\(tms\)\.toISOString\(\) : null/.test(jsAdd));

    check('日期时间输入框与自绘弹层样式对齐项目（只读等宽输入框 + 项目风格月历/自绘时分下拉/底部按钮，深色渐变青色角标）',
      /input\.dt-input\{[\s\S]*?height:34px;padding:0 30px 0 9px;[\s\S]*?font-family:var\(--mono\);font-size:12px;/.test(cssAdd)
        && /input\.dt-input\.is-empty\{color:var\(--txt-faint\)\}/.test(cssAdd)
        && /\.dt-pop\{position:fixed;z-index:8600;width:288px/.test(cssAdd)
        && /\.dt-day\.is-sel\{background:rgba\(46,230,196,\.16\);border-color:var\(--cy\)/.test(cssAdd)
        && /\.dt-sel\{[\s\S]*?width:62px;height:26px;/.test(cssAdd)
        && /\.dt-menu\{[\s\S]*?position:absolute;z-index:8700/.test(cssAdd)
        && /\.dt-opt\.is-sel\{background:rgba\(46,230,196,\.16\)/.test(cssAdd)
        && !/\.dt-menu::-webkit-scrollbar/.test(cssAdd)
        && /\.dt-menu\{[\s\S]*?box-shadow:0 12px 32px/.test(cssAdd)
        && /::-webkit-scrollbar\{width:10px;height:10px\}/.test(cssAdd)
        && !/dt-time select\{/.test(cssAdd)
        && /\.dt-foot\{display:flex;align-items:center;gap:7px/.test(cssAdd)
        && /class: 'modal dt-pop'/.test(jsAdd)
        && /class: 'dt-sel'/.test(jsAdd)
        && /function buildMenu\(kind, label, count\)/.test(jsAdd)
        && /decorateFx\(pop\)/.test(jsAdd));

    check('后端支持 scope=added：按 meta.createdAt 闭区间筛选、manifest 记录 addedTimeRange，参数非法返回 400',
      /else if \(scope === 'added'\) \{/.test(bundleAdd)
        && /pkgAddedInRange\(store\.index\.get\(n\), addedRange\.from, addedRange\.to\)/.test(bundleAdd)
        && /addedTimeRange: addedRange \? \{ from: addedRange\.fromIso, to: addedRange\.toIso \} : null/.test(bundleAdd)
        && /ALLOWED_SCOPE = \['all', 'private', 'upstream', 'selected', 'added'\]/.test(apiAdd)
        && /ctx\.bundle\.normalizeAddedRange\(\{ addedFrom: body\.addedFrom, addedTo: body\.addedTo \}\)/.test(apiAdd)
        && /fail\(res, 400, e\.message, e\.code \|\| 'EBADTIME'\)/.test(apiAdd));

    check('CLI 同步支持 --scope added 与 --from/--to',
      /export \[--scope all\|private\|upstream\|selected\|added\] \[--from 时间\] \[--to 时间\]/.test(cliAdd)
        && /const addedFrom = scope === 'added' \? flags\.from : undefined;/.test(cliAdd)
        && /const addedTo = scope === 'added' \? flags\.to : undefined;/.test(cliAdd));

    check('进度弹窗「取消」等待期禁用置灰（防重复点），成功后保持禁用、失败才恢复可点',
      /function requestTaskCancel\(btn, taskId, opts\)/.test(jsAdd)
        && /if \(!btn \|\| btn\.__canceling\) return;/.test(jsAdd)
        && /btn\.disabled = true;/.test(jsAdd)
        && /btn\.setAttribute\('aria-disabled', 'true'\)/.test(jsAdd)
        && /'正在取消…'/.test(jsAdd)
        && /btn\.disabled = false;/.test(jsAdd)
        && /取消失败：/.test(jsAdd));
    const cancelCalls = (jsAdd.match(/requestTaskCancel\(/g) || []).length;
    check('4 个会起任务进度的弹窗都改用 requestTaskCancel（定义 1 处 + 调用 4 处）',
      cancelCalls >= 5, `出现 ${cancelCalls} 次`);
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
