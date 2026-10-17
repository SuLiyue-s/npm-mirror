/* ============================================================
 * npm 私人镜像源 · 离线控制台
 * app.js — 经典脚本（无 import/export），零依赖，完全离线
 * ============================================================ */
(function () {
  'use strict';

  /* ================= 常量 ================= */
  var API = '/__admin/api';
  var TOKEN_KEY = 'npm-mirror-token';
  var POLL_OVERVIEW = 10000;
  var POLL_LOGS = 5000;
  var PAGES = ['overview', 'packages', 'migrate', 'config', 'logs', 'service'];
  var SOURCE_LABEL = { upstream: '上游', private: '私有', upload: '上传', cache: '缓存' };

  /* ================= 状态 ================= */
  var state = {
    page: 'overview',
    session: null,
    overview: null,
    paused: false,
    timers: {},
    authPrompted: false,
    pkg: { q: '', source: 'all', tarballs: 'all', sort: '-updated', page: 1, size: 20, total: 0, items: [], selected: {}, loading: false },
    mig: { bundles: [], limits: null, scope: 'all', scan: null, scanSel: {}, scanFilter: '', scanPage: 1 },
    cfg: { raw: null, baseline: null, path: '', revealed: false },
    logs: { lines: [], level: '' }
  };

  /* ================= 基础工具 ================= */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag), k, v;
    if (attrs) for (k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      /* 原生 title 弹窗又慢又丑，统一转成 data-tip 由 uiTip 自绘（样式与本项目一致） */
      else if (k === 'title') n.setAttribute('data-tip', v === true ? '' : String(v));
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }
  function setText(id, t) { var n = document.getElementById(id); if (n) n.textContent = t; }
  /* 动态改提示文案：统一写 data-tip，别用原生 title */
  function setTip(n, s) {
    if (!n) return;
    if (s == null || s === '') n.removeAttribute('data-tip');
    else n.setAttribute('data-tip', String(s));
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ================= 自绘悬浮提示（替代浏览器原生 title 弹窗） =================
   * 所有 title 属性（HTML 中的 title="" 和 el() 里的 title:）都改写成 data-tip，
   * 悬停时用本项目风格的浮层显示：深色面板 + 青色左侧强调条 + 等宽字体 + 指向目标的小箭头。 */
  var uiTip = (function () {
    var box = null, cur = null, timer = 0;
    function node() {
      if (!box) {
        box = el('div', { class: 'ui-tip', 'aria-hidden': 'true' });
        document.body.appendChild(box);
      }
      return box;
    }
    function textOf(t) {
      var s = t.getAttribute ? t.getAttribute('data-tip') : null;
      return s == null ? '' : String(s);
    }
    function place(t) {
      var n = node(), r = t.getBoundingClientRect(), b = n.getBoundingClientRect();
      var gap = 9, vw = window.innerWidth, vh = window.innerHeight;
      var x = r.left + r.width / 2 - b.width / 2;
      var y = r.bottom + gap;
      var above = false;
      if (y + b.height > vh - 8 && r.top - gap - b.height >= 8) { y = r.top - gap - b.height; above = true; }
      if (x < 8) x = 8;
      if (x + b.width > vw - 8) x = vw - 8 - b.width;
      if (y < 8) y = 8;
      var ax = Math.max(11, Math.min(b.width - 11, Math.round(r.left + r.width / 2 - x)));
      n.style.left = Math.round(x) + 'px';
      n.style.top = Math.round(y) + 'px';
      n.style.setProperty('--tip-ax', ax + 'px');
      n.classList.toggle('above', above);
    }
    function show(t) {
      var s = textOf(t);
      if (!s) return;
      var n = node();
      n.textContent = s;
      n.classList.remove('on', 'above');
      place(t);
      n.classList.add('on');
      cur = t;
    }
    function hide() {
      clearTimeout(timer);
      cur = null;
      if (box) box.classList.remove('on');
    }
    function schedule(t) {
      clearTimeout(timer);
      cur = t;
      timer = setTimeout(function () { if (cur === t) show(t); }, 130);
    }
    function closestTip(ev) {
      var t = ev.target;
      return t && t.closest ? t.closest('[data-tip]') : null;
    }
    document.addEventListener('mouseover', function (ev) {
      var t = closestTip(ev);
      if (!t || t === cur) return;
      schedule(t);
    });
    document.addEventListener('mouseout', function (ev) {
      var t = closestTip(ev);
      if (!t) return;
      var to = ev.relatedTarget;
      if (to && t.contains(to)) return;
      hide();
    });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('mousedown', hide, true);
    return { hide: hide, show: show };
  })();


  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var s = String(Math.round(Number(n))), out = '', i;
    for (i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ',';
      out += s[i];
    }
    return out;
  }

  function fmtBytes(b) {
    if (b === null || b === undefined || isNaN(b)) return '—';
    var n = Number(b), u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    if (d > 0) return d + '天' + h + '小时' + m + '分';
    if (h > 0) return h + '小时' + m + '分';
    if (m > 0) return m + '分' + s + '秒';
    return s + '秒';
  }

  function dt(v) {
    if (!v) return '—';
    var d = (typeof v === 'number') ? new Date(v) : new Date(String(v));
    if (isNaN(d.getTime())) return String(v);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function dtShort(v) {
    if (!v) return '—';
    var d = (typeof v === 'number') ? new Date(v) : new Date(String(v));
    if (isNaN(d.getTime())) return String(v);
    // 带年份：很久以前发布的版本与最近发布的一眼能分清（表格里靠 CSS 保证不换行）
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function nowStamp() {
    var d = new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  /* ================= 令牌 ================= */
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    paintAuthChip();
  }

  /* ================= HTTP ================= */
  function api(path, opts) {
    opts = opts || {};
    var timeout = opts.timeout || 30000;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
    var headers = {}, token = getToken(), init;

    if (token) headers['X-Mirror-Token'] = token;
    init = { method: opts.method || 'GET', headers: headers, cache: 'no-store' };
    if (ctrl) init.signal = ctrl.signal;
    if (opts.raw !== undefined && opts.raw !== null) init.body = opts.raw;
    else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    if (opts.headers) for (var h in opts.headers) if (Object.prototype.hasOwnProperty.call(opts.headers, h)) headers[h] = opts.headers[h];

    setBusy(true);
    return fetch(API + path, init).then(function (res) {
      return res.text().then(function (txt) {
        var json = null;
        try { json = txt ? JSON.parse(txt) : null; } catch (e) { json = null; }
        if (res.ok && json && json.ok) return json.data;
        var msg = (json && json.error) ? json.error : ('HTTP ' + res.status + ' ' + (res.statusText || ''));
        var err = new Error(msg);
        err.status = res.status;
        err.code = json && json.code;
        throw err;
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') {
        var t = new Error('请求超时（' + Math.round(timeout / 1000) + ' 秒）');
        t.code = 'TIMEOUT';
        throw t;
      }
      if (e instanceof TypeError) {
        var n = new Error('无法连接镜像源服务，请确认服务已启动');
        n.code = 'NETWORK';
        throw n;
      }
      throw e;
    }).then(function (d) { setBusy(false); return d; }, function (e) { setBusy(false); throw e; });
  }

  /* 统一错误处理
   * 401 只在「用户主动操作且还没弹过令牌框」时弹一次；
   * 轮询/静默请求不弹框（否则概览 10s、日志 5s 轮询会不断堆出新的令牌弹窗），
   * 已经弹过时也只保留一条 toast，用户可点右上角「令牌」按钮重新打开。 */
  function handleErr(e, silent) {
    if (!e) return;
    if (e.status === 401) {
      paintAuthChip();
      if (silent) return;
      if (state.authPrompted) { toast('访问令牌无效或已过期，请点右上角「令牌」重新输入', 'err', 6000); return; }
      openTokenModal('服务端要求鉴权：请填写访问令牌');
      return;
    }
    if (!silent) toast(e.message || '操作失败', 'err');
  }

  /* ================= 忙碌指示 ================= */
  var busy = 0;
  function setBusy(on) {
    busy += on ? 1 : -1;
    if (busy < 0) busy = 0;
    var bar = $('#side-load'), wrap = bar && bar.parentNode;
    if (wrap) wrap.classList.toggle('is-busy', busy > 0);
    if (busy === 0) setSideHint('READY');
  }
  function setSideHint(t) { setText('side-hint', t); }
  function btnBusy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset._t = btn.textContent; btn.classList.add('is-busy'); btn.disabled = true; if (label) btn.textContent = label; }
    else { btn.classList.remove('is-busy'); btn.disabled = false; if (btn.dataset._t) { btn.textContent = btn.dataset._t; delete btn.dataset._t; } }
  }

  /**
   * 进度弹窗里的「取消」按钮：点一次后立刻禁用置灰并显示「正在取消…」，
   * 防止用户等任务收尾时反复点击重复发请求；等任务真正结束由
   * taskFinishedButtons() 统一换成【关闭】。
   * 如果取消请求本身失败（网络错误 / 服务异常），恢复按钮文字与可点状态，
   * 让用户能再试一次（任务还在跑，不能把出口堵死）。
   * opts: { waitText, okText, failText, isFinished() }
   */
  function requestTaskCancel(btn, taskId, opts) {
    opts = opts || {};
    if (!btn || btn.__canceling) return;
    btn.__canceling = true;
    btn.__cancelOrig = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-disabled', 'true');
    btn.textContent = opts.waitText || '正在取消…';
    api('/tasks/' + taskId + '/cancel', { method: 'POST' }).then(function () {
      /* 请求已受理：按钮保持禁用，直到任务真正结束（taskFinishedButtons 收尾） */
      toast(opts.okText || '已请求停止：当前包处理完就停', 'warn');
      setSideHint('CANCELING…');
    }, function (e) {
      btn.__canceling = false;
      if (opts.isFinished && opts.isFinished()) return;   // 任务恰好已结束：交给收尾逻辑
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-disabled');
      btn.textContent = btn.__cancelOrig || btn.textContent;
      delete btn.__cancelOrig;
      toast(opts.failText || ('取消失败：' + ((e && e.message) || '请稍后重试')), 'err');
    });
  }

  /* ================= Toast ================= */
  var TOAST_ICON = { ok: '✓', err: '✕', warn: '!', info: 'i' };
  function toast(msg, type, ms) {
    type = type || 'info';
    var box = $('#toasts');
    if (!box) return;
    var t = el('div', { class: 'toast ' + type }, [
      el('span', { class: 'tico', text: TOAST_ICON[type] || 'i' }),
      el('div', { class: 'tmsg', text: String(msg) })
    ]);
    var kill = function () {
      if (!t.parentNode) return;
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
    };
    t.addEventListener('click', kill);
    box.appendChild(t);
    while (box.children.length > 6) box.removeChild(box.firstChild);
    setTimeout(kill, ms || (type === 'err' ? 7000 : 4200));
  }

  /* ================= 背景动效铺进弹窗/容器 =================
   * 整页的动效背景（网格 / 扫描线 / 光晕 / 噪点 / 扫过亮带）同样铺进弹窗、
   * 抽屉、面板与统计卡的内部背景：给容器插一层 .fx-box 即可（样式见
   * style.css 的 2.1 节）。容器由 CSS isolation:isolate 建立层叠上下文，
   * .fx-box 用 z-index:-1 垫在容器背景之上、内容之下——不挡点击、不影响
   * 滚动和布局。重复调用安全（元素上记 __fxBox 防重复插入）。 */
  function decorateFx(node) {
    if (!node || node.nodeType !== 1 || node.__fxBox) return node;
    node.__fxBox = el('div', { class: 'fx-box', 'aria-hidden': 'true' });
    node.insertBefore(node.__fxBox, node.firstChild);
    return node;
  }

  /* ================= 弹窗 ================= */
  function modal(cfg) {
    var root = $('#modal-root');
    var head = el('div', { class: 'modal-head' }, [
      el('div', {}, [
        el('h3', { text: cfg.title || '' }),
        cfg.sub ? el('div', { class: 'sub', text: cfg.sub }) : null
      ]),
      el('button', { class: 'modal-close', type: 'button', title: '关闭', text: '✕', onclick: function () { close(); } })
    ]);
    var body = el('div', { class: 'modal-body' });
    if (cfg.body) body.appendChild(cfg.body);
    var foot = el('div', { class: 'modal-foot' });
    var box = el('div', { class: 'modal ' + (cfg.wide ? 'wide' : '') }, [head, body, foot]);
    decorateFx(box);
    var back = el('div', { class: 'backdrop' }, [box]);
    var closed = false;

    function close() {
      if (closed) return; closed = true;
      if (back.parentNode) back.parentNode.removeChild(back);
      document.removeEventListener('keydown', onKey);
      if (cfg.onClose) cfg.onClose();
    }
    function onKey(ev) { if (ev.key === 'Escape') close(); }

    back.addEventListener('mousedown', function (ev) { if (ev.target === back && !cfg.sticky) close(); });
    document.addEventListener('keydown', onKey);

    (cfg.actions || []).forEach(function (a) {
      foot.appendChild(el('button', {
        class: 'btn ' + (a.kind || ''), type: 'button', text: a.label,
        onclick: function () { if (a.onClick) a.onClick({ close: close, btn: this }); else close(); }
      }));
    });
    if (!cfg.actions || !cfg.actions.length) foot.appendChild(el('button', { class: 'btn', type: 'button', text: '关闭', onclick: close }));

    root.appendChild(back);
    if (cfg.mount) cfg.mount(body, close);
    var first = body.querySelector('input,textarea,select');
    if (first) setTimeout(function () { try { first.focus(); } catch (e) {} }, 30);
    return { close: close, body: body, foot: foot, el: box };
  }

  /**
   * 任务结束后：把「取消下载 / 后台运行」置灰不可点，并显示只负责关闭窗口的【关闭】按钮。
   * 注意不动原有逻辑——全部成功仍然自动关闭，有失败仍然保持打开，【关闭】只是多给一个出口。
   */
  function taskFinishedButtons(m) {
    var btns = m.foot.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].__closeOnly) continue;
      btns[i].disabled = true;
      btns[i].setAttribute('aria-disabled', 'true');
    }
    var c = m.foot.__closeBtn;
    if (c) c.hidden = false;
  }

  /** 在 actions 末尾补一个「下载完成前不显示、只用来关闭弹窗」的按钮，返回 modal 句柄 */
  function taskModal(cfg) {
    var actions = (cfg.actions || []).slice();
    actions.push({ label: '关闭', kind: 'btn-ghost', onClick: function (c) { c.close(); } });
    var m = modal(Object.assign({}, cfg, { actions: actions }));
    var btns = m.foot.querySelectorAll('button');
    var closeBtn = btns[btns.length - 1];
    if (closeBtn) { closeBtn.__closeOnly = true; closeBtn.hidden = true; m.foot.__closeBtn = closeBtn; }
    return m;
  }

  function confirmBox(cfg) {
    return new Promise(function (resolve) {
      var done = false;
      var box = el('div', {}, [
        el('p', { class: cfg.danger ? 'danger-text' : '', text: cfg.message || '确认执行该操作？' }),
        cfg.detail ? el('p', { class: 'muted', text: cfg.detail }) : null
      ]);
      var m = modal({
        title: cfg.title || '确认操作', sub: cfg.sub || 'CONFIRM',
        body: box, sticky: true, onClose: function () { if (!done) { done = true; resolve(false); } },
        actions: [
          { label: '取消', kind: 'btn-ghost', onClick: function () { done = true; m.close(); resolve(false); } },
          {
            label: cfg.confirmText || '确认', kind: cfg.danger ? 'btn-danger' : 'btn-primary',
            onClick: function () { done = true; m.close(); resolve(true); }
          }
        ]
      });
    });
  }

  function openTokenModal(intro) {
    var REVEALED = false;
    var input = el('input', { type: 'password', class: 'mono', placeholder: '粘贴访问令牌', value: getToken(), autocomplete: 'off' });
    var eye = el('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', text: '显示',
      onclick: function () { REVEALED = !REVEALED; input.type = REVEALED ? 'text' : 'password'; eye.textContent = REVEALED ? '隐藏' : '显示'; }
    });
    var body = el('div', {}, [
      el('p', { class: 'muted', text: intro || '本机回环地址默认免鉴权；如需远程访问，请在此填写令牌。' }),
      el('div', { class: 'row-inline' }, [input, eye])
    ]);
    var m = modal({
      title: '访问令牌', sub: 'AUTH TOKEN', body: body, sticky: true,
      actions: [
        {
          label: '清空令牌', kind: 'btn-danger', onClick: function () {
            setToken(''); toast('已清空本地令牌', 'warn'); m.close();
          }
        },
        {
          label: '保存', kind: 'btn-primary', onClick: function () {
            var v = (input.value || '').trim();
            setToken(v);
            if (!v) toast('令牌已清空', 'warn');
            m.close();
            /* 保存了新令牌就重新允许校验失败时弹一次令牌框（清空则保持不再打扰） */
            if (v) state.authPrompted = false;
            loadSession().catch(function () {});
          }
        }
      ]
    });
    state.authPrompted = true;
  }

  /* ================= 复制 ================= */
  function copyText(text, label) {
    text = String(text == null ? '' : text);
    if (!text || text === '—') { toast('没有可复制的内容', 'warn'); return; }
    var done = function () { toast((label || '内容') + '已复制到剪贴板', 'ok'); };
    var fail = function () {
      var ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = text;
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择文本', 'err'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  }

  /* ================= 轮询 ================= */
  function startPoll(key, fn, ms) {
    stopPoll(key);
    state.timers[key] = setInterval(function () { if (!document.hidden) fn(true); }, ms);
  }
  function stopPoll(key) { if (state.timers[key]) { clearInterval(state.timers[key]); delete state.timers[key]; } }
  function stopAllPolls() { Object.keys(state.timers).forEach(stopPoll); }
  function resumePolls() {
    if (state.page === 'overview') { loadOverview(true); startPoll('overview', loadOverview, POLL_OVERVIEW); }
    else if (state.page === 'logs') { loadLogs(true); startPoll('logs', loadLogs, POLL_LOGS); }
  }

  /* ================= 时钟 ================= */
  function startClock() {
    var tick = function () {
      var d = new Date();
      setText('clock', pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()));
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ================= 会话 / 顶栏 ================= */
  function loadSession() {
    return api('/session').then(function (d) {
      state.session = d;
      paintSession(d);
      syncRestartBanner();
      return d;
    }, function (e) {
      if (e && e.status === 401) { paintAuthChip(); if (!state.authPrompted) openTokenModal('服务端要求鉴权：请填写访问令牌'); }
      else { setSideHint('NO SERVICE'); paintAuthChip(); }
      throw e;
    });
  }

  /**
   * 重启横幅的真实判据：把「进程实际监听的 ip:port」和「已保存到配置文件的 ip:port」对比，
   * 不一致才提示重启；重启完成后自动消失（不再依赖一次性的显示开关）。
   */
  function syncRestartBanner() {
    var banner = $('#cfg-restart');
    if (!banner) return;
    var s = state.session, c = state.cfg.raw;
    if (!s || !s.listen || !c || !c.server) { banner.hidden = true; return; }
    var changed = String(s.listen.ip) !== String(c.server.ip) || Number(s.listen.port) !== Number(c.server.port);
    banner.hidden = !changed;
    if (changed) {
      var msg = $('#cfg-restart-msg');
      if (msg) {
        msg.innerHTML = '配置已保存：监听地址将由 <b>' + esc(s.listen.ip) + ':' + esc(String(s.listen.port)) + '</b> 改为 <b>' +
          esc(String(c.server.ip)) + ':' + esc(String(c.server.port)) + '</b>，重启服务后生效。';
      }
    }
  }

  function paintSession(d) {
    var mode = d.mode || (state.overview && state.overview.mode) || '—';
    paintModeChip(mode);
    setText('chip-version', 'v' + (d.version || '—'));
    paintAuthChip();
  }

  function paintModeChip(mode) {
    var n = $('#chip-mode');
    if (!n) return;
    n.classList.remove('is-cy', 'is-am');
    var lamp = n.querySelector('.lamp'), b = n.querySelector('b');
    if (mode === 'offline') { n.classList.add('is-am'); if (lamp) lamp.className = 'lamp lamp-am'; if (b) b.textContent = '纯离线 OFFLINE'; }
    else if (mode === 'cache') { n.classList.add('is-cy'); if (lamp) lamp.className = 'lamp lamp-cy'; if (b) b.textContent = '在线缓存 CACHE'; }
    else { if (b) b.textContent = String(mode); }
  }

  function paintAuthChip() {
    var n = $('#chip-auth'), lamp = n && n.querySelector('.lamp'), txt = $('#chip-auth-text');
    if (!n || !txt) return;
    var s = state.session, has = !!getToken();
    n.classList.remove('is-cy', 'is-am', 'is-red');
    if (!s) { if (lamp) lamp.className = 'lamp lamp-idle'; txt.textContent = has ? '令牌已保存' : '未连接'; return; }
    var req = s.authRequired || {};
    if (s.authenticated) {
      n.classList.add('is-cy');
      if (lamp) lamp.className = 'lamp lamp-grn';
      txt.textContent = has ? '已鉴权（令牌）' : (s.trustLocalhost ? '本机免鉴权' : '已鉴权');
    } else if (req.read || req.publish) {
      n.classList.add('is-red');
      if (lamp) lamp.className = 'lamp lamp-red';
      txt.textContent = '需要令牌';
    } else {
      if (lamp) lamp.className = 'lamp lamp-idle';
      txt.textContent = '开放访问';
    }
  }

  /* ================= 路由 ================= */
  function go(page) {
    if (PAGES.indexOf(page) < 0) page = 'overview';
    state.page = page;
    $$('.nav-item').forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-page') === page); });
    $$('.view').forEach(function (v) { v.classList.toggle('is-on', v.id === 'view-' + page); });
    try { history.replaceState(null, '', '#/' + page); } catch (e) { /* ignore */ }
    stopAllPolls();
    var content = $('#content');
    if (content) content.scrollTop = 0;
    if (page === 'overview') { loadOverview(); startPoll('overview', loadOverview, POLL_OVERVIEW); }
    else if (page === 'packages') loadPackages();
    else if (page === 'migrate') loadBundles();
    else if (page === 'config') loadConfig();
    else if (page === 'logs') { loadLogs(); startPoll('logs', loadLogs, POLL_LOGS); }
    else if (page === 'service') loadService();
  }

  /* ============================================================
   * 1. 概览
   * ============================================================ */
  function loadOverview(silent) {
    if (!silent) setSideHint('LOADING…');
    return api('/overview').then(function (d) {
      state.overview = d;
      paintOverview(d);
      setSideHint('READY');
      setText('ov-updated', '更新于 ' + dtShort(new Date()));
    }, function (e) {
      setSideHint('ERROR');
      handleErr(e, silent);
      if (!silent) {
        var box = $('#ov-stats');
        if (box && !box.children.length) box.appendChild(skeletonCards(4));
      }
      throw e;
    }).catch(function () {});
  }

  function skeletonCards(n) {
    var f = document.createDocumentFragment();
    for (var i = 0; i < n; i++) f.appendChild(decorateFx(el('div', { class: 'stat skeleton skel-card' })));
    return f;
  }

  function statCard(label, en, value, unit, sub, cls) {
    return decorateFx(el('div', { class: 'stat ' + (cls || '') }, [
      el('div', { class: 'stat-label' }, [el('span', { text: label }), el('em', { text: en || '' })]),
      el('div', { class: 'stat-value' }, [String(value), unit ? el('span', { class: 'stat-unit', text: unit }) : null]),
      sub ? el('div', { class: 'stat-sub', text: sub }) : null
    ]));
  }

  function paintOverview(d) {
    var st = d.stats || {}, box = clear($('#ov-stats'));
    if (!box) return;
    box.appendChild(statCard('包数量', 'PACKAGES', fmtNum(st.packages), null, 'packument 数', 'is-cy'));
    box.appendChild(statCard('版本数', 'VERSIONS', fmtNum(st.versions), null, 'tarball ' + fmtNum(st.tarballs) + ' 个'));
    box.appendChild(statCard('存储体积', 'STORAGE', fmtBytes(st.storageBytes), null, 'bundle ' + fmtNum(st.bundles && st.bundles.count) + ' 个 / ' + fmtBytes(st.bundles && st.bundles.bytes), 'is-am'));
    box.appendChild(statCard('累计下载', 'DOWNLOADS', fmtNum(st.downloads), null, '含上游回源计数'));
    box.appendChild(statCard('运行时长', 'UPTIME', fmtDur(d.uptimeSec), null, '启动于 ' + dtShort(d.startedAt), 'is-am'));

    paintModeChip(d.mode);
    setText('chip-uptime', '运行 ' + fmtDur(d.uptimeSec));
    if (d.version) setText('chip-version', 'v' + d.version);

    /* 服务状态 */
    var svc = clear($('#ov-service'));
    if (svc) {
      var listen = d.listen || {};
      [
        ['服务状态', '运行中'],
        ['版本', d.version || '—'],
        ['模式', d.mode === 'offline' ? '纯离线 offline' : (d.mode || '—')],
        ['监听', (listen.ip || '?') + ':' + (listen.port || '?')],
        ['启动时间', dt(d.startedAt)],
        ['运行时长', fmtDur(d.uptimeSec)],
        ['Node', (d.node && (d.node.version + ' / ' + d.node.platform)) || '—'],
        ['配置文件', d.configPath || '—']
      ].forEach(function (kv) { svc.appendChild(kvRow(kv[0], kv[1])); });
    }

    /* 接入地址 */
    var urls = clear($('#ov-urls')), seen = {};
    function addUrl(tag, am, url) {
      if (!url || seen[url]) return;
      seen[url] = 1;
      urls.appendChild(el('div', { class: 'urlrow' }, [
        el('span', { class: 'tag' + (am ? ' am' : ''), text: tag }),
        el('code', { text: url, title: url }),
        el('button', { class: 'btn btn-xs', type: 'button', text: '复制', onclick: function () { copyText(url, '地址'); } })
      ]));
    }
    addUrl('REGISTRY', false, d.registryUrl);
    (d.lanUrls || []).forEach(function (u, i) { addUrl(i === 0 ? 'LAN' : 'LAN+' + i, true, u); });
    if (!urls.children.length) urls.appendChild(el('div', { class: 'muted', text: '未获取到地址信息' }));

    /* 上游 */
    var up = clear($('#ov-upstream'));
    if (up) {
      var u = d.upstream || {};
      up.appendChild(el('div', { class: 'urlrow' }, [
        el('span', { class: 'lamp ' + (u.reachable ? 'lamp-grn' : 'lamp-red') }),
        el('code', { text: u.registry || '未配置', title: u.registry || '' }),
        el('span', { class: 'badge ' + (u.reachable ? 'ok' : 'no'), text: u.reachable ? '可达' : '不可达' })
      ]));
    }

    /* 来源分布 */
    var bars = clear($('#ov-sources')), by = st.bySource || {};
    var keys = ['upstream', 'private', 'upload', 'cache'];
    var maxv = 1;
    keys.forEach(function (k) { maxv = Math.max(maxv, Number(by[k]) || 0); });
    keys.forEach(function (k, i) {
      var v = Number(by[k]) || 0;
      bars.appendChild(el('div', { class: 'bar-row ' + (i === 3 ? 'blu' : (i === 1 || i === 2 ? 'am' : '')) }, [
        el('span', { class: 'nm', text: SOURCE_LABEL[k] }),
        el('span', { class: 'track' }, [el('i', { class: 'fill', style: 'width:' + Math.round(v / maxv * 100) + '%' })]),
        el('span', { class: 'vl', text: fmtNum(v) })
      ]));
    });

    /* 最近日志 */
    var pre = clear($('#ov-logs'));
    if (pre) {
      var recent = (d.recent || []).slice(-8);
      if (!recent.length) pre.appendChild(el('span', { class: 'muted', text: '暂无日志' }));
      else recent.forEach(function (r) {
        var line = (r.time ? '[' + String(r.time) + '] ' : '') + (r.level ? String(r.level).toUpperCase() + ' ' : '') + (r.msg || '');
        pre.appendChild(logLine(line));
      });
    }
  }

  function kvRow(k, v) {
    return el('div', { class: 'kv' }, [el('span', { text: k }), el('span', { text: v == null || v === '' ? '—' : String(v) })]);
  }

  /* ============================================================
   * 2. 包管理
   * ============================================================ */
  function encName(n) { return encodeURIComponent(n); }

  function loadPackages() {
    var p = state.pkg, qs = '?q=' + encodeURIComponent(p.q) + '&source=' + encodeURIComponent(p.source) +
      '&tarballs=' + encodeURIComponent(p.tarballs || 'all') +
      '&sort=' + encodeURIComponent(p.sort) + '&page=' + p.page + '&size=' + p.size;
    setSideHint('LOADING…');
    var tb = $('#pkg-tbody');
    if (tb && !tb.children.length) { clear(tb); for (var i = 0; i < 6; i++) tb.appendChild(el('tr', {}, [el('td', { colspan: '9' }, [el('div', { class: 'skeleton skel-row' })])])); }
    return api('/packages' + qs).then(function (d) {
      p.total = d.total || 0; p.items = d.items || [];
      paintPackages();
      setSideHint('READY');
    }, function (e) { setSideHint('ERROR'); handleErr(e); throw e; }).catch(function () {});
  }

  function paintPackages() {
    var p = state.pkg, tb = clear($('#pkg-tbody'));
    if (!tb) return;
    if (!p.items.length) {
      var plain = !p.q && p.source === 'all';
      var head = '镜像源里还没有包', sub = '点右上角「添加公共包」从上游拉取，或「上传包」导入本地 .tgz';
      if (p.tarballs === 'missing') {
        head = '没有「缺 tarball」的包';
        sub = plain ? '当前镜像里每个包的所有版本都已缓存 tarball，可以放心离线安装' : '换个关键词或清掉其它筛选条件再试';
      } else if (p.tarballs === 'complete') {
        head = '没有 tarball 齐全的包';
        sub = plain ? '每个包都还有版本没缓存 tarball，点「补 tarball」或上面的批量入口先补齐' : '换个关键词或清掉其它筛选条件再试';
      } else if (!plain) {
        head = '没有匹配的包';
        sub = '换个关键词、把来源改成「全部」或取消 tarball 筛选再试';
      }
      tb.appendChild(el('tr', {}, [el('td', { colspan: '9', class: 'empty' }, [
        el('b', { text: head }),
        el('span', { text: sub })
      ])]));
    } else {
      p.items.forEach(function (it) {
        var name = it.name || '';
        var sel = !!p.selected[name];
        var tr = el('tr', { class: sel ? 'is-selected' : '' }, [
          el('td', { class: 'col-chk' }, [el('input', { type: 'checkbox', 'data-name': name, checked: sel || null })]),
          el('td', {}, [
            el('div', { class: 'pkg-name' }, [nameParts(name)]),
            it.description ? el('div', { class: 'pkg-desc', text: it.description, title: it.description }) : null,
            it.deprecated ? el('span', { class: 'badge dep', text: '已废弃' }) : null,
            it.hasAllTarballs === false ? el('span', { class: 'badge no', text: '缺 tarball' }) : null
          ]),
          el('td', { class: 'col-ver', text: it.latest || '—' }),
          el('td', { class: 'num col-vers', title: '已存 ' + fmtNum(it.cachedVersions) + ' 个版本的 tarball / 共 ' + fmtNum(it.versionCount) + ' 个版本' }, [
            el('span', { class: 'ver-cached' + (it.hasAllTarballs === false ? ' is-partial' : ''), text: fmtNum(it.cachedVersions) }),
            el('span', { class: 'ver-total', text: ' / ' + fmtNum(it.versionCount) })
          ]),
          el('td', { class: 'num', text: fmtBytes(it.sizeBytes) }),
          el('td', { class: 'num', text: fmtNum(it.downloads) }),
          el('td', {}, [el('span', { class: 'badge ' + (it.source || ''), text: SOURCE_LABEL[it.source] || it.source || '—' })]),
          el('td', { class: 'mono col-time', text: dtShort(it.updatedAt) }),
          el('td', { class: 'col-ops' }, [el('div', { class: 'ops' }, [
            el('button', { class: 'btn btn-xs', type: 'button', text: '详情', 'data-act': 'detail', 'data-name': name }),
            el('button', { class: 'btn btn-xs btn-amber', type: 'button', text: '废弃', 'data-act': 'deprecate', 'data-name': name }),
            el('button', { class: 'btn btn-xs btn-danger', type: 'button', text: '删除', 'data-act': 'del', 'data-name': name })
          ])])
        ]);
        tb.appendChild(tr);
      });
    }
    var chk = $('#pkg-chk-all');
    if (chk) {
      var allSel = p.items.length > 0 && p.items.every(function (i) { return p.selected[i.name]; });
      chk.checked = allSel; chk.indeterminate = !allSel && p.items.some(function (i) { return p.selected[i.name]; });
    }
    /* 「缺 tarball / 不缺 tarball」快捷筛选：按钮高亮跟随当前筛选（再点一次同一个按钮回到全部） */
    var tbBar = $('#pkg-tb');
    if (tbBar) {
      $$('[data-tb]', tbBar).forEach(function (b) {
        b.classList.toggle('is-on', b.getAttribute('data-tb') === p.tarballs);
      });
    }
    paintPager();
    paintSelbar();
  }

  function nameParts(name) {
    var i = name.indexOf('/');
    if (name.charAt(0) === '@' && i > 0) return el('span', {}, [el('span', { class: 'scope', text: name.slice(0, i) }), name.slice(i)]);
    return el('span', {}, [name]);
  }

  function paintPager() {
    var p = state.pkg, box = clear($('#pkg-pager'));
    if (!box) return;
    var pages = Math.max(1, Math.ceil(p.total / p.size));
    if (p.page > pages) {
      /* 删除/筛选后总页数变少：把页码夹到最后一页并重新拉取。
       * 只改页码不重新请求会拿到越界页的空列表，界面误显示「还没有包」。 */
      p.page = pages;
      setTimeout(loadPackages, 0);
    }
    box.appendChild(el('button', { class: 'pg', type: 'button', text: '‹ 上一页', disabled: p.page <= 1 || null, onclick: function () { p.page--; loadPackages(); } }));
    var list = [], i;
    for (i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - p.page) <= 2) list.push(i);
    var last = 0;
    list.forEach(function (i) {
      if (last && i - last > 1) box.appendChild(el('span', { class: 'sp', text: '…' }));
      box.appendChild(el('button', {
        class: 'pg' + (i === p.page ? ' is-on' : ''), type: 'button', text: String(i),
        onclick: function () { p.page = i; loadPackages(); }
      }));
      last = i;
    });
    box.appendChild(el('button', { class: 'pg', type: 'button', text: '下一页 ›', disabled: p.page >= pages || null, onclick: function () { p.page++; loadPackages(); } }));
    box.appendChild(el('span', { class: 'sp', text: '共 ' + fmtNum(p.total) + ' 个包 · 第 ' + p.page + '/' + pages + ' 页' }));
  }

  function selectedNames() { return Object.keys(state.pkg.selected).filter(function (k) { return state.pkg.selected[k]; }); }

  function paintSelbar() {
    var names = selectedNames(), bar = $('#pkg-selbar');
    if (!bar) return;
    bar.hidden = names.length === 0;
    setText('pkg-selnum', String(names.length));
    var hint = $('#pkg-miss-hint');
    if (hint) {
      var miss = 0, seen = 0, partial = false;
      state.pkg.items.forEach(function (it) {
        if (!state.pkg.selected[it.name]) return;
        seen++;
        var m = Number(it.missingVersions || 0);
        miss += m;
      });
      if (seen < names.length) partial = true;
      if (miss > 0) hint.textContent = '（勾选项缺 ' + fmtNum(miss) + ' 个版本的 tarball' + (partial ? '，仅统计本页' : '') + '）';
      else hint.textContent = seen ? '（本页勾选项 tarball 已齐全）' : '';
    }
    var info = $('#exp-selected-info');
    if (info) info.textContent = names.length ? ('已勾选 ' + names.length + ' 个包：' + names.slice(0, 4).join('、') + (names.length > 4 ? ' …' : '')) : '尚未在「包管理」页勾选任何包';
  }

  function toggleSelect(name, on) {
    if (on) state.pkg.selected[name] = true; else delete state.pkg.selected[name];
    paintSelbar();
    var tr = $('#pkg-tbody input[data-name="' + (window.CSS && CSS.escape ? CSS.escape(name) : name.replace(/"/g, '\\"')) + '"]');
    if (tr && tr.closest) { var row = tr.closest('tr'); if (row) row.classList.toggle('is-selected', !!on); }
  }

  function delPackage(name) {
    confirmBox({
      title: '删除整包', danger: true, confirmText: '删除',
      message: '确定要从镜像源中删除「' + name + '」的全部版本？',
      detail: '该操作会移除本地存储的 packument 与 tarball，且不可撤销。'
    }).then(function (ok) {
      if (!ok) return;
      setSideHint('DELETING…');
      return api('/packages/' + encName(name), { method: 'DELETE' }).then(function (d) {
        toast('已删除 ' + name + '（' + fmtNum(d.removedVersions) + ' 个版本）', 'ok');
        delete state.pkg.selected[name];
        loadPackages();
      }, function (e) { handleErr(e); });
    });
  }

  function delVersion(name, version) {
    confirmBox({
      title: '删除版本', danger: true, confirmText: '删除',
      message: '确定删除 ' + name + '@' + version + ' ？'
    }).then(function (ok) {
      if (!ok) return;
      return api('/packages/' + encName(name) + '/' + encodeURIComponent(version), { method: 'DELETE' }).then(function () {
        toast('已删除 ' + name + '@' + version, 'ok');
        openDetail(name);
      }, function (e) { handleErr(e); });
    });
  }

  function deprecateModal(name, presetVersion) {
    var ver = el('input', { type: 'text', class: 'mono', placeholder: '留空 = 仅 latest', value: presetVersion || '' });
    var msg = el('input', { type: 'text', placeholder: '例如：该版本存在安全问题，请升级', value: '' });
    var body = el('div', {}, [
      el('p', { class: 'muted', text: '对 ' + name + ' 打废弃标记（npm deprecate）。消息留空并指定版本可取消废弃；版本留空只处理 dist-tags.latest 指向的版本。' }),
      el('div', { class: 'field' }, [el('label', { text: '版本' }), ver]),
      el('div', { class: 'field', style: 'margin-top:9px' }, [el('label', { text: '废弃消息' }), msg])
    ]);
    var m = modal({
      title: '废弃标记', sub: 'DEPRECATE', body: body,
      actions: [
        { label: '取消', kind: 'btn-ghost' },
        {
          label: '提交', kind: 'btn-amber', onClick: function (ctx) {
            var payload = { version: ver.value.trim() || null, message: msg.value.trim() || null };
            btnBusy(ctx.btn, true, '提交中');
            api('/packages/' + encName(name) + '/deprecate', { method: 'POST', body: payload }).then(function (d) {
              toast('已更新废弃标记：' + name + (d.version ? '@' + d.version : ''), 'ok');
              m.close(); loadPackages();
              if ($('#drawer-root').children.length) openDetail(name);
            }, function (e) { btnBusy(ctx.btn, false); handleErr(e); });
          }
        }
      ]
    });
  }

  /* ---------- 详情抽屉 ---------- */
  function closeDrawer() { clear($('#drawer-root')); }

  function openDetail(name) {
    var root = clear($('#drawer-root'));
    var back = el('div', { class: 'drawer-backdrop', onclick: closeDrawer });
    var panel = el('div', { class: 'drawer' }, [
      el('div', { class: 'drawer-head' }, [
        el('div', { class: 't' }, [el('h3', { text: name }), el('div', { class: 'sub', text: 'PACKAGE DETAIL' })]),
        el('button', { class: 'modal-close', type: 'button', text: '✕', onclick: closeDrawer })
      ]),
      el('div', { class: 'drawer-body' }, [el('div', { class: 'center-box', text: '读取中…' })])
    ]);
    decorateFx(panel);
    root.appendChild(back); root.appendChild(panel);

    api('/packages/' + encName(name)).then(function (d) {
      paintDetail(panel.querySelector('.drawer-body'), d);
    }, function (e) {
      var b = panel.querySelector('.drawer-body');
      clear(b);
      b.appendChild(el('div', { class: 'center-box', text: '加载失败：' + (e.message || '未知错误') }));
      handleErr(e, true);
    });
  }

  function paintDetail(body, d) {
    clear(body);
    var versions = d.versions || [];
    var missing = versions.filter(function (v) { return !v.cached; }).map(function (v) { return v.version; });

    /* 概要 */
    body.appendChild(el('div', { class: 'drawer-section' }, [
      el('h4', { text: '概要 / SUMMARY' }),
      el('div', { class: 'chips' }, [
        el('span', { class: 'chip-s' }, ['最新 ', el('b', { text: d.latest || '—' })]),
        el('span', { class: 'chip-s' }, ['来源 ', el('b', { text: SOURCE_LABEL[d.source] || d.source || '—' })]),
        el('span', { class: 'chip-s' }, ['版本 ', el('b', { text: String(versions.length) })]),
        el('span', { class: 'chip-s' }, ['下载 ', el('b', { text: fmtNum(d.downloads) })]),
        /* 两套时间分开显示：上游元数据时间（版本发布的真实时间线）与本地收录/更新时间。
           上游时间是完整元数据才有的（time.created / time.modified），取不到就显示 —，绝不拿本地时间冒充。 */
        el('span', { class: 'chip-s', title: '上游元数据里的包创建时间（time.created），拉过完整元数据才有' },
          ['上游创建 ', el('b', { text: d.upstreamCreated ? dtShort(d.upstreamCreated) : '—' })]),
        el('span', { class: 'chip-s', title: '上游元数据里的最后修改时间（time.modified）' },
          ['上游更新 ', el('b', { text: d.upstreamModified ? dtShort(d.upstreamModified) : '—' })]),
        el('span', { class: 'chip-s', title: '本镜像首次收录这个包的时间（与上游发布时间无关）' },
          ['本地收录 ', el('b', { text: dtShort(d.createdAt) })]),
        el('span', { class: 'chip-s', title: '本镜像最近一次更新这个包元数据的本地时间' },
          ['本地更新 ', el('b', { text: dtShort(d.lastFetchAt || d.updatedAt) })])
      ]),
      d.description ? el('p', { class: 'muted', style: 'margin-top:9px', text: d.description }) : null
    ]));

    /* dist-tags */
    var tags = d.distTags || {};
    var tagKeys = Object.keys(tags);
    if (tagKeys.length) {
      body.appendChild(el('div', { class: 'drawer-section' }, [
        el('h4', { text: 'DIST-TAGS' }),
        el('div', { class: 'chips' }, tagKeys.map(function (k) {
          return el('span', { class: 'chip-s' }, [k + ' → ', el('b', { text: String(tags[k]) })]);
        }))
      ]));
    }

    /* 版本表：筛选 / 关键字 / 勾选 / 分页（勾选状态跨页跨筛选保留） */
    body.appendChild(paintVersions(d, versions));

    /* 依赖 / engines（取最新版本） */
    var latest = null, i;
    for (i = 0; i < versions.length; i++) if (versions[i].version === d.latest) latest = versions[i];
    if (!latest && versions.length) latest = versions[versions.length - 1];
    if (latest) {
      var deps = latest.dependencies || {}, dk = Object.keys(deps);
      var eng = latest.engines || {}, ek = Object.keys(eng);
      body.appendChild(el('div', { class: 'drawer-section' }, [
        el('h4', { text: '最新版本 ' + latest.version + ' / DEPS & ENGINES' }),
        dk.length ? el('table', { class: 'dep-table' }, [el('tbody', {}, dk.map(function (k) {
          return el('tr', {}, [el('td', { text: k }), el('td', { text: String(deps[k]) })]);
        }))]) : el('div', { class: 'muted', text: '无依赖' }),
        ek.length ? el('div', { class: 'chips', style: 'margin-top:8px' }, ek.map(function (k) {
          return el('span', { class: 'chip-s' }, [k + ' ', el('b', { text: String(eng[k]) })]);
        })) : null,
        latest.integrity ? el('p', { class: 'muted mono', style: 'margin-top:9px;word-break:break-all', text: 'integrity: ' + latest.integrity }) : null,
        latest.tarballUrl ? el('p', { class: 'muted mono', style: 'word-break:break-all', text: 'tarball: ' + latest.tarballUrl }) : null
      ]));
    }

    /* 抽屉底部操作 */
    body.appendChild(el('div', { class: 'drawer-section' }, [
      el('h4', { text: '包级操作 / ACTIONS' }),
      el('div', { class: 'row-inline' }, [
        el('button', { class: 'btn btn-sm btn-amber', type: 'button', text: '废弃标记', onclick: function () { deprecateModal(d.name, null); } }),
        el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '删除整包', onclick: function () { closeDrawer(); delPackage(d.name); } }),
        el('button', {
          class: 'btn btn-sm btn-ghost', type: 'button', text: '刷新元数据',
          title: '回上游重新拉取该包的完整元数据（含每个版本的真实发布时间）',
          onclick: function (ev) {
            var b = ev.currentTarget, old = b.textContent;
            b.disabled = true; b.textContent = '刷新中…';
            api('/packages/' + encodeURIComponent(d.name) + '/refresh', { method: 'POST', timeout: 300000 })
              .then(function (r) {
                b.disabled = false; b.textContent = old;
                toast('已刷新 ' + d.name + '（' + fmtNum(r.versions) + ' 个版本，发布时间 ' + fmtNum(r.publishTimeCount) + ' 条）', 'ok', 2800);
                openDetail(d.name);
              })
              .catch(function (e) {
                b.disabled = false; b.textContent = old;
                toast((e && e.message) || '刷新元数据失败', 'err', 3200);
              });
          }
        })
      ])
    ]));
  }

  /* 版本单元格：源 tarball / 解包后 / 文件数（后两项为 0 或缺省时省略） */
  function verSizeTitle(v) {
    var parts = ['源 tarball ' + (fmtBytes(v.sourceSizeBytes) || '—')];
    if (v.unpackedSizeBytes) parts.push('解包后 ' + fmtBytes(v.unpackedSizeBytes));
    if (v.fileCount) parts.push('文件数 ' + fmtNum(v.fileCount));
    return parts.join('；');
  }

  function verDistTagMissing(d, versions) {
    var tags = d.distTags || {}, cached = {}, ver = {}, i, out = [];
    for (i = 0; i < versions.length; i++) { cached[versions[i].version] = !!versions[i].cached; ver[versions[i].version] = true; }
    for (var k in tags) {
      if (!Object.prototype.hasOwnProperty.call(tags, k)) continue;
      var tv = tags[k];
      if (!ver[tv] || cached[tv] || out.indexOf(tv) >= 0) continue;
      out.push(tv);
    }
    return out;
  }

  /* 版本区：工具栏（筛选/关键字/勾选/补 tarball）+ 分页表格 */
  function paintVersions(d, versions) {
    var section = el('div', { class: 'drawer-section' });
    var filter = 'all', keyword = '', page = 1, pageSize = 50, pageData = [];
    var pick = {};                                        // 勾选的版本号（Set 语义，跨页跨筛选保留）
    var missing = versions.filter(function (v) { return !v.cached; }).map(function (v) { return v.version; });

    function pickKeys() {
      return Object.keys(pick).filter(function (k) { return pick[k]; });
    }
    function available() {
      var kw = keyword.toLowerCase();
      return versions.filter(function (v) {
        if (filter === 'uncached' && v.cached) return false;
        if (filter === 'cached' && !v.cached) return false;
        if (kw && String(v.version).toLowerCase().indexOf(kw) < 0) return false;
        return true;
      });
    }
    function pickItems() {
      var by = {};
      versions.forEach(function (v) { by[v.version] = v; });
      return pickKeys().map(function (k) { return { name: d.name, version: k, cached: !!(by[k] && by[k].cached) }; })
        .filter(function (t) { return by[t.version]; });
    }

    /* 工具栏 */
    var segNums = { all: versions.length, uncached: 0, cached: 0 };
    versions.forEach(function (v) { if (v.cached) segNums.cached++; else segNums.uncached++; });
    var rangeInfo = el('span', { class: 'muted' });
    var tools = el('div', { class: 'fill-tools' });

    var search = el('input', {
      class: 'fill-kw', type: 'search', placeholder: '版本号关键字…', autocomplete: 'off', title: '按版本号包含匹配（忽略大小写）'
    });

    var segbox = el('div', { class: 'segbar' });
    var seg = el('button', {
      class: 'seg', type: 'button', text: '全部',
      title: '全部版本 ' + fmtNum(versions.length) + ' 个（含已下载 / 未下载）',
      onclick: function () { if (filter === 'all') return; filter = 'all'; page = 1; go(); }
    });
    var segMiss = el('button', {
      class: 'seg', type: 'button', text: '未下载',
      title: '只看本地未下载的版本（' + fmtNum(segNums.uncached) + ' 个）',
      onclick: function () { if (filter === 'uncached') return; filter = 'uncached'; page = 1; go(); }
    });
    var segHas = el('button', {
      class: 'seg', type: 'button', text: '已下载',
      title: '只看本地已下载的版本（' + fmtNum(segNums.cached) + ' 个）',
      onclick: function () { if (filter === 'cached') return; filter = 'cached'; page = 1; go(); }
    });
    [seg, segMiss, segHas].forEach(function (b) { segbox.appendChild(b); });

    var btnAll = el('button', {
      class: 'btn btn-xs', type: 'button', text: '全选当前筛选结果',
      onclick: function () { available().forEach(function (v) { pick[v.version] = true; }); updateBar(); render(); }
    });
    var btnNone = el('button', {
      class: 'btn btn-xs btn-ghost', type: 'button', text: '取消全选',
      onclick: function () { for (var k in pick) if (pick[k]) delete pick[k]; updateBar(); render(); }
    });

    var btnSel = el('button', {
      class: 'btn btn-xs btn-amber', type: 'button', text: '补选中 0 个',
      onclick: function () {
        var items = pickItems();
        if (!items.length) { toast('请先勾选要补的版本', 'warn'); return; }
        runFill([d.name], 'selected', items);
      }
    });
    var btnTags = el('button', {
      class: 'btn btn-xs', type: 'button', text: '补 dist-tag 版本',
      onclick: function () { runFill([d.name], 'tags'); }
    });
    var latestVer = String(d.latest || '');
    var latestRec = (versions || []).filter(function (v) { return v.version === latestVer; })[0];
    var latestCached = !!(latestRec && latestRec.cached);
    var btnLatest = el('button', {
      class: 'btn btn-xs', type: 'button',
      text: '补最新版本' + (latestVer ? '（' + latestVer + '）' : ''),
      title: latestVer
        ? (latestCached ? 'latest = ' + latestVer + '，本地已缓存（点击只做一次校验）' : '只下载 latest 指向的版本 ' + latestVer)
        : '只下载 latest 指向的版本',
      onclick: function () { runFill([d.name], 'latest'); }
    });

    tools.appendChild(segbox);
    tools.appendChild(search);
    tools.appendChild(el('span', { class: 'fill-sp' }));
    tools.appendChild(btnAll);
    tools.appendChild(btnNone);
    tools.appendChild(btnSel);
    tools.appendChild(btnTags);
    tools.appendChild(btnLatest);
    tools.appendChild(rangeInfo);

    /* 表格 */
    var tb = el('tbody');
    var table = el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { class: 'col-chk' }),
        el('th', { text: '版本' }),
        el('th', { class: 'num' }, ['本地体积', el('small', { text: '已下载' })]),
        el('th', { class: 'num' }, ['源体积', el('small', { text: '源服务器' })]),
        el('th', { class: 'num', text: '下载' }),
        el('th', { class: 'col-time', title: '上游原始发布时间（来自完整元数据的 time 字段）；显示 — 表示上游元数据里没有这个版本的时间', text: '发布时间' }),
        el('th', { text: '缓存' }),
        el('th', { text: '废弃' }),
        el('th', { class: 'col-ops', text: '操作' })
      ])]),
      tb
    ]);
    var note2 = el('div', { class: 'fill-note' });

    /* 分页 */
    var pageInfo = el('span', { class: 'sp' });
    var btnPrev = el('button', {
      class: 'pg', type: 'button', text: '‹ 上一页',
      onclick: function () { if (page <= 1) return; page--; go(); }
    });
    var btnNext = el('button', {
      class: 'pg', type: 'button', text: '下一页 ›',
      onclick: function () { page++; go(); }
    });
    var sizeSel = el('select', {
      class: 'mini-sel', title: '每页条数',
      onchange: function () { pageSize = Number(sizeSel.value) || 50; page = 1; go(); }
    });
    [50, 100, 200].forEach(function (n) {
      sizeSel.appendChild(el('option', { value: String(n), text: n + ' 条/页' }));
    });
    sizeSel.value = String(pageSize);
    var numBox = el('span', { class: 'pg-nums' });   // 页码按钮容器（与包列表 paintPager 同款外观）
    var pager = el('div', { class: 'pager' }, [
      sizeSel, btnPrev, numBox, btnNext, pageInfo
    ]);

    section.appendChild(el('h4', {}, [
      el('span', { text: '版本列表 / VERSIONS（' + versions.length + '）' }),
      missing.length ? el('button', {
        class: 'btn btn-xs btn-amber', type: 'button', text: '补全部缺失 ' + missing.length + ' 个',
        title: '按「全部版本」补 tarball：走后台任务并显示进度',
        onclick: function () { runFill([d.name], 'all'); }
      }) : null
    ]));
    section.appendChild(tools);
    section.appendChild(el('div', { class: 'table-wrap' }, [table]));
    section.appendChild(note2);
    section.appendChild(pager);

    function go() { clampPage(); render(); }

    /* 页码按钮：1 / 末页 / 当前页 ±2，中间用 … 省略（与包列表分页一致） */
    function paintNums(pages) {
      clear(numBox);
      if (pages <= 1) return;
      var list = [], i, last = 0;
      for (i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - page) <= 2) list.push(i);
      list.forEach(function (i) {
        if (last && i - last > 1) numBox.appendChild(el('span', { class: 'sp', text: '…' }));
        numBox.appendChild(el('button', {
          class: 'pg' + (i === page ? ' is-on' : ''), type: 'button', text: String(i),
          onclick: function () { if (i === page) return; page = i; go(); }
        }));
        last = i;
      });
    }

    function clampPage() {
      var total = available().length;
      var pages = Math.max(1, Math.ceil(total / pageSize));
      if (page > pages) page = pages;
      if (page < 1) page = 1;
    }

    /* 勾选统计 + 按钮文案 */
    function updateBar() {
      var items = pickItems();
      var inFilter = 0, already = 0;
      available().forEach(function (v) { if (pick[v.version]) inFilter++; });
      versions.forEach(function (v) { if (pick[v.version] && v.cached) already++; });
      btnSel.textContent = '补选中 ' + items.length + ' 个';
      btnSel.disabled = items.length ? null : true;
      setTip(btnSel, already
        ? ('其中已缓存 ' + already + ' 个会被跳过；服务端只统计本地缺失的版本')
        : '按勾选的版本补 tarball（后台任务 + 进度）');
      var filt = available().length;
      btnAll.disabled = (filt && inFilter < filt) ? null : true;
      btnNone.disabled = items.length ? null : true;
      rangeInfo.textContent = items.length
        ? ('已选 ' + items.length + ' 个' + (inFilter < items.length ? '（当前筛选页内有 ' + inFilter + ' 个）' : ''))
        : '未勾选';
    }

    /* 行渲染：只渲染当前页切片，不一次性渲染全部版本 */
    function rowFor(v) {
      var tr = el('tr', { class: pick[v.version] ? 'is-selected' : null });
      var chk = el('input', {
        type: 'checkbox', title: '勾选 ' + v.version,
        checked: pick[v.version] ? true : null,
        onchange: function () {
          if (chk.checked) pick[v.version] = true; else delete pick[v.version];
          tr.classList.toggle('is-selected', !!chk.checked);
          updateBar();
        }
      });
      tr.appendChild(el('td', { class: 'col-chk' }, [chk]));
      tr.appendChild(el('td', { class: 'mono col-ver', text: v.version }));
      tr.appendChild(el('td', { class: 'num' }, [
        v.cached ? el('span', { text: fmtBytes(v.sizeBytes) }) : el('span', { class: 'muted', text: '—' })
      ]));
      tr.appendChild(el('td', { class: 'num', title: verSizeTitle(v) }, [
        v.sourceSizeBytes ? el('span', { text: fmtBytes(v.sourceSizeBytes) }) : el('span', { class: 'muted', text: '—' })
      ]));
      tr.appendChild(el('td', { class: 'num', text: fmtNum(v.downloads) }));
      /* 真实发布时间：上游没给就是 —，不能用本地收录时间兜底（否则所有老版本看着都像今天发布的） */
      tr.appendChild(el('td', {
        class: 'mono col-time',
        title: v.publishedAt ? '上游元数据里的发布时间' : '上游元数据里没有这个版本的发布时间（点【刷新元数据】用完整元数据补齐）',
        text: v.publishedAt ? dtShort(v.publishedAt) : '—'
      }));
      tr.appendChild(el('td', {}, [el('span', { class: 'badge ' + (v.cached ? 'ok' : 'no'), text: v.cached ? '已缓存' : '未缓存' })]));
      tr.appendChild(el('td', {}, [v.deprecated
        ? el('span', { class: 'badge dep', text: '已废弃', title: String(v.deprecated) })
        : el('span', { class: 'badge dim', text: '—' })]));
      tr.appendChild(el('td', { class: 'col-ops' }, [el('div', { class: 'ops' }, [
        !v.cached ? el('button', {
          class: 'btn btn-xs', type: 'button', text: '预缓存',
          onclick: function () { prefetchVersions(d.name, [v.version]); }
        }) : null,
        el('button', {
          class: 'btn btn-xs btn-amber', type: 'button', text: '废弃',
          onclick: function () { deprecateModal(d.name, v.version); }
        }),
        el('button', {
          class: 'btn btn-xs btn-danger', type: 'button', text: '删除',
          onclick: function () { delVersion(d.name, v.version); }
        })
      ])]));
      return tr;
    }

    function render() {
      var list = available();
      var total = list.length;
      var pages = Math.max(1, Math.ceil(total / pageSize));
      if (page > pages) page = pages;
      if (page < 1) page = 1;
      var start = (page - 1) * pageSize;
      pageData = list.slice(start, start + pageSize);

      clear(tb);
      if (!pageData.length) {
        tb.appendChild(el('tr', {}, [
          el('td', { class: 'empty', colspan: '9' }, [
            el('b', { text: '没有匹配的版本' }),
            el('span', { text: keyword || filter !== 'all' ? '试试清空关键字或切换筛选条件' : '该包暂无版本' })
          ])
        ]));
      } else {
        pageData.forEach(function (v) { tb.appendChild(rowFor(v)); });
      }

      seg.className = 'seg' + (filter === 'all' ? ' is-on' : '');
      segMiss.className = 'seg' + (filter === 'uncached' ? ' is-on' : '');
      segHas.className = 'seg' + (filter === 'cached' ? ' is-on' : '');

      btnPrev.disabled = (page <= 1) ? true : null;
      btnNext.disabled = (page >= pages) ? true : null;
      paintNums(pages);
      if (total) {
        pageInfo.textContent = '共 ' + fmtNum(total) + ' 条（全 ' + fmtNum(versions.length) + ' 个版本）· 第 ' + page + ' / ' + pages + ' 页'
          + ' · 本页 ' + (start + 1) + '–' + (start + pageData.length) + ' 条';
      } else {
        pageInfo.textContent = '共 0 条（全 ' + fmtNum(versions.length) + ' 个版本）';
      }
      note2.textContent = '筛选中：未下载 ' + fmtNum(segNums.uncached) + ' 个 / 已下载 ' + fmtNum(segNums.cached) + ' 个'
        + (filter !== 'all' || keyword ? (' · 当前命中 ' + fmtNum(total) + ' 个') : '');
      updateBar();
    }

    search.addEventListener('input', function () { keyword = search.value.trim(); page = 1; render(); });

    render();
    return section;
  }

  function prefetchVersions(name, versions) {
    if (!versions || !versions.length) { toast('没有需要预缓存的版本', 'warn'); return Promise.resolve(); }
    setSideHint('PREFETCH…');
    toast('开始预缓存 ' + versions.length + ' 个版本…', 'info');
    return api('/packages/' + encName(name) + '/prefetch', { method: 'POST', body: { versions: versions }, timeout: 180000 })
      .then(function (d) {
        var ok = (d.downloaded || []).length, bad = (d.failed || []).length;
        toast('预缓存完成：成功 ' + ok + ' 个' + (bad ? '，失败 ' + bad + ' 个' : ''), bad ? 'warn' : 'ok');
        if (bad) (d.failed || []).forEach(function (f) { toast('· ' + f.version + '：' + (f.error || '失败'), 'err', 6000); });
        setSideHint('READY');
        loadPackages();
        if ($('#drawer-root').children.length) openDetail(name);
      }, function (e) { setSideHint('ERROR'); handleErr(e); });
  }

  /* ---------- 批量操作 ---------- */
  function batchDelete() {
    var names = selectedNames();
    if (!names.length) return;
    confirmBox({
      title: '批量删除', danger: true, confirmText: '删除 ' + names.length + ' 个包',
      message: '确定删除选中的 ' + names.length + ' 个包及其全部版本？',
      detail: names.slice(0, 12).join('、') + (names.length > 12 ? ' …' : '')
    }).then(function (ok) {
      if (!ok) return;
      var rows = [], list = el('div', { class: 'tasklist' });
      var bar = el('i', { style: 'width:0' });
      var body = el('div', {}, [el('p', { class: 'muted', text: '正在逐个删除，请勿关闭窗口…' }), list, el('div', { class: 'progressbar' }, [bar])]);
      names.forEach(function (n) { var r = el('div', { class: 'taskrow pending' }, [el('span', { text: n }), el('span', { class: 'tv', text: '等待' })]); rows.push(r); list.appendChild(r); });
      var m = modal({ title: '批量删除', sub: 'BATCH DELETE', body: body, sticky: true, actions: [] });
      var i = 0, okCount = 0, failCount = 0;

      function step() {
        if (i >= names.length) {
          bar.style.width = '100%';
          toast('批量删除完成：成功 ' + okCount + '，失败 ' + failCount, failCount ? 'warn' : 'ok');
          list.appendChild(el('div', { class: 'taskrow ok' }, [el('span', { text: '全部完成' })]));
          setTimeout(function () { m.close(); loadPackages(); }, 900);
          return;
        }
        var n = names[i], row = rows[i];
        row.className = 'taskrow busy'; row.lastChild.textContent = '删除中…';
        api('/packages/' + encName(n), { method: 'DELETE' }).then(function (d) {
          okCount++; row.className = 'taskrow ok'; row.lastChild.textContent = '✓ ' + fmtNum(d && d.removedVersions) + ' 版本';
          delete state.pkg.selected[n];
        }, function (e) {
          failCount++; row.className = 'taskrow err'; row.lastChild.textContent = '✕ ' + (e.message || '失败');
        }).then(function () {
          i++;
          bar.style.width = Math.round(i / names.length * 100) + '%';
          step();
        });
      }
      step();
    });
  }

  /* ---------- 一键补 tarball（勾选包批量补全） ---------- */
  function fillConc() {
    var e = $('#pkg-fill-conc');
    var v = Number(e && e.value);
    if (!isFinite(v) || v < 1) v = 0;                 // 0 = 交给服务端用配置值
    return Math.max(0, Math.min(32, Math.round(v)));
  }

  function fillTarballs() {
    var names = selectedNames();
    if (!names.length) { toast('请先勾选要补 tarball 的包', 'warn'); return; }
    var modeEl = $('#pkg-fill-mode');
    var mode = 'tags';
    if (modeEl) {
      if (modeEl.value === 'all') mode = 'all';
      else if (modeEl.value === 'latest') mode = 'latest';
    }
    var conc = fillConc();
    if (mode === 'all') {
      confirmBox({
        title: '补全部版本', confirmText: '开始补全',
        message: '将对选中的 ' + names.length + ' 个包下载「所有缺失版本」的 tarball。',
        detail: '像 npm 这类包有 600 多个版本，可能下载几百 MB、耗时很久。只想离线装最新版，请把范围改成「只补最新版本」。'
          + (conc ? ' 本次并发数：' + conc + '。' : '')
      }).then(function (ok) { if (ok) runFill(names, mode); });
      return;
    }
    runFill(names, mode);
  }

  /* 全部包补 tarball（不用勾选任何包）：交给服务端按镜像里所有包规划（body.all = true）。
   * mode='tags' → 每个包补 dist-tags 指向的缺失版本；mode='latest' → 每个包只补它自己的最新版本；
   * mode='all' → 每个包把「所有缺失版本」都补齐（最全，也最耗流量和磁盘）。 */
  function fillAllTarballs(mode) {
    mode = mode === 'all' ? 'all' : (mode === 'latest' ? 'latest' : 'tags');
    var isLatest = mode === 'latest';
    var isAll = mode === 'all';
    var conc = fillConc();
    function ask(total, missingN) {
      var msg, detail;
      if (isAll) {
        msg = '将对镜像里全部 ' + (total ? fmtNum(total) + ' 个包' : '包') + '补齐各自「所有缺失版本」的 tarball，已经缓存的会跳过。'
          + (missingN > 0 ? '按当前统计，大约还有 ' + fmtNum(missingN) + ' 个版本的 tarball 没缓存。' : '');
        detail = '这是最全的补法：每个包有多少版本就补多少，可能涉及上万个 tarball、下载几十 GB、耗时很久。'
          + '弹窗里可以随时点「取消下载」，也可以点「后台运行」先去忙别的。只想补常用的最新版，请改用「全部包补最新版本」。';
      } else if (isLatest) {
        msg = '将对镜像里全部 ' + (total ? fmtNum(total) + ' 个包' : '包') + '只补它们各自的最新版本（latest），已经缓存的会跳过。';
        detail = '每个包最多补 1 个 tarball —— 离线只想装最新版时这样最省时间和磁盘。';
      } else {
        msg = '将对镜像里全部 ' + (total ? fmtNum(total) + ' 个包' : '包') + '补 dist-tags 指向的版本，已经缓存的会跳过。';
        detail = '每个包按它自己的 dist-tags 补缺失版本；包多的时候下载量会比较大，弹窗里可以随时点「取消下载」。';
      }
      return confirmBox({
        title: isAll ? '全部包 · 补全部版本' : (isLatest ? '全部包 · 只补最新版本' : '全部包 · 补 dist-tag 版本'),
        sub: isAll ? 'ALL VERSIONS' : 'ALL PACKAGES',
        confirmText: isAll ? '确认补全部版本' : '开始补下载',
        message: msg,
        detail: detail + (conc ? ' 本次并发数：' + conc + '。' : '')
      });
    }
    /* 用镜像全量包数（不受搜索/筛选影响）写进确认框；「补全部版本」再多取一次版本/缓存数，给出「还要补多少个版本」的估计 */
    var totalP = api('/packages?size=1').then(function (d) { return Number(d.total || 0); }, function () { return 0; });
    var missP = isAll
      ? api('/overview').then(function (d) {
        var s = (d && d.stats) || {};
        return Math.max(0, Number(s.versions || 0) - Number(s.tarballs || 0));
      }, function () { return 0; })
      : Promise.resolve(0);
    Promise.all([totalP, missP]).then(function (r) { return ask(r[0], r[1]); }).then(function (ok) {
      if (ok) runFill([], mode, null, { all: true });
    });
  }

  /* 补 tarball：走后台任务 + 轮询，显示真实百分比 / 速率 / 字节 / 预计剩余
   * targets（可选）：[{name, version}] —— 只补点名的版本（mode 传 'selected'）
   * opts.all：全部包模式（包管理页两个「全部包补 …」入口）—— 不传名单，服务端按镜像里所有包规划 */
  /**
   * 右侧「正在下载 / 正在导入的包」栏（单包进度列）。
   * 每个正在进行的包一条大进度条（样式与单包下载行一致：tr-fillrow 背景填充条），
   * 与左侧任务列表等高、各自滚动。返回 { el, paint(pkgs, ended) }。
   * @param {number} conc 并发数：同时在下的包最多就这么多个，栏里最多展示这么多条
   * @param {object} [opts] 文案微调：head/unit/countUnit/bytes(是否显示体积)/countPrefix/endedText/emptyText
   */
  function runningPane(conc, opts) {
    opts = opts || {};
    var headText = opts.head || '正在下载 · 单包进度';
    var unit = opts.unit || '个';
    var countUnit = opts.countUnit || '个';
    var showBytes = opts.bytes !== false;
    var countPrefix = opts.countPrefix || '同时';
    var endedText = opts.endedText || '下载已结束';
    var emptyText = opts.emptyText || '等待开始…';
    var box = el('div', { class: 'fill-run' });
    var empty = el('div', { class: 'fill-run-empty', text: emptyText });
    box.appendChild(empty);
    var cnt = el('span', { class: 'fill-run-cnt', text: '' });
    var headEl = el('span', { text: headText });
    var col = el('div', { class: 'fill-col fill-col-right' }, [
      el('div', { class: 'fill-col-head' }, [headEl, cnt]),
      box
    ]);
    var map = {}, max = Math.max(1, Math.min(32, conc || 6));

    function paint(pkgs, ended) {
      var running = [];
      (pkgs || []).forEach(function (p) {
        if (!p || p.status !== 'running') return;
        /* spin 行是「并行打包」的条目级行（一个正在压缩的文件一行）：大小已知、进度未知，target 为 0；
         * text 行是「收尾写盘」这类没有条目数、只有字节进度的阶段行，同样允许 target 为 0。 */
        if (!(Number(p.target) > 0) && !p.spin && !p.text) return;
        /* keepDone：导入的包通常只有 1 个版本、几毫秒就处理完，若严格只显示"还没下完"的包，
         * 右栏会一直闪空。导入弹窗保留当前包的最终态（100%），直到下一个包开始。 */
        if (!opts.keepDone && !p.spin && !p.text && Number(p.done) >= Number(p.target)) return;
        running.push(p);
      });
      running = running.slice(0, max);
      var seen = {};
      running.forEach(function (p) {
        seen[p.name] = true;
        var it = map[p.name];
        if (!it) {
          var fill = el('i', { class: 'tr-fill', style: 'width:0' });
          var tv = el('span', { class: 'tv', text: '' });
          var nameEl = el('span', { class: 'tr-name', text: p.name });
          var row = el('div', { class: 'taskrow tr-fillrow busy' }, [
            fill,
            el('div', { class: 'tr-in' }, [nameEl, tv])
          ]);
          it = map[p.name] = { row: row, fill: fill, tv: tv, nameEl: nameEl };
          box.appendChild(row);
        }
        if (p.spin) {
          /* 并行打包：一个正在压缩的文件一行，显示文件大小 + 「压缩中…」（完成后由左栏逐包列表接管） */
          it.nameEl.textContent = p.name;
          it.fill.style.width = '0';
          it.tv.textContent = (p.size ? fmtBytes(p.size) + ' · ' : '') + '压缩中…';
          return;
        }
        if (p.text) {
          /* 任意文本行：导出收尾「拼接分片写入最终文件」等没有「条目数」概念的阶段用它显示字节进度 */
          it.nameEl.textContent = p.name;
          it.fill.style.width = Math.max(0, Math.min(100, Number(p.pct) || 0)) + '%';
          it.tv.textContent = p.text;
          return;
        }
        var pct = Math.round(Number(p.done) / Number(p.target) * 100);
        it.fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
        it.tv.textContent = p.done + ' / ' + p.target + ' ' + unit + '（' + pct + '%）' + (showBytes ? ' · ' + fmtBytes(p.bytes || 0) : '');
      });
      Object.keys(map).forEach(function (n) {
        if (seen[n]) return;
        var it2 = map[n];
        if (it2.row.parentNode) it2.row.parentNode.removeChild(it2.row);
        delete map[n];
      });
      empty.hidden = running.length > 0;
      if (!running.length) empty.textContent = ended ? endedText : emptyText;
      cnt.textContent = running.length ? (countPrefix + ' ' + running.length + ' ' + countUnit) : '';
    }

    return {
      el: col,
      paint: paint,
      /* 标题随阶段变化：打包时「正在打包 · 并行文件」，收尾写盘时「正在写入最终文件」 */
      setHead: function (t) { if (t) headEl.textContent = t; },
      /* 并发数在任务快照里（导出/导入可能 4~10 路），弹窗建栏时还不知道，拿到快照后再放宽行数上限 */
      setMax: function (n) {
        var v = Math.max(1, Math.min(32, Number(n) || 1));
        if (v !== max) max = v;
      }
    };
  }

  /**
   * 右侧「正在下载 · 版本进度」栏：每个**正在并发下载的版本（tarball）**一条进度条，
   * 实时显示这个文件自己已收到多少字节 / 总共多少字节（像普通下载器那样看单个文件下到哪了）。
   * 数据来自任务快照的 d.downloads（服务端 pullTarballs 逐数据块上报，400ms 节流）。
   * 返回 { el, paint(downloads, ended) }。
   */
  function downloadsPane(conc, opts) {
    opts = opts || {};
    var headText = opts.head || '正在下载 · 版本进度';
    var emptyText = opts.emptyText || '等待开始…';
    var endedText = opts.endedText || '下载已结束';
    var box = el('div', { class: 'fill-run' });
    var empty = el('div', { class: 'fill-run-empty', text: emptyText });
    box.appendChild(empty);
    var cnt = el('span', { class: 'fill-run-cnt', text: '' });
    var headEl = el('span', { text: headText });
    var col = el('div', { class: 'fill-col fill-col-right' }, [
      el('div', { class: 'fill-col-head' }, [headEl, cnt]),
      box
    ]);
    var map = {}, max = Math.max(1, Math.min(32, conc || 6));

    function paint(downloads, ended) {
      var list = (Array.isArray(downloads) ? downloads : []).slice(0, max);
      var seen = {};
      list.forEach(function (d) {
        var key = String(d.name) + '@' + String(d.version);
        seen[key] = true;
        var it = map[key];
        if (!it) {
          var fill = el('i', { class: 'tr-fill', style: 'width:0' });
          var nameEl = el('span', { class: 'tr-name', text: String(d.name) });
          var subEl = el('span', { class: 'tr-sub', text: '' });
          var row = el('div', { class: 'taskrow tr-fillrow busy fill-dl', title: key }, [
            fill,
            el('div', { class: 'tr-in' }, [nameEl, subEl])
          ]);
          it = map[key] = { row: row, fill: fill, nameEl: nameEl, subEl: subEl, lastRecv: 0, lastAt: 0, speed: 0 };
          box.appendChild(row);
        }
        var recv = Number(d.received) || 0;
        var total = Number(d.total) || 0;
        var now = Date.now();
        if (!it.lastAt) { it.lastRecv = recv; it.lastAt = now; }
        else if (now - it.lastAt >= 300 && recv >= it.lastRecv) {
          it.speed = (recv - it.lastRecv) / ((now - it.lastAt) / 1000);
          it.lastRecv = recv; it.lastAt = now;
        }
        var pct = total > 0 ? Math.max(0, Math.min(100, Math.round(recv / total * 100))) : 0;
        it.fill.style.width = pct + '%';
        /* 两行：第一行包名（超长省略），第二行「版本 · 百分比 · 单文件已下载 / 总共」；
         * 速度放 tooltip 里，避免窄栏被截断（用户要的是「这个文件实时下了多少」）。 */
        it.subEl.textContent = String(d.version) + ' · ' + (total > 0
          ? (pct + '% · ' + fmtBytes(recv) + ' / ' + fmtBytes(total))
          : (recv > 0 ? '已下载 ' + fmtBytes(recv) : '连接中…'));
        setTip(it.row, key + (it.speed > 0 ? ' · ' + fmtBytes(it.speed) + '/秒' : ''));
      });
      Object.keys(map).forEach(function (key) {
        if (seen[key]) return;
        var old = map[key];
        if (old.row.parentNode) old.row.parentNode.removeChild(old.row);
        delete map[key];
      });
      empty.hidden = list.length > 0;
      if (!list.length) empty.textContent = ended ? endedText : emptyText;
      cnt.textContent = list.length ? '同时 ' + list.length + ' 个' : '';
    }

    return { el: col, paint: paint };
  }

  function runFill(names, mode, targets, opts) {
    opts = opts || {};
    var scopeAll = !!opts.all;
    var conc = fillConc();
    var pick = (targets && targets.length) ? targets : null;
    if (pick) {
      var seen = {};
      names = [];
      pick.forEach(function (t) {
        if (!t || !t.name || !t.version) return;
        if (!seen[t.name]) { seen[t.name] = true; names.push(t.name); }
      });
    }
    var MODE_TEXT = { all: '全部版本', tags: 'dist-tag 版本', latest: '只补最新版本', selected: '选中版本' };
    var modeText = MODE_TEXT[pick ? 'selected' : mode] || 'dist-tag 版本';
    var skippedLocal = 0;                     // 全部包模式：服务端跳过的「仅本地」包（上传/私有）个数
    function noteSuffix() { return skippedLocal > 0 ? ' · 已跳过 ' + fmtNum(skippedLocal) + ' 个仅本地的包' : ''; }
    var rows = {}, list = el('div', { class: 'tasklist' });
    /* 右侧新增一栏「正在下载的版本」：与左侧任务列表等高、各自独立滚动；左侧原有内容不动。
     * 这里按「单个 tarball 实时字节进度」显示，而不是包级别的 已完成版本数/总数。 */
    var runPane = downloadsPane(conc);
    var leftCol = el('div', { class: 'fill-col' }, [list]);   // 左栏才是滚动容器（.tasklist 在里面 overflow:visible）
    var cols = el('div', { class: 'fill-cols' }, [leftCol, runPane.el]);
    var bar = el('i', { style: 'width:0' });
    var note = el('p', { class: 'muted', text: scopeAll ? '正在统计全部包的缺失版本…' : '正在统计缺失版本…' });
    var stat = el('div', { class: 'fill-stat', text: '' });
    /* 行按需创建：勾选模式下一开始就把选中的包建好；全部包模式下几百个包全建太浪费，
     * 只在「真的有活干 / 出错」时建（paint 里懒建）。
     * 左栏最多保留 MAX_ROWS 行：超出后把「已完成」的老行收起来，腾位置给还没下完的包。
     * 否则大任务（如全部包补全部版本）会先塞满 500 个「✓ 新增…」的行，看起来像全部完成，
     * 实际后面还有大量包在下载 —— 出错的包永远保留，不收起。 */
    var MAX_ROWS = 500;
    var order = [];                    // 建行顺序（回收时从最老的开始找）
    var hiddenDone = {};               // 已收起行的包名：不再重建行（失败/未完成的不会被收起）
    var hiddenNote = null;
    function hiddenCount() { var n = 0; for (var k in hiddenDone) n++; return n; }
    function showHiddenNote() {
      if (!hiddenNote) {
        hiddenNote = el('div', { class: 'fill-hidden-note', text: '' });
        list.insertBefore(hiddenNote, list.firstChild);
      }
      hiddenNote.textContent = '已收起 ' + fmtNum(hiddenCount()) + ' 个已完成的包（左栏最多保留 '
        + fmtNum(MAX_ROWS) + ' 行；失败和还没下完的包不会被收起）';
    }
    /* 回收一行：只收「已完成」（ok）的行；错误（err）、下载中（busy）、还没开始的行都不动 */
    function reclaimRow() {
      for (var i = 0; i < order.length; i++) {
        var n = order[i], r = rows[n];
        if (!r) { order.splice(i, 1); i--; continue; }
        if ((' ' + r.className + ' ').indexOf(' ok ') < 0) continue;
        if (r.parentNode) r.parentNode.removeChild(r);
        delete rows[n];
        order.splice(i, 1);
        hiddenDone[n] = true;
        showHiddenNote();
        return true;
      }
      return false;
    }
    function mkRow(n) {
      var fill = el('i', { class: 'tr-fill', style: 'width:0' });
      var tv = el('span', { class: 'tv', text: '统计中…' });
      var r = el('div', { class: 'taskrow tr-fillrow pending' }, [
        fill,
        el('div', { class: 'tr-in' }, [el('span', { class: 'tr-name', text: n }), tv])
      ]);
      r.__fill = fill; r.__tv = tv;
      rows[n] = r; list.appendChild(r); order.push(n);
      return r;
    }
    if (!scopeAll) names.forEach(mkRow);
    var body = el('div', {}, [note, el('div', { class: 'progressbar' }, [bar]), stat, cols]);
    var timer = null, finished = false;

    var m = taskModal({
      title: scopeAll ? '补 tarball · 全部包' : '补 tarball', sub: 'FETCH TARBALLS', body: body, sticky: true, wide: true,
      onClose: function () { if (timer) { clearInterval(timer); timer = null; } },
      actions: [
        {
          label: '取消下载', kind: 'btn-ghost', onClick: function (c) {
            if (finished || !taskId) return c.close();
            requestTaskCancel(c.btn, taskId, {
              waitText: '正在取消…', okText: '已请求停止，正在结束已开始的下载…',
              isFinished: function () { return finished; }
            });
          }
        },
        { label: '后台运行', kind: 'btn', onClick: function (c) { c.close(); toast('下载仍在后台进行，完成后可到「日志」页查看', 'info', 6000); } }
      ]
    });
    setSideHint('FETCHING…');

    var taskId = null, lastPkgs = [], pollFails = 0;

    function poll() {
      if (finished) return;
      api('/tasks/' + taskId).then(function (d) {
        if (finished) return;
        pollFails = 0;
        paint(d);
        if (d.status !== 'running') { stop(d); }
      }, function (e) {
        if (finished) return;
        pollFails++;
        if (pollFails <= 2) {
          note.textContent = '进度查询暂时失败：' + (e.message || '未知错误') + '（第 ' + pollFails + ' 次，自动重试中…）';
          return;                    // 保留轮询：网络抖动时不要直接放弃
        }
        if (timer) { clearInterval(timer); timer = null; }
        note.textContent = '进度查询连续失败：' + (e.message || '未知错误') + '（任务可能仍在后台运行；可关闭本窗口后到「日志」页确认结果）';
        taskFinishedButtons(m);      // 切到「后台运行」：取消/后台按钮置灰，露出【关闭】
        setSideHint('READY');
      });
    }

    function paint(d) {
      bar.style.width = (d.percent || 0) + '%';
      note.textContent = '正在按「' + modeText + '」补 tarball · 并发 ' + d.concurrency + ' 个' + (scopeAll ? ' · 全部包' : '') + noteSuffix();
      var secs = Math.round((d.elapsedMs || 0) / 1000);
      var txt = String(d.done) + ' / ' + String(d.total) + ' 个（' + (d.percent || 0) + '%）';
      txt += ' · 已下载 ' + fmtBytes(d.bytes || 0);
      if (d.bytesPerSec) txt += ' · ' + fmtBytes(d.bytesPerSec) + '/秒';
      if (d.ratePerSec) txt += ' · ' + d.ratePerSec + ' 个/秒';
      if (d.failed) txt += ' · 失败 ' + fmtNum(d.failed);
      if (d.status === 'running' && d.etaSec) txt += ' · 剩余约 ' + fmtDur(d.etaSec);
      txt += ' · 已用时 ' + fmtDur(secs);
      stat.textContent = txt;
      (d.packages || []).forEach(function (p) {
        var row = rows[p.name];
        if (!row) {
          if (!scopeAll) return;
          if (!(Number(p.target) > 0) && !p.error) return;      // 全部包模式：没活干的包不建行，避免几百行空壳
          if (hiddenDone[p.name] && !p.error) return;            // 已收起的老行不再重建（真出错了才重建）
          if (Object.keys(rows).length >= MAX_ROWS && !reclaimRow()) return;
          row = mkRow(p.name);
        }
        var tv = row.__tv, fl = row.__fill;
        function mark(cls, pct, text) {
          row.className = 'taskrow tr-fillrow ' + cls;
          fl.style.width = Math.max(0, Math.min(100, pct)) + '%';
          tv.textContent = text;
        }
        if (p.error) { mark('err', 100, '✕ ' + p.error); return; }
        if (p.target === 0) { mark('ok', 100, p.missing ? '✓ 已齐全（另有 ' + fmtNum(p.missing) + ' 个版本未缓存）' : '✓ 已齐全'); return; }
        var pct = Math.round(p.done / p.target * 100);
        if (p.done >= p.target) {
          var tail = fmtBytes(p.bytes || 0);
          if (!p.failed) mark('ok', 100, '✓ 新增 ' + fmtNum(p.ok) + ' 个 · ' + tail);
          else if (!p.ok) mark('err', 100, '✕ 失败 ' + fmtNum(p.failed) + ' 个 · 一个也没下到（原因见下方）');
          else mark('err', 100, '✕ 失败 ' + fmtNum(p.failed) + ' 个，成功 ' + fmtNum(p.ok) + ' 个 · ' + tail);
          return;
        }
        mark('busy', pct, p.done + ' / ' + p.target + ' 个（' + pct + '%）· ' + fmtBytes(p.bytes || 0));
      });
      runPane.paint(d.downloads);
      lastPkgs = d.packages || [];
    }

    function stop(d) {
      if (finished) return;           // 防止两次轮询都拿到终态，重复追加「全部处理完毕」行与 toast
      finished = true;
      if (timer) { clearInterval(timer); timer = null; }
      bar.style.width = (d.percent || 0) + '%';
      var okN = d.ok || 0, badN = d.failed || 0;
      var kind = d.status === 'canceled' ? 'warn' : (badN && !okN ? 'err' : (badN ? 'warn' : 'ok'));
      var head = d.status === 'canceled' ? '已取消：' : ((d.status === 'error' || (badN && !okN)) ? '补 tarball 出错：' : '补 tarball 完成：');
      var msg = head + (okN ? '新增 ' + fmtNum(okN) + ' 个' : '没有新增 tarball');
      if (badN) msg += '，失败 ' + fmtNum(badN) + ' 个（原因见弹窗下方）';
      msg += ' · ' + fmtBytes(d.bytes || 0);
      toast(msg, kind, 9000);
      list.appendChild(el('div', { class: 'taskrow tr-summary ' + (badN ? 'err' : 'ok') }, [
        el('span', { text: d.status === 'canceled' ? '已取消' : '全部处理完毕' }),
        el('span', { class: 'tv', text: '成功 ' + fmtNum(okN) + ' · 失败 ' + fmtNum(badN) })
      ]));
      leftCol.scrollTop = leftCol.scrollHeight;   // 汇总行落到视野里
      if (d.errors && d.errors.length) {
        var box = el('div', { class: 'fill-err' });
        d.errors.slice(0, 12).forEach(function (x) {
          box.appendChild(el('div', { text: '✕ ' + x.name + (x.version ? '@' + x.version : '') + '：' + x.error }));
        });
        if (d.errors.length > 12) box.appendChild(el('div', { text: '… 其余 ' + (d.errors.length - 12) + ' 条见日志' }));
        body.appendChild(box);
      }
      setSideHint('READY');
      runPane.paint([], true);              // 右侧「正在下载」栏收敛成「下载已结束」
      taskFinishedButtons(m);          // 任务已结束：取消/后台运行置灰，显示【关闭】
      /* 收尾刷新：左侧列表必刷；补完单个包时若抽屉还开着，一并重载详情（沿用 prefetchVersions 的写法） */
      function refreshLists() {
        loadPackages();
        if (names.length === 1 && $('#drawer-root') && $('#drawer-root').children.length) openDetail(names[0]);
      }
      if (!badN && okN > 0) setTimeout(function () { m.close(); refreshLists(); }, 1500);   // 全成功才自动关闭
      else if (okN > 0) refreshLists();          // 有失败：保持弹窗让用户看失败明细，只刷新列表
    }

    setSideHint('FETCHING…');
    var pullBody = scopeAll
      ? { mode: mode, all: true, concurrency: conc || undefined }
      : { names: names, mode: pick ? 'selected' : mode, concurrency: conc || undefined };
    if (pick) pullBody.targets = pick;
    api('/packages/pull', { method: 'POST', body: pullBody, timeout: 60000 })
      .then(function (d) {
        taskId = d.taskId;
        skippedLocal = Number(d.skippedLocal) || 0;
        if (!d.total) {
          finished = true;
          var noNeed = pick ? '无需补充：选中的版本都已缓存。'
            : (scopeAll ? '无需补充：全部包的「' + modeText + '」都已缓存。' : '选中的包没有需要补的版本。');
          note.textContent = noNeed + noteSuffix();
          stat.textContent = '0 / 0 个';
          bar.style.width = '100%';
          var shown = 0;
          (d.packages || []).forEach(function (p) {
            if (scopeAll && shown >= 30) return;                // 全部包模式：没有缺失时最多列 30 行示例
            var row = rows[p.name];
            if (!row) {
              if (!scopeAll) return;
              row = mkRow(p.name); shown++;
            }
            row.className = 'taskrow tr-fillrow ' + (p.error ? 'err' : 'ok');
            if (row.__fill) row.__fill.style.width = '100%';
            row.__tv.textContent = p.error ? '✕ ' + p.error
              : (Number(p.missing || 0) > 0
                ? (mode === 'latest'
                  ? '✓ 最新版本已缓存（另有 ' + fmtNum(p.missing) + ' 个版本未缓存）'
                  : '✓ dist-tag 版本已齐（另有 ' + fmtNum(p.missing) + ' 个版本未缓存）')
                : '✓ tarball 已齐全');
          });
          if (scopeAll && (d.packages || []).length > 30) {
            list.appendChild(el('div', { class: 'taskrow tr-summary ok' }, [
              el('span', { text: '其余 ' + fmtNum((d.packages || []).length - 30) + ' 个包也都已齐全' }),
              el('span', { class: 'tv', text: '无需补下载' })
            ]));
          }
          list.appendChild(el('div', { class: 'taskrow tr-summary ok' }, [
            el('span', { text: '全部处理完毕' }),
            el('span', { class: 'tv', text: '无需补下载 · 共 ' + fmtNum((d.packages || []).length) + ' 个包'
              + (skippedLocal ? '（另有 ' + fmtNum(skippedLocal) + ' 个仅本地的包已跳过）' : '') })
          ]));
          taskFinishedButtons(m);          // 没有活干也算「跑完了」：取消/后台运行置灰，露出【关闭】
          runPane.paint([], true);              // 右侧「正在下载」栏：没有在下的包
          leftCol.scrollTop = leftCol.scrollHeight;   // 滚到最后，让「全部处理完毕」汇总行进视野
          toast(pick ? '无需补充：选中的版本都已缓存'
            : (scopeAll ? '无需补充：全部包都已经是最新状态' : '无需补充：选中的包没有缺失的 tarball'), 'ok', 6000);
          setSideHint('READY');
          return;
        }
        note.textContent = '已开始下载 · 并发 ' + d.concurrency + ' 个' + (scopeAll ? ' · 共 ' + fmtNum((d.packages || []).length) + ' 个包' : '') + noteSuffix();
        bar.style.width = '1%';
        timer = setInterval(poll, 700);
        poll();
      }, function (e) {
        finished = true;
        setSideHint('ERROR');
        note.textContent = '无法开始：' + (e.message || '未知错误');
        handleErr(e);
      });
  }

  /* 递归添加依赖：POST /packages/deps-add
   * 一个后台任务里跑两段：①解析依赖闭包（依赖树实时长出来）②按选中版本下载 tarball。
   * 返回的 task.phase 用来区分两段（resolve / download）。 */
  function runDepsAdd(specs, opts) {
    opts = opts || {};
    var depth = Math.max(0, Math.min(50, Math.round(Number(opts.depth) || 8)));
    var limit = Math.max(1, Math.min(5000, Math.round(Number(opts.limit) || 300)));
    var prefetch = opts.prefetch !== false;
    var conc = fillConc();
    var rows = {}, list = el('div', { class: 'tasklist' });
    var bar = el('i', { style: 'width:0' });
    var note = el('p', { class: 'muted', text: '正在解析依赖…' });
    var stat = el('div', { class: 'fill-stat', text: '' });
    /* 左侧栏是唯一滚动容器（.tasklist 在里面 overflow:visible）：只能创建一次，
     * 否则滚动监听会挂在没进布局的旧节点上，用户上滚也无法停止自动跟随。 */
    var leftCol = el('div', { class: 'fill-col' }, [list]);
    // 任务行多时列表会滚动：默认跟随最新一行，用户自己往上滚就停止跟随
    var follow = true;
    leftCol.addEventListener('scroll', function () {
      follow = leftCol.scrollTop + leftCol.clientHeight >= leftCol.scrollHeight - 24;
    });
    /* 右侧新增一栏「正在下载的版本」：解析阶段先显示「等待开始…」，下载阶段逐条（每个 tarball）显示实时字节进度 */
    var runPane = downloadsPane(conc);
    var cols = el('div', { class: 'fill-cols' }, [leftCol, runPane.el]);
    var body = el('div', {}, [note, el('div', { class: 'progressbar' }, [bar]), stat, cols]);
    var timer = null, finished = false, taskId = null, phase = 'resolve', pollFails = 0;

    var m = taskModal({
      title: '递归添加依赖', sub: 'ADD WITH DEPENDENCIES', wide: true, body: body, sticky: true,
      onClose: function () { if (timer) { clearTimeout(timer); timer = null; } },
      actions: [
        {
          label: '取消', kind: 'btn-ghost', onClick: function (c) {
            if (finished || !taskId) return c.close();
            requestTaskCancel(c.btn, taskId, {
              waitText: '正在取消…', okText: '已请求停止，正在结束已开始的下载…',
              isFinished: function () { return finished; }
            });
          }
        },
        { label: '后台运行', kind: 'btn', onClick: function (c) { c.close(); toast('任务仍在后台进行，完成后可到「日志」页查看', 'info', 6000); } }
      ]
    });
    setSideHint('ADDING…');

    function mkRow(key, indent) {
      var fill = el('i', { class: 'tr-fill', style: 'width:0' });
      var tv = el('span', { class: 'tv', text: '…' });
      var nm = el('span', { class: 'tr-name', text: key });
      if (indent) nm.style.paddingLeft = (indent * 14) + 'px';
      var r = el('div', { class: 'taskrow tr-fillrow pending' }, [fill, el('div', { class: 'tr-in' }, [nm, tv])]);
      r.__fill = fill; r.__tv = tv;
      rows[key] = r; list.appendChild(r);
      return r;
    }
    function treeRow(p) {
      // npm: 别名依赖按「别名」显示（跟用户 package.json 里的键一致），真实包名在右侧 tv 里注明
      var label = (p.alias && p.alias.name) ? p.alias.name : p.name;
      var key = label + '@' + (p.version || '');
      return rows[key] || mkRow(key, p.depth || 0);
    }

    function poll() {
      if (finished) return null;
      return api('/tasks/' + taskId).then(function (d) {
        if (finished) return;
        pollFails = 0;
        paint(d);
        if (follow) leftCol.scrollTop = leftCol.scrollHeight;
        if (d.status !== 'running') stop(d);
      }, function (e) {
        if (finished) return;
        pollFails++;
        if (pollFails <= 2) {
          note.textContent = '进度查询暂时失败：' + (e.message || '未知错误') + '（第 ' + pollFails + ' 次，自动重试中…）';
          return;                    // schedule() 会继续排下一次轮询
        }
        if (timer) { clearTimeout(timer); timer = null; }
        note.textContent = '进度查询连续失败：' + (e.message || '未知错误') + '（任务可能仍在后台运行；可关闭本窗口后到「日志」页确认结果）';
        taskFinishedButtons(m);      // 切到「后台运行」：取消/后台按钮置灰，露出【关闭】
        setSideHint('READY');
      });
    }

    // 解析阶段要尽快刷新（依赖树一行行长出来），进入下载阶段后放慢到 700ms
    var inflight = false;
    function schedule() {
      timer = setTimeout(function () {
        if (finished) return;
        if (!inflight) {
          inflight = true;
          Promise.resolve(poll()).then(function () { inflight = false; }, function () { inflight = false; });
        }
        schedule();
      }, phase === 'resolve' ? 150 : 700);
    }

    function paint(d) {
      if (d.phase === 'download' && phase === 'resolve') {   // 解析完切到下载：换成按包的行
        phase = 'download';
        clear(list); rows = {};
        (d.packages || []).forEach(function (p) { mkRow(p.name, 0); });
      }
      if (phase === 'download') {
        bar.style.width = (d.percent || 0) + '%';
        note.textContent = '依赖已解析，正在下载 tarball · 并发 ' + d.concurrency + ' 个';
        var secs = Math.round((d.elapsedMs || 0) / 1000);
        var txt = String(d.done) + ' / ' + String(d.total) + ' 个（' + (d.percent || 0) + '%） · 已下载 ' + fmtBytes(d.bytes || 0);
        if (d.bytesPerSec) txt += ' · ' + fmtBytes(d.bytesPerSec) + '/秒';
        if (d.failed) txt += ' · 失败 ' + fmtNum(d.failed);
        txt += ' · 已用时 ' + fmtDur(secs);
        stat.textContent = txt;
        (d.packages || []).forEach(function (p) {
          var row = rows[p.name]; if (!row) return;
          var tv = row.__tv, fl = row.__fill;
          function mark(cls, pct, text) {
            row.className = 'taskrow tr-fillrow ' + cls;
            fl.style.width = Math.max(0, Math.min(100, pct)) + '%';
            tv.textContent = text;
          }
          if (p.error) { mark('err', 100, '✕ ' + p.error); return; }
          if (p.target === 0) { mark('ok', 100, p.missing ? '✓ 依赖已齐全（另有 ' + fmtNum(p.missing) + ' 个版本未缓存）' : '✓ 依赖已齐全'); return; }
          var pct = Math.round(p.done / p.target * 100);
          if (p.done >= p.target) {
            var tail = fmtBytes(p.bytes || 0);
            if (!p.failed) mark('ok', 100, '✓ 新增 ' + fmtNum(p.ok) + ' 个 · ' + tail);
            else if (!p.ok) mark('err', 100, '✕ 失败 ' + fmtNum(p.failed) + ' 个 · 一个也没下到');
            else mark('err', 100, '✕ 失败 ' + fmtNum(p.failed) + ' 个，成功 ' + fmtNum(p.ok) + ' 个 · ' + tail);
            return;
          }
          mark('busy', pct, p.done + ' / ' + p.target + ' 个（' + pct + '%）· ' + fmtBytes(p.bytes || 0));
        });
        runPane.paint(d.downloads);
        return;
      }
      // 解析阶段：依赖树按发现顺序一行行长出来
      var picks = (d.result && d.result.picks) || [];
      var s = (d.result && d.result.stats) || {};
      note.textContent = '正在解析依赖树…（最多 ' + depth + ' 层 · 最多 ' + fmtNum(limit) + ' 个包）';
      picks.forEach(function (p) {
        var r = treeRow(p);
        var bits = [p.kind === 'root' ? '根包' : ('第 ' + (p.depth || 0) + ' 层')];
        if (p.alias) bits.push('别名 ' + p.alias.spec);
        if (p.newPackage) bits.push('新增包');
        else if (p.newVersion) bits.push('新增版本');
        else bits.push('已存在');
        if (p.deps) bits.push('依赖 ' + p.deps + ' 个');
        if (p.tarball) bits.push('tarball 已缓存');
        r.className = 'taskrow tr-fillrow tr-tree ' + ((p.newPackage || p.newVersion) ? 'ok' : 'pending');
        r.__fill.style.width = '0%';            // 解析阶段没有「下载进度」，别把绿条填满（会盖住文字、像已完成）
        r.__tv.textContent = bits.join(' · ');
      });
      bar.style.width = Math.min(90, 6 + picks.length * 2) + '%';
      stat.textContent = '已找到 ' + fmtNum(picks.length) + ' 个版本 / ' + fmtNum(s.packages || 0) + ' 个包'
        + (s.newPackages ? '（新增 ' + fmtNum(s.newPackages) + ' 个）' : '')
        + (s.aliases ? '（含 ' + fmtNum(s.aliases) + ' 个 npm: 别名）' : '')
        + ' · 待展开 ' + fmtNum(s.queued || 0) + ' 个'
        + (s.truncated ? ' · 已达上限' : '');
    }

    function stop(d) {
      if (finished) return;
      finished = true;
      if (timer) { clearTimeout(timer); timer = null; }
      bar.style.width = '100%';
      var res = d.result || {}, s = res.stats || {}, tb = res.tarballs || null;
      var badN = (tb && tb.failed) || 0;
      var unresolved = res.unresolved || [];
      var kind = d.status === 'canceled' ? 'warn' : ((d.status === 'error' || (badN && !(tb && tb.ok))) ? 'err' : ((badN || unresolved.length) ? 'warn' : 'ok'));
      var head = d.status === 'canceled' ? '已取消：' : ((d.status === 'error') ? '递归添加出错：' : '递归添加完成：');
      var msg = head + '解析 ' + fmtNum(s.packages || 0) + ' 个包 / ' + fmtNum(s.versions || 0) + ' 个版本';
      if (s.newPackages) msg += '，新增 ' + fmtNum(s.newPackages) + ' 个包';
      if (s.aliases) msg += '，含 ' + fmtNum(s.aliases) + ' 个 npm: 别名';
      if (tb) msg += '，tarball 成功 ' + fmtNum(tb.ok) + ' 个' + (badN ? '、失败 ' + fmtNum(badN) + ' 个' : '') + ' · ' + fmtBytes(tb.bytes || 0);
      toast(msg, kind, 9000);
      list.appendChild(el('div', { class: 'taskrow tr-summary ' + (badN ? 'err' : 'ok') }, [
        el('span', { text: d.status === 'canceled' ? '已取消' : '全部处理完毕' }),
        el('span', { class: 'tv', text: '包 ' + fmtNum(s.packages || 0) + ' · 版本 ' + fmtNum(s.versions || 0) + ' · 新增 ' + fmtNum(s.newPackages || 0) + ' 包' })
      ]));
      if (badN || unresolved.length || (d.errors && d.errors.length)) {
        var box = el('div', { class: 'fill-err' });
        (d.errors || []).slice(0, 8).forEach(function (x) {
          box.appendChild(el('div', { text: '✕ ' + x.name + (x.version ? '@' + x.version : '') + '：' + x.error }));
        });
        if (unresolved.length) {
          box.appendChild(el('div', { text: '以下依赖没能自动添加（需要手工处理）：' }));
          unresolved.slice(0, 8).forEach(function (u) {
            box.appendChild(el('div', { text: '· ' + u.name + (u.range ? '@' + u.range : '') + (u.parent ? '（被 ' + u.parent + ' 依赖）' : '') + '：' + (u.error || '') }));
          });
          if (unresolved.length > 8) box.appendChild(el('div', { text: '… 其余 ' + (unresolved.length - 8) + ' 条见日志' }));
        }
        body.appendChild(box);
      }
      setSideHint('READY');
      runPane.paint([], true);          // 右侧「正在下载」栏收敛成「下载已结束」
      taskFinishedButtons(m);           // 任务已结束：取消/后台运行置灰，显示【关闭】
      if (follow) leftCol.scrollTop = leftCol.scrollHeight;   // 让「全部处理完毕」和失败明细落到视野里
      loadPackages();
      if (!badN && !unresolved.length && d.status !== 'canceled') setTimeout(function () { m.close(); loadPackages(); }, 1800);
    }

    api('/packages/deps-add', {
      method: 'POST',
      body: { names: specs, depth: depth, limit: limit, prefetch: prefetch, concurrency: conc || undefined },
      timeout: 60000
    }).then(function (d) {
      taskId = d.taskId;
      note.textContent = '已开始解析依赖树…';
      // 立刻先拉一次：上游快时整个解析可能几百毫秒就结束，等第一个定时器会直接跳到下载阶段、看不到依赖树
      inflight = true;
      Promise.resolve(poll()).then(function () { inflight = false; }, function () { inflight = false; });
      schedule();
    }, function (e) {
      finished = true;
      setSideHint('ERROR');
      note.textContent = '无法开始：' + (e.message || '未知错误');
      handleErr(e);
    });
  }

  function exportSelected() {
    var names = selectedNames();
    if (!names.length) { toast('请先勾选要导出的包', 'warn'); return; }
    setSideHint('EXPORTING…');
    api('/bundles/export', { method: 'POST', body: { scope: 'selected', names: names, withDeps: true }, timeout: 300000 }).then(function (d) {
      var msg = '已导出 ' + d.file + '（' + fmtNum(d.packages) + ' 包 / ' + fmtBytes(d.sizeBytes) + (d.depsAdded ? '，含连带依赖 ' + fmtNum(d.depsAdded) + ' 个' : '') + (d.depsFetched ? '，其中自动下载 ' + fmtNum(d.depsFetched) + ' 个' : '') + '）';
      toast(msg, 'ok', 9000);
      if (d.autoFetch && d.autoFetch.skippedReason) toast('未自动下载缺失依赖：' + d.autoFetch.skippedReason, 'warn', 12000);
      if (d.missingDeps && d.missingDeps.length) {
        var lst = d.missingDeps.slice(0, 6).map(function (x) { return x.name + (x.reason ? '（' + x.reason + '）' : ''); }).join('、');
        toast('有 ' + d.missingDeps.length + ' 个依赖没能导出：' + lst + (d.missingDeps.length > 6 ? ' 等' : '') + '。离线安装时这些依赖会缺失，建议先在「添加公共包」里补上。', 'warn', 14000);
      }
      setSideHint('READY');
      downloadBundle(d.file);
    }, function (e) { setSideHint('ERROR'); handleErr(e); });
  }

  /* ---------- 添加公共包 ---------- */
  function addPackagesModal(presetText) {
    var ta = el('textarea', { class: 'mono', rows: '5', placeholder: '每行一个，或用逗号分隔，可带版本：\nreact\nvue@3.4.1\nlodash, axios@^1.0.0' });
    if (presetText) ta.value = presetText;
    var results = el('div', { class: 'tasklist' });
    var bar = el('i', { style: 'width:0' });
    var status = el('div', { class: 'muted', text: '提示：添加会从上游下载 packument 与 tarball，可能需要几十秒。勾选「同时添加它的依赖」后会递归把依赖、依赖的依赖一起加进来。' });
    var searchBox = el('input', { type: 'search', placeholder: '搜索上游/本地包名，点候选加入列表', autocomplete: 'off' });
    var suggest = el('div', { class: 'chips', style: 'margin-top:8px' });

    // 「递归把依赖也一起加进来」开关：勾上后走 /packages/deps-add（解析依赖树 + 下载）
    var depsCk = el('input', { type: 'checkbox', id: 'deps-recursive' });
    var depthIn = el('input', { type: 'number', id: 'deps-depth', min: '0', max: '50', step: '1', value: '8', style: 'width:64px' });
    var limitIn = el('input', { type: 'number', id: 'deps-limit', min: '1', max: '5000', step: '50', value: '300', style: 'width:84px' });
    var prefetchCk = el('input', { type: 'checkbox', id: 'deps-prefetch', checked: true });
    var depsOpts = el('div', { class: 'muted', style: 'margin-top:10px;line-height:2.1' }, [
      el('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin-right:14px' }, [
        depsCk, el('span', { text: '同时添加它的依赖（递归，依赖的依赖也会一起加）' })
      ]),
      el('span', { style: 'margin-right:6px' }, ['最多层数']), depthIn,
      el('span', { style: 'margin:0 6px 0 12px' }, ['最多包数']), limitIn,
      el('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin-left:14px' }, [
        prefetchCk, el('span', { text: '一并下载 tarball（离线可用）' })
      ])
    ]);

    var body = el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: '包名列表' }), ta]),
      el('div', { class: 'field', style: 'margin-top:10px' }, [el('label', { text: '上游搜索候选' }), searchBox]),
      suggest,
      depsOpts,
      el('div', { style: 'margin-top:12px' }, [status, results, el('div', { class: 'progressbar' }, [bar])])
    ]);

    var timer = null;
    searchBox.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      var t = searchBox.value.trim();
      if (!t) { clear(suggest); return; }
      timer = setTimeout(function () {
        api('/search?text=' + encodeURIComponent(t) + '&size=20', { timeout: 20000 }).then(function (d) {
          clear(suggest);
          (d.items || []).forEach(function (it) {
            var label = it.name + (it.version ? '@' + it.version : '');
            suggest.appendChild(el('button', {
              class: 'btn btn-xs' + (it.local ? ' btn-primary' : ''), type: 'button',
              title: (it.description || '') + (it.date ? ('\n' + it.date) : ''),
              text: label + (it.local ? ' ·本地' : ''),
              onclick: function () {
                ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n') : '') + label;
                toast('已加入待添加列表：' + label, 'ok', 2200);
              }
            }));
          });
          if (!suggest.children.length) suggest.appendChild(el('span', { class: 'muted', text: '没有搜索结果' }));
        }, function (e) { clear(suggest); suggest.appendChild(el('span', { class: 'muted', text: '搜索失败：' + e.message })); });
      }, 320);
    });

    var m = modal({
      title: '添加公共包', sub: 'ADD FROM UPSTREAM', wide: true, body: body,
      actions: [
        { label: '关闭', kind: 'btn-ghost' },
        {
          label: '开始添加', kind: 'btn-primary',
          onClick: function (ctx) {
            var names = ta.value.split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
            names = names.filter(function (v, i) { return names.indexOf(v) === i; });
            if (!names.length) { toast('请输入至少一个包名', 'warn'); return; }
            if (depsCk.checked) {                     // 递归模式：交给专门的进度弹窗（解析依赖树 → 下载）
              var dOpts = {
                depth: Number(depthIn.value) || 8,
                limit: Number(limitIn.value) || 300,
                prefetch: !!prefetchCk.checked
              };
              ctx.close();
              setTimeout(function () { runDepsAdd(names, dOpts); }, 30);
              return;
            }
            clear(results);
            var rows = {};
            names.forEach(function (n) {
              var r = el('div', { class: 'taskrow pending' }, [el('span', { text: n }), el('span', { class: 'tv', text: '排队中' })]);
              rows[n] = r; results.appendChild(r);
            });
            var t0 = Date.now();
            status.textContent = '正在从上游拉取 ' + names.length + ' 个包…（pulling from upstream）';
            bar.style.width = '12%';
            btnBusy(ctx.btn, true, '添加中');
            var fake = setInterval(function () {
              var w = 12 + Math.min(78, (Date.now() - t0) / 400);
              bar.style.width = Math.round(w) + '%';
            }, 400);

            api('/packages', { method: 'POST', body: { names: names }, timeout: 600000 }).then(function (d) {
              clearInterval(fake); bar.style.width = '100%';
              var added = d.added || [], updated = d.updated || [], failed = d.failed || [], skipped = d.skipped || [];
              /* 后端条目字段是 { name, versions(当前版本数), newVersions(本次新增版本数), tarballs(本次缓存 tarball 数), latest }，
               * 没有 version / sizeBytes；updated 是「已存在但版本变多」的包，和 added 一样渲染，别一直停在「排队中」。 */
              function paintOk(a, verb) {
                var r = rows[a.name]; if (!r) return;
                var bits = [];
                if (Number(a.newVersions) > 0) bits.push('新增 ' + fmtNum(a.newVersions) + ' 个版本');
                else if (Number(a.versions) > 0) bits.push('共 ' + fmtNum(a.versions) + ' 个版本');
                if (Number(a.tarballs) > 0) bits.push(fmtNum(a.tarballs) + ' 个 tarball');
                if (a.latest) bits.push('latest ' + a.latest);
                r.className = 'taskrow ok';
                r.lastChild.textContent = '✓ ' + verb + (bits.length ? ' · ' + bits.join(' · ') : '');
              }
              added.forEach(function (a) { paintOk(a, '已添加'); });
              updated.forEach(function (a) { paintOk(a, '已更新'); });
              failed.forEach(function (f) {
                var r = rows[f.name]; if (r) { r.className = 'taskrow err'; r.lastChild.textContent = '✕ ' + (f.error || '失败'); }
              });
              skipped.forEach(function (s) {
                var r = rows[s.name]; if (r) { r.className = 'taskrow pending'; r.lastChild.textContent = '跳过 ' + (s.reason || ''); }
              });
              status.textContent = '完成：新增 ' + added.length + ' 个 · 更新 ' + updated.length + ' 个 · 失败 ' + failed.length + ' 个 · 跳过 ' + skipped.length + ' 个（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）';
              toast('添加完成：新增 ' + added.length + '，更新 ' + updated.length + '，失败 ' + failed.length + '，跳过 ' + skipped.length, failed.length ? 'warn' : 'ok', 8000);
              btnBusy(ctx.btn, false);
              loadPackages();
            }, function (e) {
              clearInterval(fake); bar.style.width = '100%';
              status.textContent = '失败：' + (e.message || '未知错误');
              toast('添加失败：' + (e.message || ''), 'err');
              btnBusy(ctx.btn, false);
            });
          }
        }
      ]
    });
    return m;
  }

  /* ---------- 上传包 ---------- */
  function uploadModal() {
    var list = el('div', { class: 'filelist' });
    var zone = el('div', { class: 'dropzone' }, [
      el('b', { text: '拖入 .tgz 包或 packument .json' }),
      el('i', {}, ['或 ', el('span', { class: 'link', text: '点击选择文件' }), '（可多选，按顺序上传）']),
      el('input', { type: 'file', multiple: true, hidden: true, accept: '.tgz,.tar.gz,.json' })
    ]);
    var status = el('div', { class: 'muted' });
    var body = el('div', {}, [
      el('p', { class: 'muted', text: '上传 npm tarball（.tgz）或 packument（.json）到镜像源；同名版本已存在时会先询问是否覆盖。' }),
      zone, status, list
    ]);
    var m = modal({ title: '上传包', sub: 'UPLOAD PACKAGE', wide: true, body: body, actions: [{ label: '关闭', kind: 'btn-ghost' }] });

    var input = zone.querySelector('input[type=file]');
    zone.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { run(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); if (ev === 'dragleave') zone.classList.remove('is-over'); });
    });
    zone.addEventListener('drop', function (e) {
      zone.classList.remove('is-over');
      if (e.dataTransfer && e.dataTransfer.files) run(e.dataTransfer.files);
    });

    function run(files) {
      var arr = Array.prototype.slice.call(files || []);
      if (!arr.length) return;
      var i = 0, ok = 0, bad = 0;
      zone.classList.add('is-busy');
      status.textContent = '共 ' + arr.length + ' 个文件，正在上传…';

      function next() {
        if (i >= arr.length) {
          zone.classList.remove('is-busy');
          status.textContent = '上传结束：成功 ' + ok + ' 个，失败 ' + bad + ' 个';
          toast('上传完成：成功 ' + ok + '，失败 ' + bad, bad ? 'warn' : 'ok', 7000);
          loadPackages();
          return;
        }
        var f = arr[i];
        // 体积预检：超限时服务端收到上限就回 413 并断连，浏览器只看得到「网络错误」，提前说清楚
        var limMB = uploadLimitMB();
        if (limMB && f.size > limMB * 1024 * 1024) {
          bad++;
          list.appendChild(el('div', { class: 'filerow err' }, [
            el('span', { class: 'fn', text: f.name }),
            el('span', { class: 'fr', text: '✕ ' + fmtBytes(f.size) + ' 超过单包上传上限 ' + fmtNum(limMB) + ' MB（可在「配置」页调大 storage.maxUploadMB）' })
          ]));
          i++; next(); return;
        }
        var row = el('div', { class: 'filerow busy' }, [
          el('span', { class: 'fn', text: f.name }),
          el('span', { class: 'fr', text: '上传中…' })
        ]);
        list.appendChild(row);
        status.textContent = '正在上传 ' + (i + 1) + '/' + arr.length + '：' + f.name;

        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 600000);
        var headers = { 'X-Filename': encodeURIComponent(f.name) };
        var tk = getToken();
        if (tk) headers['X-Mirror-Token'] = tk;
        var init = { method: 'POST', headers: headers, body: f };
        if (ctrl) init.signal = ctrl.signal;

        setBusy(true);
        // 默认不带 overwrite：同名版本已发布时后端回 409 EEXIST，不能静默覆盖（覆盖会重算 integrity）
        function send(overwrite) {
          var url = API + '/upload' + (overwrite ? '?overwrite=1' : '');
          return fetch(url, init).then(function (res) {
            return res.text().then(function (txt) {
              var j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
              return { res: res, json: j };
            });
          });
        }
        send(false).then(function (r) {
          if (r.res.status !== 409) return r;
          var why = (r.json && r.json.error) || ('同名版本已存在：' + f.name);
          if (!window.confirm(why + '\n\n覆盖会重新计算 integrity 并替换已发布版本，确定覆盖？')) {
            r.declined = true;
            return r;
          }
          return send(true);   // 用户确认后才带 overwrite=1 重试
        }).then(function (r) {
          if (r.declined) {
            bad++; row.className = 'filerow err';
            row.lastChild.textContent = '✕ 同名版本已存在，已跳过（未覆盖）';
          } else if (r.res.ok && r.json && r.json.ok) {
            ok++; row.className = 'filerow ok';
            row.lastChild.textContent = '✓ ' + (r.json.data.kind === 'tarball' ? 'tarball' : 'packument') + ' ' + (r.json.data.name || '') + (r.json.data.version ? '@' + r.json.data.version : '') + ' ' + fmtBytes(r.json.data.sizeBytes);
          } else {
            bad++; row.className = 'filerow err';
            row.lastChild.textContent = '✕ ' + ((r.json && r.json.error) || ('HTTP ' + r.res.status));
          }
        }, function (e) {
          bad++; row.className = 'filerow err';
          row.lastChild.textContent = '✕ ' + (e && e.name === 'AbortError' ? '超时' : '网络错误');
        }).then(function () {
          clearTimeout(to); setBusy(false);
          i++; next();
        });
      }
      next();
    }
    return m;
  }

  /* ============================================================
   * 3. 迁移备份
   * ============================================================ */
  function loadBundles() {
    return api('/bundles', { timeout: 60000 }).then(function (d) {
      state.mig.bundles = d.items || [];
      if (d.limits) state.mig.limits = d.limits;
      paintBundles();
      paintImpLimitHint();
    }, function (e) { handleErr(e); }).catch(function () {});
  }

  /* 把服务端真实的离线包上传上限写进导入面板的提示（拿不到就保留 HTML 里的默认文案） */
  function paintImpLimitHint() {
    var node = $('#imp-limit-hint');
    var mb = bundleUploadLimitMB();
    if (!node || !mb) return;
    node.innerHTML = '网页上传上限 ' + fmtNum(mb) + ' MB（流式落盘，不占内存，可在「配置」页调大）。超过上限的大包请直接放进程序目录下的 <code>data\\bundles</code>，刷新本页后从上方「服务器上已有」里点「导入」，或运行「一键导入离线包.cmd」，都不受上传上限限制。';
  }

  /* 网页上传离线包的体积上限（MB）；拿不到（还没登录/旧服务端）时返回 0 = 不做预检 */
  function bundleUploadLimitMB() {
    var l = (state.mig && state.mig.limits) || (state.session && state.session.limits);
    var v = l && Number(l.bundleUploadMB);
    return v > 0 ? v : 0;
  }

  /* 单包上传的体积上限（MB）；拿不到时返回 0 = 不做预检 */
  function uploadLimitMB() {
    var l = (state.session && state.session.limits) || (state.mig && state.mig.limits);
    var v = l && Number(l.uploadMB);
    return v > 0 ? v : 0;
  }

  function paintBundles() {
    var tb = clear($('#mig-tbody')), items = state.mig.bundles;
    if (!tb) return;
    if (!items.length) {
      tb.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'empty' }, [
        el('b', { text: '还没有备份 bundle' }),
        el('span', { text: '在左侧「导出备份」中选择范围并导出，即可生成第一个 bundle' })
      ])]));
    } else {
      items.forEach(function (b) {
        tb.appendChild(el('tr', {}, [
          el('td', { class: 'mono', text: b.file, title: b.path || b.file }),
          el('td', { class: 'num', text: fmtNum(b.packages) }),
          el('td', { class: 'num', text: fmtBytes(b.sizeBytes) }),
          el('td', { class: 'mono col-time', text: dtShort(b.createdAt) }),
          el('td', {}, [el('span', { class: 'badge', text: b.scope || '—' })]),
          el('td', { class: 'col-ops' }, [el('div', { class: 'ops' }, [
            el('button', { class: 'btn btn-xs', type: 'button', text: '下载', onclick: function () { downloadBundle(b.file); } }),
            el('button', { class: 'btn btn-xs btn-amber', type: 'button', text: '导入', onclick: function () { importBundleFile(b.file); } }),
            el('button', { class: 'btn btn-xs btn-danger', type: 'button', text: '删除', onclick: function () { deleteBundle(b.file); } })
          ])])
        ]));
      });
    }
    var sel = $('#imp-file');
    if (sel) {
      var cur = sel.value;
      clear(sel);
      sel.appendChild(el('option', { value: '', text: '（未选择）' }));
      items.forEach(function (b) { sel.appendChild(el('option', { value: b.file, text: b.file + ' · ' + fmtNum(b.packages) + ' 包 · ' + fmtBytes(b.sizeBytes) })); });
      sel.value = cur;
      if (!sel.value) sel.value = '';
    }
  }

  function downloadBundle(file) {
    /* 统一走 fetch 并检查 res.ok：无令牌时若用 <a href> 直链，服务端要求读鉴权会返回 401 JSON，
     * 浏览器会把这段错误 JSON 当成 bundle 文件存下来。 */
    var tk = getToken(), headers = {};
    if (tk) headers['X-Mirror-Token'] = tk;
    setBusy(true);
    fetch(API + '/bundles/download?file=' + encodeURIComponent(file), { headers: headers })
      .then(function (r) {
        if (r.status === 401) { var e = new Error('服务端要求鉴权：请先设置访问令牌'); e.status = 401; throw e; }
        if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = el('a', { href: url, download: file });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast('已开始下载 ' + file, 'ok');
      })
      .catch(function (e) { handleErr(e); })
      .then(function () { setBusy(false); });
  }

  function importBundleFile(file) {
    if (!file) { toast('请先选择要导入的 bundle', 'warn'); return; }
    var ow = $('#imp-overwrite') ? $('#imp-overwrite').checked : true;
    confirmBox({
      title: '导入 bundle', confirmText: '导入',
      message: '确定导入 ' + file + ' ？',
      detail: (ow ? '已存在的同名包/版本会被覆盖。' : '已存在的同名包/版本会被跳过。') + ' 导入过程可能耗时较久。'
    }).then(function (ok) {
      if (!ok) return;
      setSideHint('IMPORTING…');
      runBundleImport({ name: file, overwrite: !!ow });
    });
  }

  function importBundleUpload(file) {
    /* 先按服务端声明的上限做体积预检：
     * 超限时服务端会在收满上限那一刻回 413 并关连接，浏览器只会看到 net::ERR_CONNECTION_RESET，
     * 界面就变成一句没头没尾的「上传失败（网络错误）」。提前拦下并给出可行通路，比让用户干等好。 */
    var limitMB = bundleUploadLimitMB();
    if (limitMB && file.size > limitMB * 1024 * 1024) {
      var bigMsg = '文件 ' + fmtBytes(file.size) + ' 超过网页上传上限 ' + fmtNum(limitMB) + ' MB，未上传。'
        + '请把 .tgz 直接放进 data\\bundles 目录后点「刷新列表」，用表格里的「导入」按钮导入；'
        + '或运行「一键导入离线包.cmd」把文件拖进去（这两条路都不受上传上限限制）。';
      setText('imp-status', bigMsg);
      toast(bigMsg, 'err', 15000);
      return;
    }
    var ow = $('#imp-overwrite') ? $('#imp-overwrite').checked : true;
    setSideHint('IMPORTING…');
    runBundleImport({ file: file, overwrite: !!ow });
  }

  function deleteBundle(file) {
    confirmBox({
      title: '删除 bundle', danger: true, confirmText: '删除',
      message: '确定删除备份文件 ' + file + ' ？', detail: '该文件将从磁盘移除，不可恢复。'
    }).then(function (ok) {
      if (!ok) return;
      api('/bundles?file=' + encodeURIComponent(file), { method: 'DELETE' }).then(function () {
        toast('已删除 ' + file, 'ok');
        loadBundles();
      }, function (e) { handleErr(e); });
    });
  }

  /* ---------- npm 缓存扫描 ---------- */
  var SCAN_PAGE_SIZE = 20;   // 缓存候选表每页行数：本机 npm 缓存动辄几百上千条，不能全渲染

  function scanKeyOf(p) { return p.name + '@' + p.version; }

  /** 勾选 key 是「包名@版本」，而后端导入接口只认包名：去掉版本后缀并去重（含 @scope/name@1.2.3） */
  function scanSelNames() {
    var seen = {}, out = [];
    Object.keys(state.mig.scanSel || {}).forEach(function (k) {
      var n = String(k).replace(/@[^@]*$/, '');
      if (!n || seen[n]) return;
      seen[n] = true; out.push(n);
    });
    return out;
  }

  function scanFilteredItems() {
    var flt = ($('#scan-filter') && $('#scan-filter').value || '').trim().toLowerCase();
    return ((state.mig.scan && state.mig.scan.packages) || []).filter(function (p) {
      return !flt || String(p.name || '').toLowerCase().indexOf(flt) >= 0;
    });
  }

  /** 缓存候选表的分页条（与包列表 #pkg-pager 同款外观） */
  function paintScanPager(total, pages) {
    var box = clear($('#scan-pager'));
    if (!box) return;
    var cur = state.mig.scanPage;
    box.appendChild(el('button', { class: 'pg', type: 'button', text: '‹ 上一页', disabled: cur <= 1 || null, onclick: function () { state.mig.scanPage--; paintScan(); } }));
    var list = [], i;
    for (i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - cur) <= 2) list.push(i);
    var last = 0;
    list.forEach(function (i) {
      if (last && i - last > 1) box.appendChild(el('span', { class: 'sp', text: '…' }));
      box.appendChild(el('button', {
        class: 'pg' + (i === cur ? ' is-on' : ''), type: 'button', text: String(i),
        onclick: function () { state.mig.scanPage = i; paintScan(); }
      }));
      last = i;
    });
    box.appendChild(el('button', { class: 'pg', type: 'button', text: '下一页 ›', disabled: cur >= pages || null, onclick: function () { state.mig.scanPage++; paintScan(); } }));
    box.appendChild(el('span', { class: 'sp', text: '第 ' + cur + '/' + pages + ' 页' }));
  }

  function runScan() {
    var btn = $('#scan-run');
    btnBusy(btn, true, '扫描中…');
    setSideHint('SCANNING…');
    setText('scan-meta', '正在扫描本机 npm 缓存目录，可能需要十几秒…');
    var tb = clear($('#scan-tbody'));
    tb.appendChild(el('tr', {}, [el('td', { colspan: '6' }, [el('div', { class: 'center-box', text: 'SCANNING NPM CACHE…' })])]));
    api('/npmcache/scan?refresh=1', { timeout: 300000 }).then(function (d) {
      state.mig.scan = d; state.mig.scanSel = {}; state.mig.scanPage = 1;
      paintScan();
      setSideHint('READY');
      btnBusy(btn, false);
      toast('扫描完成：' + fmtNum((d.packages || []).length) + ' 个候选包 / ' + fmtBytes(d.bytes), 'ok');
    }, function (e) {
      btnBusy(btn, false); setSideHint('ERROR');
      setText('scan-meta', '扫描失败：' + (e.message || ''));
      clear(tb); tb.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'empty', text: '扫描失败：' + (e.message || '') })]));
      handleErr(e, true);
    });
  }

  function paintScan() {
    var d = state.mig.scan, tb = clear($('#scan-tbody'));
    var filterEl = $('#scan-filter'), importBtn = $('#scan-import'), allChk = $('#scan-chk-all');
    var newBtn = $('#scan-import-new'), allBtn = $('#scan-import-all');
    if (filterEl) filterEl.disabled = false;
    if (allChk) allChk.disabled = false;
    if (!d) {
      if (importBtn) importBtn.disabled = true;
      if (newBtn) newBtn.disabled = true;
      if (allBtn) allBtn.disabled = true;
      paintScanPager(0, 1);
      return;
    }
    var flt = ($('#scan-filter') && $('#scan-filter').value || '').trim().toLowerCase();
    var items = scanFilteredItems();
    setText('scan-meta', '缓存目录：' + (d.cacheDir || '—') + ' · 候选 ' + fmtNum(d.total) + ' 个 · 总体积 ' + fmtBytes(d.bytes) +
      ' · 已扫描 ' + dtShort(d.scannedAt) + ' · 耗时 ' + ((d.durationMs || 0) / 1000).toFixed(1) + 's' +
      (flt ? ' · 过滤后 ' + items.length + ' 个' : '') +
      ' · 镜像里已有 ' + fmtNum((d.packages || []).filter(function (p) { return p.local; }).length) + ' 个');

    var size = SCAN_PAGE_SIZE;
    var pages = Math.max(1, Math.ceil(items.length / size));
    if (state.mig.scanPage > pages) state.mig.scanPage = pages;
    if (state.mig.scanPage < 1) state.mig.scanPage = 1;
    var start = (state.mig.scanPage - 1) * size;
    var pageItems = items.slice(start, start + size);

    if (!items.length) {
      tb.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'empty' }, [
        el('b', { text: d.total ? '没有匹配的候选包' : '本机 npm 缓存里没有可用包' }),
        el('span', { text: d.total ? '试试清空过滤条件' : '先在其它机器上用 npm install 过包，或把 _cacache 目录拷过来再扫描' })
      ])]));
    } else {
      pageItems.forEach(function (p) {
        var key = scanKeyOf(p), sel = !!state.mig.scanSel[key];
        tb.appendChild(el('tr', { class: sel ? 'is-selected' : '' }, [
          el('td', { class: 'col-chk' }, [el('input', { type: 'checkbox', 'data-scan': key, checked: sel || null })]),
          el('td', {}, [el('span', { class: 'pkg-name' }, [nameParts(p.name)])]),
          el('td', { class: 'mono', text: p.version || '—' }),
          el('td', { class: 'num', text: fmtBytes(p.sizeBytes) }),
          el('td', {}, [el('span', { class: 'badge ' + (p.hasTarball ? 'ok' : 'no'), text: p.hasTarball ? '有 tarball' : '缺 tarball' })]),
          el('td', {}, [p.local ? el('span', { class: 'badge upload', text: '本地已有' }) : el('span', { class: 'badge upstream', text: '可导入' })])
        ]));
      });
    }
    paintScanPager(items.length, pages);

    var allSel = items.length > 0 && items.every(function (p) { return state.mig.scanSel[scanKeyOf(p)]; });
    if (allChk) { allChk.checked = allSel; allChk.indeterminate = !allSel && items.some(function (p) { return state.mig.scanSel[scanKeyOf(p)]; }); }
    var n = scanSelNames().length;
    if (importBtn) { importBtn.disabled = n === 0; importBtn.textContent = n ? ('导入选中（' + n + '）') : '导入选中'; }
    var newCount = (d.packages || []).filter(function (p) { return !p.local; }).length;
    if (newBtn) { newBtn.disabled = newCount === 0; setTip(newBtn, '只导入镜像里还没有的包（当前 ' + fmtNum(newCount) + ' 个），已存在的跳过'); }
    if (allBtn) { allBtn.disabled = !(d.packages || []).length; setTip(allBtn, '把本机缓存里扫描到的 ' + fmtNum((d.packages || []).length) + ' 个包全部导入（已存在的按「覆盖已存在」决定）'); }
  }

  /**
   * 从本机 npm 缓存导入。
   * @param {'sel'|'new'|'all'} mode  sel=导入勾选的；new=仅导入镜像里还没有的包；all=全部导入
   */
  function importScan(mode) {
    mode = mode || 'sel';
    var d = state.mig.scan;
    if (!d || !(d.packages || []).length) { toast('请先扫描缓存目录', 'warn'); return; }
    var ow = !!($('#scan-overwrite') && $('#scan-overwrite').checked);
    var body = { overwrite: ow };
    var cnt = 0, detail = '';
    if (mode === 'sel') {
      var names = scanSelNames();
      if (!names.length) { toast('请先勾选要导入的包', 'warn'); return; }
      cnt = names.length; body.names = names; body.all = false;
      detail = '把本机 npm 缓存中的 ' + fmtNum(cnt) + ' 个包导入镜像源';
    } else if (mode === 'new') {
      var uniq = {};
      (d.packages || []).forEach(function (p) { if (!p.local) uniq[p.name] = true; });
      var fresh = Object.keys(uniq);
      if (!fresh.length) { toast('没有需要导入的包：本机缓存里的包镜像里都已存在', 'ok'); return; }
      cnt = fresh.length; body.names = fresh; body.all = false;
      detail = '只导入镜像里还没有的 ' + fmtNum(cnt) + ' 个包（镜像里已有的包自动跳过）';
    } else {
      cnt = (d.packages || []).length;
      body.all = true; body.names = []; body.confirm = true;
      detail = '把本机缓存里扫描到的 ' + fmtNum(cnt) + ' 个包全部导入镜像源';
    }
    confirmBox({
      title: mode === 'all' ? '全部导入缓存包' : (mode === 'new' ? '导入不存在的包' : '导入缓存包'),
      confirmText: '导入 ' + fmtNum(cnt) + ' 个',
      message: detail + '？',
      detail: (ow ? '已存在的版本会被覆盖。' : '已存在的版本会被跳过。') + ' 数据来源为本机 _cacache，无需联网。'
    }).then(function (ok) {
      if (!ok) return;
      var btn = mode === 'all' ? $('#scan-import-all') : (mode === 'new' ? $('#scan-import-new') : $('#scan-import'));
      runCacheImport(body, {
        count: cnt,
        overwrite: ow,
        btn: btn,
        onDone: function (rows) {
          var imported = rows.filter(function (p) { return p.status === 'imported'; });
          var failed = rows.filter(function (p) { return p.status === 'failed'; });
          // 导入成功/失败的包都算「已知」，标记为本地已有，避免再点「仅导入不存在的包」时重复导入
          var known = {};
          imported.concat(failed).forEach(function (x) { if (x && x.name) known[x.name] = true; });
          (d.packages || []).forEach(function (p) { if (known[p.name]) p.local = true; });
          // 清掉已导入包的勾选（勾选 key 是「包名@版本」，按「包名@」前缀删）
          imported.forEach(function (im) {
            var pre = im.name + '@';
            Object.keys(state.mig.scanSel).forEach(function (k) { if (k.indexOf(pre) === 0) delete state.mig.scanSel[k]; });
          });
          paintScan();
          if (imported.length) loadPackages();
        }
      });
    });
  }

  /**
   * 从本机 npm 缓存导入 —— 进度弹窗（长任务模式，轮询 /tasks/<id>）。
   * 左栏：逐包导入详情（✓ 新增 N 个版本 / M 个 tarball · 体积；· 跳过原因；✕ 失败原因）；
   * 右栏：正在导入的当前包的大进度条（k / V 个版本（p%）），与左栏等高、各自独立滚动。
   * 弹窗在导入结束后保持打开（方便看详情），由用户点【关闭】。
   * @param {object} body POST /npmcache/import 的参数（不含 progress）
   * @param {{count:number, overwrite:boolean, btn:Element, onDone:function}} opts
   */
  function runCacheImport(body, opts) {
    opts = opts || {};
    var count = Number(opts.count) || 0;
    var rowMap = {}, list = el('div', { class: 'tasklist' });
    var lastCur = null;                       // 右栏「正在导入 · 当前包」：保留刚处理完的包，避免快速导入时右栏闪空
    var runPane = runningPane(1, {
      head: '正在导入 · 当前包', unit: '个版本', bytes: false,
      countPrefix: '当前', endedText: '导入已结束', emptyText: '等待开始…', keepDone: true
    });
    var leftCol = el('div', { class: 'fill-col' }, [list]);   // 左栏才是滚动容器（.tasklist 在里面 overflow:visible）
    var cols = el('div', { class: 'fill-cols' }, [leftCol, runPane.el]);
    var bar = el('i', { style: 'width:0' });
    var note = el('p', { class: 'muted', text: count
      ? '正在从本机 npm 缓存导入 ' + fmtNum(count) + ' 个包（数据来源 _cacache，无需联网）'
      : '正在读取本机 npm 缓存…' });
    var stat = el('div', { class: 'fill-stat', text: '' });
    var bodyEl = el('div', {}, [note, el('div', { class: 'progressbar' }, [bar]), stat, cols]);
    var timer = null, taskId = null, finished = false, pollFails = 0;
    var MAX_ROWS = 2000;

    var m = taskModal({
      title: '从本机缓存导入', sub: 'IMPORT FROM CACHE', body: bodyEl, sticky: true, wide: true,
      onClose: function () { /* 允许后台继续：轮询不在这里停，结束后仍会刷新列表并 toast */ },
      actions: [
        {
          label: '取消导入', kind: 'btn-ghost', onClick: function (c) {
            if (finished || !taskId) return c.close();
            requestTaskCancel(c.btn, taskId, {
              waitText: '正在取消…', okText: '已请求停止：当前包处理完就停',
              isFinished: function () { return finished; }
            });
          }
        },
        { label: '后台运行', kind: 'btn', onClick: function (c) { c.close(); toast('导入仍在后台进行，完成后可在「日志」页查看', 'info', 6000); } }
      ]
    });

    function mkRow(p) {
      var cls = p.status === 'imported' ? 'ok' : (p.status === 'failed' ? 'err' : 'skip');
      var tv = el('span', { class: 'tv', text: '' });
      if (p.status === 'imported') {
        var bits = [];
        if (p.versions) bits.push(fmtNum(p.versions) + ' 个版本');
        if (p.tarballs) bits.push(fmtNum(p.tarballs) + ' 个 tarball');
        if (p.sizeBytes) bits.push(fmtBytes(p.sizeBytes));
        tv.textContent = '✓ 新增 ' + (bits.length ? bits.join(' · ') : '（没有新内容）');
      } else if (p.status === 'failed') {
        tv.textContent = '✕ ' + (p.error || '导入失败');
      } else {
        tv.textContent = '· 跳过：' + (p.reason || '已存在或不可导入');
      }
      return el('div', { class: 'taskrow tr-fillrow ' + cls }, [
        el('i', { class: 'tr-fill', style: 'width:100%' }),
        el('div', { class: 'tr-in' }, [el('span', { class: 'tr-name', text: p.name }), tv])
      ]);
    }

    function paint(d) {
      bar.style.width = (d.percent || 0) + '%';
      note.textContent = '正在从本机 npm 缓存导入' +
        (d.total ? ' · 共 ' + fmtNum(d.total) + ' 个包' : ' · 正在读取缓存扫描结果…') +
        (opts.overwrite ? ' · 覆盖已存在的版本' : ' · 已存在的版本跳过');
      var secs = Math.round((d.elapsedMs || 0) / 1000);
      var txt = '已处理 ' + fmtNum(d.done || 0) + ' / ' + fmtNum(d.total || 0) + ' 个包（' + (d.percent || 0) + '%）' +
        ' · 成功 ' + fmtNum(d.ok || 0) + ' · 失败 ' + fmtNum(d.failed || 0) + ' · 跳过 ' + fmtNum(d.skipped || 0) +
        ' · 新增 ' + fmtNum(d.versions || 0) + ' 个版本 / ' + fmtNum(d.tarballs || 0) + ' 个 tarball';
      if (d.bytes) txt += ' · ' + fmtBytes(d.bytes);
      if (d.status === 'running' && d.etaSec) txt += ' · 剩余约 ' + fmtDur(d.etaSec);
      txt += ' · 已用时 ' + fmtDur(secs);
      stat.textContent = txt;
      (d.packages || []).forEach(function (p) {
        if (!p || !p.name || rowMap[p.name]) return;
        if (list.children.length >= MAX_ROWS) return;
        rowMap[p.name] = p;
        list.appendChild(mkRow(p));
      });
      var feed = [];
      if (d.current) {
        lastCur = { name: d.current, target: Number(d.currentTotal) || 0, done: Number(d.currentDone) || 0, at: Date.now() };
        feed.push({ name: lastCur.name, status: 'running', target: lastCur.target, done: lastCur.done });
      } else if (lastCur && d.status === 'running' && Date.now() - lastCur.at < 1500) {
        /* 包与包之间（或前端 500ms 轮询之间）几乎瞬间切换，保留刚处理完的包一小会儿，
         * 右栏才不会一直空着；真实进度以左边逐包明细为准。 */
        feed.push({ name: lastCur.name, status: 'running', target: lastCur.target, done: lastCur.done });
      }
      runPane.paint(feed, d.status !== 'running');
    }

    function finalize(d) {
      if (finished) return;
      finished = true;
      if (timer) { clearInterval(timer); timer = null; }
      paint(d);
      bar.style.width = '100%';
      var rows = Object.keys(rowMap).map(function (n) { return rowMap[n]; });
      var imported = rows.filter(function (p) { return p.status === 'imported'; });
      var badArr = rows.filter(function (p) { return p.status === 'failed'; });
      var skipArr = rows.filter(function (p) { return p.status === 'skipped'; });
      var sum = function (arr, k) { return arr.reduce(function (a, x) { return a + (Number(x[k]) || 0); }, 0); };
      var vAdded = sum(imported, 'versions'), tAdded = sum(imported, 'tarballs'), bAdded = sum(imported, 'sizeBytes');
      list.appendChild(el('div', { class: 'taskrow tr-summary ' + (badArr.length ? 'err' : 'ok') }, [
        el('span', { text: d.status === 'canceled' ? '已取消' : (d.status === 'error' ? '导入出错' : '导入完毕') }),
        el('span', { class: 'tv', text: '成功 ' + fmtNum(imported.length) + ' · 失败 ' + fmtNum(badArr.length) + ' · 跳过 ' + fmtNum(skipArr.length) +
          ' · 新增 ' + fmtNum(vAdded) + ' 个版本 / ' + fmtNum(tAdded) + ' 个 tarball · ' + fmtBytes(bAdded) })
      ]));
      if (badArr.length) {
        var errBox = el('div', { class: 'fill-err' });
        badArr.slice(0, 12).forEach(function (x) { errBox.appendChild(el('div', { text: '✕ ' + x.name + '：' + (x.error || '导入失败') })); });
        if (badArr.length > 12) errBox.appendChild(el('div', { text: '… 其余 ' + (badArr.length - 12) + ' 条见日志' }));
        bodyEl.appendChild(errBox);
      }
      var msg = '缓存导入完成：成功 ' + fmtNum(imported.length) + ' 个包（新增 ' + fmtNum(vAdded) + ' 个版本 / ' + fmtNum(tAdded) + ' 个 tarball），失败 ' + fmtNum(badArr.length) + '，跳过 ' + fmtNum(skipArr.length);
      if (skipArr.length) {
        var why = {};
        skipArr.forEach(function (s) { var k = s.reason || '其它原因'; why[k] = (why[k] || 0) + 1; });
        msg += '（' + Object.keys(why).map(function (k) { return k + ' ' + fmtNum(why[k]); }).join('；') + '）';
      }
      if (d.status === 'canceled') msg = '已取消导入：' + msg.replace('缓存导入完成：', '已处理 ');
      toast(msg, badArr.length ? 'warn' : 'ok', 14000);
      badArr.slice(0, 5).forEach(function (f) { toast('· ' + f.name + '：' + (f.error || '失败'), 'err', 7000); });
      setSideHint('READY');
      runPane.paint([], true);
      leftCol.scrollTop = leftCol.scrollHeight;
      taskFinishedButtons(m);            // 结束后取消/后台运行置灰，露出【关闭】；弹窗保留让用户看详情
      if (opts.btn) btnBusy(opts.btn, false);
      if (opts.onDone) { try { opts.onDone(rows, d); } catch (e) { /* 刷新失败不影响导入结果 */ } }
    }

    function poll() {
      if (finished) return;
      api('/tasks/' + taskId).then(function (d) {
        if (finished) return;
        pollFails = 0;
        paint(d);
        if (d.status !== 'running') finalize(d);
      }, function (e) {
        if (finished) return;
        pollFails++;
        if (pollFails <= 2) {
          note.textContent = '进度查询暂时失败：' + (e.message || '未知错误') + '（第 ' + pollFails + ' 次，自动重试中…）';
          return;                    // 保留轮询：网络抖动时不要直接放弃
        }
        if (timer) { clearInterval(timer); timer = null; }
        note.textContent = '进度查询连续失败：' + (e.message || '未知错误') + '（导入可能仍在后台进行；可关闭本窗口后到「日志」页确认结果）';
        taskFinishedButtons(m);      // 切到「后台运行」：取消/后台按钮置灰，露出【关闭】
        setSideHint('READY');
      });
    }

    setSideHint('IMPORTING…');
    if (opts.btn) btnBusy(opts.btn, true, '导入中…');
    api('/npmcache/import', { method: 'POST', body: Object.assign({}, body, { progress: true }), timeout: 120000 })
      .then(function (d) {
        taskId = d.taskId;
        if (d.total) note.textContent = '正在从本机 npm 缓存导入 · 共 ' + fmtNum(d.total) + ' 个包';
        timer = setInterval(poll, 500);
        poll();
      }, function (e) {
        finished = true;
        setSideHint('ERROR');
        note.textContent = '无法开始导入：' + (e.message || '未知错误');
        taskFinishedButtons(m);
        if (opts.btn) btnBusy(opts.btn, false);
        handleErr(e);
      });
  }

  /* ============================================================
   * 3.5 离线包导出 / 导入：详细进度弹窗
   * 后端在请求里带 progress:true（网页上传走 ?progress=1）时先返回 taskId，
   * 这里轮询 /tasks/<id> 画「整体进度条 + 统计行 + 逐包明细 + 当前包进度条」。
   * ============================================================ */

  /* 网页上传离线包（用 XHR 而不是 fetch：只有 XHR 的 upload.onprogress 能给出上传字节进度） */
  function uploadBundleXhr(file, overwrite, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/bundles/import?progress=1' + (overwrite ? '&overwrite=1' : ''), true);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      var tk = getToken();
      if (tk) xhr.setRequestHeader('X-Mirror-Token', tk);
      xhr.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        onProgress({ kind: 'upload', name: file.name, loaded: ev.loaded, total: ev.total });
      };
      xhr.onload = function () {
        var j = null;
        try { j = JSON.parse(xhr.responseText || 'null'); } catch (e) { j = null; }
        if (xhr.status >= 200 && xhr.status < 300 && j && j.ok) { resolve(j.data); return; }
        var err = new Error((j && j.error) || ('HTTP ' + xhr.status));
        err.status = xhr.status;
        err.code = j && j.code;
        reject(err);
      };
      xhr.onerror = function () {
        reject(new Error('上传中断（网络错误）：请确认镜像源服务还在运行；大离线包也可以放进 data\\bundles 目录后用「导入」按钮'));
      };
      xhr.ontimeout = function () {
        reject(new Error('上传超时（30 分钟内没传完）：建议把 .tgz 放进 data\\bundles 目录后用「导入」按钮'));
      };
      xhr.timeout = 1800000;
      xhr.send(file);
    });
  }

  /* 离线包里一个包的明细行：打包（packed）/导入（imported）/失败/跳过 共用 */
  function bundlePkgRow(p) {
    var status = p.status;
    var cls = (status === 'imported' || status === 'packed') ? 'ok' : (status === 'failed' ? 'err' : 'skip');
    var tv = el('span', { class: 'tv', text: '' });
    if (status === 'packed') {
      var bits0 = [];
      if (p.tarballs) bits0.push(fmtNum(p.tarballs) + ' 个 tarball');
      if (p.versions) bits0.push(fmtNum(p.versions) + ' 个版本');
      if (p.sizeBytes) bits0.push(fmtBytes(p.sizeBytes));
      tv.textContent = '✓ 已打包' + (bits0.length ? '：' + bits0.join(' · ') : '');
    } else if (status === 'imported') {
      var bits = [];
      if (p.versions) bits.push(fmtNum(p.versions) + ' 个版本');
      if (p.tarballs) bits.push(fmtNum(p.tarballs) + ' 个 tarball');
      if (p.skipped) bits.push('跳过 ' + fmtNum(p.skipped) + ' 个已存在版本');
      tv.textContent = '✓ 新增 ' + (bits.length ? bits.join(' · ') : '（没有新内容）');
    } else if (status === 'failed') {
      tv.textContent = '✕ ' + (p.reason || '导入失败');
    } else {
      tv.textContent = '· 跳过：' + (p.reason || '已存在或不可导入');
    }
    return el('div', { class: 'taskrow tr-fillrow ' + cls }, [
      el('i', { class: 'tr-fill', style: 'width:100%' }),
      el('div', { class: 'tr-in' }, [el('span', { class: 'tr-name', text: p.name }), tv])
    ]);
  }

  /**
   * 离线包导出/导入的通用进度弹窗。
   * opts: title/sub/intro/busyText/sideHint/waitText/paneHead/paneUnit/paneCountUnit/cancelLabel/btn
   *       extractBar   导入解包阶段用「字节」画整体条
   *       statText(d,pct)  统计行文案
   *       start(onProgress) -> Promise<{taskId}>；上传阶段可用 onProgress({kind:'upload',...}) 回传字节进度
   *       onDone(d)    任务正常结束（含被取消）后的收尾：写状态行 + toast + 刷新列表
   */
  function bundleProgressModal(opts) {
    var rowMap = {}, list = el('div', { class: 'tasklist' });
    var runPane = runningPane(1, {
      head: opts.paneHead || '当前包', unit: opts.paneUnit || '个版本', countUnit: opts.paneCountUnit || '个',
      bytes: false,
      countPrefix: '当前', endedText: '已结束', emptyText: '等待开始…', keepDone: true
    });
    var leftCol = el('div', { class: 'fill-col' }, [list]);
    var cols = el('div', { class: 'fill-cols' }, [leftCol, runPane.el]);
    var bar = el('i', { style: 'width:0' });
    var note = el('p', { class: 'muted', text: opts.intro || '' });
    var stat = el('div', { class: 'fill-stat', text: '' });
    var bodyEl = el('div', {}, [note, el('div', { class: 'progressbar' }, [bar]), stat, cols]);
    var timer = null, taskId = null, finished = false, pollFails = 0, lastCur = null;
    var MAX_ROWS = 2000;
    var m = taskModal({
      title: opts.title, sub: opts.sub, body: bodyEl, sticky: true, wide: true,
      onClose: function () { /* 关掉窗口不打断任务：结束后仍会写状态行并刷新列表 */ },
      actions: [
        {
          label: opts.cancelLabel || '取消', kind: 'btn-ghost', onClick: function (c) {
            if (finished || !taskId) return c.close();
            requestTaskCancel(c.btn, taskId, {
              waitText: '正在取消…', okText: '已请求停止：当前包处理完就停',
              isFinished: function () { return finished; }
            });
          }
        },
        { label: '后台运行', kind: 'btn', onClick: function (c) { c.close(); toast('任务仍在后台进行，完成后可在「日志」页查看', 'info', 6000); } }
      ]
    });

    function setBar(pct) { bar.style.width = (Math.max(0, Math.min(100, Number(pct) || 0))) + '%'; }

    function paint(d) {
      if (!d) return;
      var pct = Number(d.percent) || 0;
      if (opts.extractBar && d.phase === 'extract') {
        pct = d.bytesTotal ? Math.min(100, Math.round(((d.bytes || 0) / d.bytesTotal) * 100)) : 0;
      }
      /* 整体条不要把「压缩完但还在写盘」显示成 100%：打包只映射到 0~95%，拼接分片写最终文件补到 100% */
      if (opts.barPct) { var bp = Number(opts.barPct(d, pct)); if (isFinite(bp)) pct = bp; }
      setBar(pct);
      stat.textContent = opts.statText(d, pct);
      if (opts.paneHeadFor) runPane.setHead(opts.paneHeadFor(d));
      if (d.status === 'running' && opts.phaseNote) {
        var pn = opts.phaseNote(d);
        if (pn) note.textContent = pn;
      }
      (d.packages || []).forEach(function (p) {
        if (!p || !p.name || rowMap[p.name]) return;
        if (list.children.length >= MAX_ROWS) return;
        rowMap[p.name] = p;
        list.appendChild(opts.rowEl(p));
      });
      var feed = [];
      /* 并行打包/导入：任务快照里 inFlight 是「同时在处理的项」列表。
       * 导出是条目级（一个正在压缩的文件一行，带 name=包名 / file=短文件名 / size）；
       * 导入是包级（一个 worker 一个包，带 done/total 版本数）。
       * 旧字段 current（单个包）保留给缓存导入等串行任务做兜底。 */
      /* 收尾写盘阶段没有「正在压缩的文件」了：不再展示压缩阶段的 current / 刚处理完的包，
       * 右栏只留下面那一行「拼接分片 → 最终 .tgz」的字节进度。 */
      var isWritePhase = d.phase === 'concat' || d.phase === 'finalize';
      if (Array.isArray(d.inFlight) && d.inFlight.length) {
        d.inFlight.forEach(function (p) {
          if (!p || !p.name) return;
          if (p.file) {
            feed.push({ name: p.name + ' · ' + p.file, status: 'running', target: 0, spin: true, size: Number(p.size) || 0 });
            return;
          }
          feed.push({ name: p.name, status: 'running', target: Number(p.total) || 0, done: Number(p.done) || 0 });
        });
        lastCur = null;
      } else if (d.current && !isWritePhase) {
        lastCur = { name: d.current, target: Number(d.currentTotal) || 0, done: Number(d.currentDone) || 0, at: Date.now() };
        feed.push({ name: lastCur.name, status: 'running', target: lastCur.target, done: lastCur.done });
      } else if (lastCur && !isWritePhase && d.status === 'running' && Date.now() - lastCur.at < 1500) {
        // 包与包之间轮询可能正好落在间隙：保留刚处理完的包一小会儿，右栏才不会闪空
        feed.push({ name: lastCur.name, status: 'running', target: lastCur.target, done: lastCur.done });
      }
      /* 导出收尾阶段（已经没有「正在压缩的文件」了）：一行显示分片拼接写盘的字节进度 */
      if (d.phase === 'concat' && Number(d.concatTotal) > 0) {
        var ct = Number(d.concatTotal) || 0, cd = Math.min(Number(d.concatDone) || 0, ct);
        feed.push({
          name: '拼接分片 → 最终 .tgz', status: 'running',
          text: fmtBytes(cd) + ' / ' + fmtBytes(ct) + '（' + (ct ? Math.round((cd / ct) * 100) : 0) + '%）',
          pct: ct ? (cd / ct) * 100 : 0
        });
      } else if (d.phase === 'finalize') {
        feed.push({ name: '收尾：重命名最终文件', status: 'running', text: '写盘完成，正在收尾…', pct: 100 });
      }
      runPane.setMax(d.concurrency || 1);
      runPane.paint(feed, d.status !== 'running');
      leftCol.scrollTop = leftCol.scrollHeight;
    }

    function finalize(d) {
      if (finished) return;
      finished = true;
      if (timer) { clearInterval(timer); timer = null; }
      paint(d);
      setBar(100);
      runPane.paint([], true);
      taskFinishedButtons(m);
      if (opts.btn) btnBusy(opts.btn, false);
      if (d.status === 'error') {
        note.textContent = '任务失败：' + (d.message || '未知错误');
        setSideHint('ERROR');
        if (opts.onDone) opts.onDone(d);   // 让调用方把失败写回页面状态行
        if (opts.onFinalize) { try { opts.onFinalize(d, { body: bodyEl, list: list }); } catch (e) { /* 附加详情渲染失败不影响主流程 */ } }
        handleErr(new Error(d.message || '任务失败'));
        return;
      }
      // 结果详情（例如导入失败清单）由调用方追加到弹窗最下方，避免用户去左栏一条条翻
      if (opts.onFinalize) { try { opts.onFinalize(d, { body: bodyEl, list: list }); } catch (e) { /* 附加详情渲染失败不影响主流程 */ } }
      opts.onDone(d);
    }

    function poll() {
      if (finished) return;
      api('/tasks/' + taskId).then(function (d) {
        if (finished) return;
        pollFails = 0;
        paint(d);
        if (d.status !== 'running') finalize(d);
      }, function (e) {
        if (finished) return;
        pollFails++;
        if (pollFails <= 2) {
          note.textContent = '进度查询暂时失败：' + (e.message || '未知错误') + '（第 ' + pollFails + ' 次，自动重试中…）';
          return;                    // 网络抖动时别直接放弃，保留轮询
        }
        if (timer) { clearInterval(timer); timer = null; }
        note.textContent = '进度查询连续失败：' + (e.message || '未知错误') + '（任务可能仍在后台进行；可关闭本窗口后到「日志」页确认结果）';
        taskFinishedButtons(m);
      });
    }

    if (opts.btn) btnBusy(opts.btn, true, opts.busyText || '处理中…');
    setSideHint(opts.sideHint || 'WORKING…');
    opts.start(function (info) {
      if (!info || info.kind !== 'upload') return;
      var pct = info.total ? Math.round((info.loaded / info.total) * 100) : 0;
      setBar(pct);
      note.textContent = '正在上传 ' + info.name + '：' + fmtBytes(info.loaded) + ' / ' + fmtBytes(info.total) + '（' + pct + '%）';
      stat.textContent = '上传完成后自动开始导入，期间请勿关闭页面';
    }).then(function (d) {
      taskId = d && d.taskId;
      if (!taskId) throw new Error('服务端没有返回任务编号');
      note.textContent = opts.waitText || '任务已开始…';
      timer = setInterval(poll, 500);
      poll();
    }).catch(function (e) {
      if (finished) return;
      finished = true;
      if (timer) { clearInterval(timer); timer = null; }
      setSideHint('ERROR');
      note.textContent = '无法开始：' + (e.message || '未知错误');
      taskFinishedButtons(m);
      if (opts.btn) btnBusy(opts.btn, false);
      handleErr(e);
    });
    return m;
  }

  /* 导出备份：详细进度（统计 → 打包，逐包明细 + 当前包，可取消） */
  function runBundleExport(payload, btn) {
    function statText(d, pct) {
      var secs = Math.round((d.elapsedMs || 0) / 1000);
      if (d.status === 'error') return '没有生成文件 · 已用时 ' + fmtDur(secs);
      if (d.phase === 'collect') {
        var head = d.message || '正在统计要导出的包…';
        var cnt = (d.done || d.total) ? '（' + fmtNum(d.done || 0) + ' / ' + fmtNum(d.total || 0) + '）' : '';
        return head + cnt + ' · 已用时 ' + fmtDur(secs);
      }
      if (d.phase === 'concat') {
        var cTot = Number(d.concatTotal) || 0;
        var cDone = Math.min(Number(d.concatDone) || 0, cTot);
        var cW = cTot ? Math.round((cDone / cTot) * 100) : 0;
        return '压缩完成，正在把' + (d.concatParts > 1 ? ' ' + fmtNum(d.concatParts) + ' 个分片' : '分片') + '拼接写入最终 .tgz：' +
          fmtBytes(cDone) + ' / ' + fmtBytes(cTot) + '（' + cW + '%） · 只读写磁盘、不重新压缩 · 已用时 ' + fmtDur(secs);
      }
      if (d.phase === 'finalize') {
        return '写盘完成，正在收尾（重命名最终文件）… · 已用时 ' + fmtDur(secs);
      }
      var filePct = d.total > 0 ? Math.round((d.done || 0) / d.total * 100) : pct;
      var txt = '已打包 ' + fmtNum(d.done || 0) + ' / ' + fmtNum(d.total || 0) + ' 个文件（' + filePct + '%）';
      if (d.bytes || d.bytesTotal) txt += ' · ' + fmtBytes(d.bytes || 0) + (d.bytesTotal ? ' / ' + fmtBytes(d.bytesTotal) : '');
      if (d.ok) txt += ' · 已完成 ' + fmtNum(d.ok) + ' 个包';
      if (d.concurrency > 1) txt += ' · 并行 ' + d.concurrency + ' 路压缩';
      if (d.status === 'running' && d.bytesPerSec && d.bytesTotal && d.bytes < d.bytesTotal) {
        var eta = Math.round((d.bytesTotal - (d.bytes || 0)) / d.bytesPerSec);
        if (eta > 0) txt += ' · 剩余约 ' + fmtDur(eta);
      }
      txt += ' · 已用时 ' + fmtDur(secs);
      return txt;
    }
    var m = bundleProgressModal({
      title: '导出离线包', sub: 'EXPORT BUNDLE',
      intro: '正在统计要导出的包…',
      busyText: '导出中…', sideHint: 'EXPORTING…', waitText: '正在打包…',
      paneHead: '正在打包 · 并行文件', paneUnit: '个文件', paneCountUnit: '个文件',
      /* 标题随阶段切换：压缩时「正在打包 · 并行文件」，收尾写盘时换成「正在写入 · 拼接分片」 */
      paneHeadFor: function (d) {
        if (d.phase === 'concat') return '正在写入 · 拼接分片';
        if (d.phase === 'finalize') return '正在写入 · 收尾';
        return '正在打包 · 并行文件';
      },
      /* 整体进度条：压缩阶段只走到 95%，剩下 5% 留给「拼接分片写最终文件」，避免 100% 却还在写盘 */
      barPct: function (d, pct) {
        if (d.phase === 'concat') {
          var t = Number(d.concatTotal) || 0;
          if (!t) return 95;
          return 95 + Math.min(5, (Math.min(Number(d.concatDone) || 0, t) / t) * 5);
        }
        if (d.phase === 'finalize') return 100;
        if (d.phase === 'collect') return pct;
        return Math.min(95, pct * 0.95);
      },
      cancelLabel: '取消导出', btn: btn,
      extractBar: false,
      statText: statText,
      rowEl: bundlePkgRow,
      phaseNote: function (d) {
        if (d.phase === 'collect') return (d.message || '正在统计要导出的包…') + '（这一步只读镜像里的元数据，可以取消）';
        if (d.phase === 'concat') return '正在把并行压缩的分片按顺序拼成最终 .tgz 写入磁盘（不重新压缩，只读写一遍；大镜像这一步要几十秒到几分钟，可以取消）';
        if (d.phase === 'finalize') return '正在收尾：重命名最终文件并清理临时分片，马上完成。';
        return '正在打包并压缩（gzip），可以点「取消导出」随时停下。';
      },
      start: function () {
        return api('/bundles/export', { method: 'POST', body: Object.assign({}, payload, { progress: true }), timeout: 120000 });
      },
      onDone: function (d) {
        var r = d.result || {};
        if (d.status === 'error') {
          setText('exp-status', '导出失败：' + (d.message || '未知错误'));
          toast('导出失败：' + (d.message || '未知错误'), 'err', 10000);
          setSideHint('READY');
          return;
        }
        if (d.status === 'canceled') {
          setText('exp-status', '已取消导出（没有生成新的 bundle）');
          toast('已取消导出', 'warn');
          setSideHint('READY');
          setTimeout(function () { m.close(); }, 1200);
          return;
        }
        var msg = '已导出 ' + r.file + '：' + fmtNum(r.packages) + ' 包 / ' + fmtNum(r.versions) + ' 版本 / ' + fmtNum(r.tarballs) + ' tarball / ' + fmtBytes(r.sizeBytes);
        if (payload.scope === 'added') msg = '已按添加时间导出（' + (payload.addedFrom ? '从 ' + dtShort(payload.addedFrom) : '起始不限') + ' 到 ' + (payload.addedTo ? dtShort(payload.addedTo) : '现在') + '）：' + fmtNum(r.packages) + ' 包 / ' + fmtNum(r.versions) + ' 版本 / ' + fmtNum(r.tarballs) + ' tarball / ' + fmtBytes(r.sizeBytes);
        if (r.depsAdded) msg += '（其中连带依赖 ' + fmtNum(r.depsAdded) + ' 个' + (r.depsFetched ? '，自动下载 ' + fmtNum(r.depsFetched) + ' 个' : '') + '）';
        setText('exp-status', msg);
        toast(msg, 'ok', 9000);
        if (r.autoFetch && r.autoFetch.skippedReason) toast('未自动下载缺失依赖：' + r.autoFetch.skippedReason, 'warn', 12000);
        if (r.missingDeps && r.missingDeps.length) {
          var lst = r.missingDeps.slice(0, 8).map(function (x) {
            return x.name + (x.parent ? '（' + x.parent + ' 依赖）' : '') + (x.reason ? '：' + x.reason : '');
          }).join('、');
          toast('有 ' + r.missingDeps.length + ' 个依赖没能导出：' + lst + (r.missingDeps.length > 8 ? ' 等' : '') + '。离线安装时这些依赖会缺失，建议先在「添加公共包」里补上。', 'warn', 14000);
        }
        setSideHint('READY');
        loadBundles();
        downloadBundle(r.file);
        setTimeout(function () { m.close(); }, 1500);   // 成功导出自动关窗，别挡住后续操作
      }
    });
    return m;
  }

  /* 导入备份：详细进度（上传/解包 → 逐包导入，可取消）。file 为网页上传的 File，name 为服务器上已有 bundle 名 */
  /* 导入结束后：把失败 / 跳过整理成弹窗最下方的可滚动详情（可一键复制），不用在左栏逐条翻 */
  function bundleImportFailPanel(d) {
    var r = (d && d.result) || {};
    var fails = Array.isArray(r.failed) ? r.failed.slice() : [];
    var rows = Array.isArray(d && d.packages) ? d.packages : [];
    var skipped = rows.filter(function (p) { return p && p.status === 'skipped'; });
    if (!fails.length && !skipped.length) return null;
    var lines = [];
    var box = el('div', { class: 'fill-err bundle-fail' });
    var head = el('div', { class: 'fill-err-head' });
    var headText = [];
    if (fails.length) headText.push('失败 ' + fmtNum(fails.length) + ' 条');
    if (skipped.length) headText.push('跳过 ' + fmtNum(skipped.length) + ' 个包');
    head.appendChild(el('b', { text: '导入结果详情（' + headText.join(' · ') + '）' }));
    var copyBtn = el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: '复制清单' });
    copyBtn.onclick = function () {
      var txt = lines.join('\n');
      function copied() { toast('已复制 ' + fmtNum(lines.length) + ' 条到剪贴板', 'ok', 4000); }
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = txt;
          ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          copied();
        } catch (e) { toast('复制失败，请手动选中文本复制', 'err'); }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(copied, fallback);
      else fallback();
    };
    head.appendChild(copyBtn);
    box.appendChild(head);
    var MAX_SHOW = 500;
    if (fails.length) {
      box.appendChild(el('div', { class: 'fill-err-group', text: '失败（逐条，' + fmtNum(fails.length) + ' 条）：' }));
      fails.slice(0, MAX_SHOW).forEach(function (f) {
        var pre = f.name + (f.version ? '@' + f.version : '');
        var why = String(f.error || '导入失败');
        // 后端有些错误文案本身已经带「name@version：」前缀，避免显示成「a@1：a@1：...」
        if (why.indexOf(pre + '：') === 0) why = why.slice(pre.length + 1);
        var line = '✕ ' + pre + '：' + why;
        lines.push(line);
        box.appendChild(el('div', { text: line }));
      });
      if (fails.length > MAX_SHOW) {
        box.appendChild(el('div', { class: 'fill-err-more', text: '… 其余 ' + fmtNum(fails.length - MAX_SHOW) + ' 条不在这里展开，点右上角「复制清单」可拿到全部' }));
      }
    }
    if (skipped.length) {
      var groups = {}, order = [];
      skipped.forEach(function (p) {
        var why = p.reason || '其它原因';
        if (!groups[why]) { groups[why] = []; order.push(why); }
        groups[why].push(p.name);
      });
      box.appendChild(el('div', { class: 'fill-err-group', text: '跳过（按原因归类，' + fmtNum(skipped.length) + ' 个包）：' }));
      order.forEach(function (why) {
        var names = groups[why];
        var sample = names.slice(0, 6).join('、') + (names.length > 6 ? ' 等' : '');
        lines.push('· 跳过 ' + fmtNum(names.length) + ' 个（' + why + '）：' + names.join('、'));
        box.appendChild(el('div', { text: '· ' + why + ' × ' + fmtNum(names.length) + '（例：' + sample + '）' }));
      });
    }
    return box;
  }

  function runBundleImport(opts) {
    var isUpload = !!opts.file;
    var label = isUpload ? opts.file.name : opts.name;
    setText('imp-status', (isUpload ? '正在上传并导入 ' : '正在导入 ') + label + ' …');
    function statText(d, pct) {
      var secs = Math.round((d.elapsedMs || 0) / 1000);
      if (d.phase === 'extract') {
        var ep = d.bytesTotal ? Math.min(100, Math.round(((d.bytes || 0) / d.bytesTotal) * 100)) : 0;
        return '正在解包备份文件：' + fmtBytes(d.bytes || 0) + (d.bytesTotal ? ' / ' + fmtBytes(d.bytesTotal) : '') + '（' + ep + '%） · 已用时 ' + fmtDur(secs);
      }
      if (d.phase !== 'import') {
        return '正在准备导入… · 已用时 ' + fmtDur(secs);
      }
      var txt = '已处理 ' + fmtNum(d.done || 0) + ' / ' + fmtNum(d.total || 0) + ' 个包（' + pct + '%）'
        + ' · 成功 ' + fmtNum(d.ok || 0) + ' · 失败 ' + fmtNum(d.failed || 0) + ' · 跳过 ' + fmtNum(d.skipped || 0)
        + ' · 新增 ' + fmtNum(d.versions || 0) + ' 个版本 / ' + fmtNum(d.tarballs || 0) + ' 个 tarball';
      if (d.concurrency > 1) txt += ' · 并行 ' + d.concurrency + ' 路导入';
      if (d.status === 'running' && d.etaSec) txt += ' · 剩余约 ' + fmtDur(d.etaSec);
      txt += ' · 已用时 ' + fmtDur(secs);
      return txt;
    }
    var m = bundleProgressModal({
      title: isUpload ? '上传并导入离线包' : '导入离线包', sub: 'IMPORT BUNDLE',
      intro: isUpload
        ? '正在上传 ' + opts.file.name + '（' + fmtBytes(opts.file.size) + '）…'
        : '正在读取 ' + opts.name + ' …',
      busyText: '导入中…', sideHint: 'IMPORTING…', waitText: '正在解包…',
      paneHead: '正在导入 · 并行包', paneUnit: '个版本', paneCountUnit: '个包',
      cancelLabel: '取消导入', btn: opts.btn || null,
      extractBar: true,
      statText: statText,
      rowEl: bundlePkgRow,
      phaseNote: function (d) {
        if (d.phase === 'extract') return '正在解包备份文件…（可以取消，已解出的部分会清掉）';
        return '正在把包写入本地存储…（可以取消，已导入的部分会保留）';
      },
      onFinalize: function (d, ui) {
        // 失败 / 跳过整理到弹窗最下方，结束时可整块看、可复制
        var box = bundleImportFailPanel(d);
        if (box) ui.body.appendChild(box);
      },
      start: function (onProgress) {
        if (isUpload) return uploadBundleXhr(opts.file, opts.overwrite, onProgress);
        return api('/bundles/import', {
          method: 'POST',
          body: { file: opts.name, overwrite: !!opts.overwrite, progress: true },
          timeout: 120000,
        });
      },
      onDone: function (d) {
        var r = d.result || {};
        if (d.status === 'error') {
          var emsg = '导入失败：' + (d.message || '未知错误');
          setText('imp-status', emsg);
          toast(emsg, 'err', 12000);
          setSideHint('READY');
          return;
        }
        var canceled = d.status === 'canceled';
        var msg;
        if (canceled) {
          msg = '已取消导入（已导入的部分已保留）：' + fmtNum(r.packages || 0) + ' 包 / ' + fmtNum(r.versions || 0) + ' 版本 / ' + fmtNum(r.tarballs || 0) + ' tarball';
        } else {
          msg = '导入完成：' + fmtNum(r.packages || 0) + ' 包 / ' + fmtNum(r.versions || 0) + ' 版本 / ' + fmtNum(r.tarballs || 0) + ' tarball';
          if (r.skipped) msg += '，跳过 ' + fmtNum(r.skipped);
        }
        setText('imp-status', msg);
        toast(msg, (canceled || (r.failed && r.failed.length)) ? 'warn' : 'ok', 10000);
        (r.failed || []).slice(0, 5).forEach(function (f) { toast('· ' + f.name + '：' + (f.error || '失败'), 'err', 7000); });
        setSideHint('READY');
        loadBundles(); loadPackages();
      }
    });
    return m;
  }

  /* ============================================================
   * 4. 配置
   * ============================================================ */
  var CFG_GROUPS = [
    {
      title: '服务', en: 'SERVER', fields: [
        { k: 'mode', label: '运行模式', type: 'select', hint: 'offline = 纯离线，服务不再访问上游 registry；cache = 在线缓存，可回源上游。', options: [['cache', 'cache · 在线缓存（可回源上游）'], ['offline', 'offline · 纯离线（禁止外网）']] },
        { k: 'server.ip', label: '监听 IP', type: 'text', hint: '0.0.0.0 允许局域网访问，127.0.0.1 仅本机。' },
        { k: 'server.port', label: '监听端口', type: 'number' },
        { k: 'server.openBrowserOnStart', label: '启动时自动打开浏览器', type: 'bool' }
      ]
    },
    {
      title: '上游', en: 'UPSTREAM', fields: [
        { k: 'upstream.registry', label: '上游 registry', type: 'text' },
        { k: 'upstream.timeoutMs', label: '超时（毫秒）', type: 'number' },
        { k: 'upstream.retries', label: '重试次数', type: 'number' },
        { k: 'upstream.concurrency', label: '「补 tarball」并发下载数', type: 'number', hint: '同时下载几个 tarball，1~32，默认 6；太大可能被上游限速或占用较多内存。也可在「包管理」页选择条里直接改。' },
        { k: 'upstream.prefetchTarball', label: '拉取元数据时预取 tarball', type: 'bool' },
        { k: 'upstream.metadataTtlSec', label: '元数据缓存 TTL（秒）', type: 'number' },
        { k: 'upstream.acceptAbbreviated', label: '接受 abbreviated 元数据', type: 'bool' }
      ]
    },
    {
      title: '安全', en: 'SECURITY', fields: [
        { k: 'security.token', label: '访问令牌', type: 'token', hint: '留空表示不修改已保存的令牌。' },
        { k: 'security.requirePublish', label: '发布需要令牌', type: 'bool' },
        { k: 'security.requireRead', label: '读取需要令牌', type: 'bool' },
        { k: 'security.trustLocalhost', label: '回环地址免鉴权', type: 'bool', hint: '开启后本机 127.0.0.1 访问不需要令牌。' },
        { k: 'security.username', label: '发布用户名', type: 'text' }
      ]
    },
    {
      title: '存储', en: 'STORAGE', fields: [
        { k: 'storage.dir', label: '存储目录', type: 'text' },
        { k: 'storage.maxUploadMB', label: '单包上传上限（MB）', type: 'number', hint: '网页上传单个 .tgz 安装包的上限，1-4096。' },
        { k: 'storage.maxBundleUploadMB', label: '离线包上传上限（MB）', type: 'number', hint: '网页上传整机备份（离线包）的上限，1-65536；服务端流式落盘，不占内存。更大的包建议直接放进 data/bundles 目录后再用「导入」按钮。' },
        { k: 'storage.bundleExportConcurrency', label: '离线包导出并发', type: 'number', hint: '导出整机备份时并行压缩的线程数，1-16，默认 4。设 1 回到单线程；机器核数多时可调大。' },
        { k: 'storage.bundleImportConcurrency', label: '离线包导入并发', type: 'number', hint: '导入整机备份时同时处理的包数，1-16，默认 4。设 1 回到串行；机械硬盘或 CPU 较忙时调小更稳。' }
      ]
    },
    {
      title: '日志', en: 'LOG', fields: [
        { k: 'log.level', label: '日志级别', type: 'select', options: [['debug', 'debug'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']] },
        { k: 'log.maxDays', label: '保留天数', type: 'number' }
      ]
    },
    {
      title: '界面', en: 'UI', fields: [
        { k: 'ui.title', label: '控制台标题', type: 'text' }
      ]
    }
  ];

  function getPath(o, path) {
    var cur = o, parts = path.split('.'), i;
    for (i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }
  function setPath(o, path, v) {
    var parts = path.split('.'), cur = o, i;
    for (i = 0; i < parts.length - 1; i++) { if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = v;
  }

  function syncFillConc() {
    var e = $('#pkg-fill-conc');
    if (!e) return;
    var v = state.cfg && state.cfg.raw && state.cfg.raw.upstream ? Number(state.cfg.raw.upstream.concurrency) : 0;
    if (v > 0) { e.value = String(v); e.placeholder = String(v); }
  }

  function loadConfig(reveal) {
    setSideHint('LOADING…');
    return api('/config' + (reveal ? '?reveal=1' : ''), { timeout: 30000 }).then(function (d) {
      state.cfg.raw = d.config || {};
      if (!reveal) state.cfg.baseline = JSON.parse(JSON.stringify(state.cfg.raw));
      state.cfg.path = d.path || '—';
      state.cfg.revealed = !!reveal;
      paintConfig();
      syncRestartBanner();
      syncFillConc();
      setSideHint('READY');
    }, function (e) { setSideHint('ERROR'); handleErr(e); }).catch(function () {});
  }

  function paintConfig() {
    setText('cfg-path', state.cfg.path || '—');
    var host = clear($('#cfg-form'));
    if (!host) return;
    var raw = state.cfg.raw;
    /* 「访问令牌」面板与表单里的令牌框保持同步：只有 reveal 过才显示真实令牌，否则显示 — */
    var ro = $('#token-ro');
    if (ro) ro.value = (state.cfg.revealed && raw && raw.security && raw.security.token) ? raw.security.token : '—';

    CFG_GROUPS.forEach(function (g) {
      var grid = el('div', { class: 'cfg-grid' });
      g.fields.forEach(function (f) {
        var val = getPath(raw, f.k);
        var item = el('div', { class: 'cfg-item' });
        var input;

        if (f.type === 'bool') {
          input = el('input', { type: 'checkbox', 'data-cfg': f.k, checked: val ? true : null });
          item.appendChild(el('label', { text: f.label }));
          item.appendChild(el('div', { class: 'bool' }, [input, el('span', { text: val ? '已开启' : '已关闭' })]));
          input.addEventListener('change', function () {
            input.parentNode.querySelector('span').textContent = input.checked ? '已开启' : '已关闭';
          });
        } else if (f.type === 'select') {
          input = el('select', { 'data-cfg': f.k });
          (f.options || []).forEach(function (o) { input.appendChild(el('option', { value: o[0], text: o[1], selected: String(val) === String(o[0]) ? true : null })); });
          if (val !== undefined && !(f.options || []).some(function (o) { return String(o[0]) === String(val); })) {
            input.appendChild(el('option', { value: String(val), text: String(val), selected: true }));
          }
          item.appendChild(el('label', { text: f.label }));
          item.appendChild(input);
        } else if (f.type === 'token') {
          /* 只读展示：PUT /config 会忽略 security.token（写了也是假保存），
           * 令牌只能通过「重置令牌」重新生成；点「显示」时才向服务端要一次真实值。 */
          input = el('input', {
            type: 'password', class: 'mono', 'data-cfg': f.k, readonly: true,
            value: (state.cfg.revealed ? (val || '') : ''),
            placeholder: state.cfg.revealed ? '（未设置）' : '（已设置，点「显示」查看）'
          });
          var eye = el('button', {
            class: 'btn btn-xs', type: 'button', text: '显示',
            onclick: function () {
              if (!state.cfg.revealed) { revealTokenNode(); return; }
              if (input.type === 'password') { input.type = 'text'; eye.textContent = '隐藏'; }
              else { input.type = 'password'; eye.textContent = '显示'; }
            }
          });
          var cp = el('button', {
            class: 'btn btn-xs', type: 'button', text: '复制',
            onclick: function () {
              if (!input.value) { toast('请先点「显示」加载当前令牌，再复制', 'warn'); return; }
              copyText(input.value, '令牌');
            }
          });
          var reset = el('button', {
            class: 'btn btn-xs btn-danger', type: 'button', text: '重置令牌',
            onclick: function () { regenToken(); }
          });
          var revealTokenNode = function () {
            api('/config?reveal=1', { timeout: 30000 }).then(function (d) {
              var tk = getPath(d.config || {}, 'security.token') || '';
              state.cfg.raw.security = state.cfg.raw.security || {};
              state.cfg.raw.security.token = tk;
              state.cfg.revealed = true;
              input.value = tk; input.type = 'text'; input.placeholder = '（未设置）';
              eye.textContent = '隐藏';
              var ro = $('#token-ro'); if (ro) ro.value = tk || '—';
              toast(tk ? '已显示当前令牌' : '当前未设置令牌', tk ? 'ok' : 'warn');
            }, function (e) { handleErr(e); });
          };
          item.appendChild(el('label', { text: f.label }));
          item.appendChild(el('div', { class: 'row-inline' }, [input, eye, cp, reset]));
          item.appendChild(el('p', { class: 'hint', text: '令牌只能通过「重置令牌」修改；未显示时无法复制（先点「显示」加载当前令牌）。' }));
        } else if (f.type === 'number') {
          input = el('input', { type: 'number', class: 'mono', 'data-cfg': f.k, value: val === undefined || val === null ? '' : String(val) });
          item.appendChild(el('label', { text: f.label }));
          item.appendChild(input);
        } else {
          input = el('input', { type: 'text', 'data-cfg': f.k, value: val === undefined || val === null ? '' : String(val) });
          item.appendChild(el('label', { text: f.label }));
          item.appendChild(input);
        }
        if (f.hint) item.appendChild(el('p', { class: 'hint', text: f.hint }));
        item.appendChild(el('label', { style: 'font-family:var(--mono);font-size:9.5px;color:var(--txt-faint)', text: f.k }));
        grid.appendChild(item);
      });
      host.appendChild(el('div', { class: 'cfg-group' }, [
        el('div', { class: 'cfg-group-head' }, [el('span', { text: g.title }), el('em', { text: g.en })]),
        grid
      ]));
    });
  }

  function collectConfigDiff() {
    var payload = {}, host = $('#cfg-form');
    if (!host) return payload;
    $$('[data-cfg]', host).forEach(function (input) {
      var key = input.getAttribute('data-cfg');
      /* 令牌框是只读的，且后端 PUT /config 会忽略 security.token（写了也不生效、还会提示假保存），
       * 所以既不上报该字段，也不参与 diff；改令牌只能走「重置令牌」。 */
      if (key === 'security.token') return;
      var orig = getPath(state.cfg.baseline || {}, key);
      var val;
      if (input.type === 'checkbox') val = !!input.checked;
      else if (input.type === 'number') val = input.value === '' ? null : Number(input.value);
      else val = input.value;
      if (input.type === 'number' && val !== null && isNaN(val)) { toast('「' + key + '」需要是数字', 'warn'); return; }
      if (val !== orig) setPath(payload, key, val);
    });
    return payload;
  }

  function saveConfig(btn) {
    var payload = collectConfigDiff();
    if (!Object.keys(payload).length) { toast('没有检测到改动', 'warn'); return; }
    btnBusy(btn, true, '保存中');
    setText('cfg-status', '正在保存…');
    api('/config', { method: 'PUT', body: payload, timeout: 60000 }).then(function (d) {
      btnBusy(btn, false);
      state.cfg.raw = d.config || state.cfg.raw;
      state.cfg.baseline = JSON.parse(JSON.stringify(state.cfg.raw));
      state.cfg.revealed = false;   // 保存后返回的令牌是掩码，回到「未显示」状态，避免把掩码当令牌展示/复制
      paintConfig();
      /* 是否需要重启：以「进程实际监听」对比「刚保存的配置」为准（d.restartRequired 只表示本次改动含 ip/port，
         若改回当前监听值就等于不需要重启），提示语与横幅保持同一判据 */
      syncRestartBanner();
      var need = !(($('#cfg-restart') || {}).hidden);
      setText('cfg-status', need ? '已保存，需要重启服务' : '已保存并生效');
      if (need) toast('配置已保存，部分改动需重启服务后生效', 'warn', 7000);
      else toast('配置已保存并生效', 'ok');
      loadSession().then(syncRestartBanner).catch(function () {});
    }, function (e) { btnBusy(btn, false); setText('cfg-status', '保存失败：' + e.message); handleErr(e); });
  }

  function regenToken() {
    confirmBox({
      title: '重新生成令牌', danger: true, confirmText: '生成新令牌',
      message: '确定重新生成访问令牌？',
      detail: '旧令牌立即失效，所有使用旧令牌的客户端需要更新 .npmrc。'
    }).then(function (ok) {
      if (!ok) return;
      api('/token/regenerate', { method: 'POST', timeout: 30000 }).then(function (d) {
        var tk = d.token || '';
        setToken(tk);
        var ro = $('#token-ro');
        if (ro) ro.value = tk;
        toast('新令牌已生成，并已更新本控制台令牌', 'ok', 8000);
        loadConfig(true);
        loadSession().catch(function () {});
      }, function (e) { handleErr(e); });
    });
  }

  function loadNpmrc() {
    var ov = state.overview || {}, listen = ov.listen || {};
    var ipEl = $('#npmrc-ip'), portEl = $('#npmrc-port');
    var ip = (ipEl && ipEl.value.trim()) || (listen.ip === '0.0.0.0' && ov.lanUrls && ov.lanUrls[0] ? '127.0.0.1' : (listen.ip || '127.0.0.1'));
    var port = (portEl && portEl.value.trim()) || String(listen.port || 4873);
    var useToken = $('#npmrc-token') ? $('#npmrc-token').checked : true;
    api('/npmrc', { method: 'POST', body: { ip: ip, port: Number(port) || 4873, token: !!useToken }, timeout: 30000 }).then(function (d) {
      setText('npmrc-text', d.npmrc || '—');
      setText('npmrc-cmds', (d.commands || []).join('\n') || '—');
      setText('npmrc-proj', d.projectNpmrc || '—');
      if (ipEl && !ipEl.value) ipEl.value = ip;
      if (portEl && !portEl.value) portEl.value = port;
      toast('已生成客户端接入配置', 'ok');
    }, function (e) { handleErr(e); });
  }

  /* ============================================================
   * 5. 日志
   * ============================================================ */
  function logLine(line) {
    var s = String(line == null ? '' : line);
    var lm = /(debug|info|warn|warning|error|fatal)/i.exec(s);
    var lv = lm ? lm[1].toLowerCase().replace('warning', 'warn') : '';
    var row = el('span', { class: 'log-line' + (lv ? ' lv-' + lv : '') });
    /* 时间戳前缀着色 */
    var tm = /^(\[?[\d]{4}-[\d]{2}-[\d]{2}[T ][\d:.]+Z?\]?|\[?[\d]{2}:[\d]{2}:[\d]{2}\]?)\s*/.exec(s);
    if (tm) {
      row.appendChild(el('span', { class: 'ts', text: tm[1] + ' ' }));
      s = s.slice(tm[0].length);
      if (lm) lm.index -= tm[0].length;
    }
    if (lm && lm.index >= 0) {
      var len = lm[0].length;
      row.appendChild(document.createTextNode(s.slice(0, lm.index)));
      row.appendChild(el('span', { class: 'lv', text: s.substr(lm.index, len) }));
      row.appendChild(document.createTextNode(s.slice(lm.index + len)));
    } else row.appendChild(document.createTextNode(s));
    return row;
  }

  function loadLogs(silent) {
    var linesEl = $('#log-lines'), levelEl = $('#log-level');
    var n = linesEl ? linesEl.value : '200';
    var lv = levelEl ? levelEl.value : (state.logs.level || '');
    state.logs.level = lv;
    return api('/logs?lines=' + encodeURIComponent(n) + '&level=' + encodeURIComponent(lv), { timeout: 30000 }).then(function (d) {
      state.logs.lines = d.lines || [];
      var view = clear($('#log-view'));
      if (view) {
        if (!state.logs.lines.length) view.appendChild(el('span', { class: 'muted', text: '暂无日志' }));
        else state.logs.lines.forEach(function (l) { view.appendChild(logLine(l)); });
        if ($('#log-follow') && $('#log-follow').checked) view.scrollTop = view.scrollHeight;
      }
      setText('log-meta', '文件 ' + (d.file || '—') + ' · ' + fmtBytes(d.sizeBytes) + ' · 显示 ' + state.logs.lines.length + ' 行 · ' + dtShort(new Date()));
    }, function (e) { handleErr(e, silent); }).catch(function () {});
  }

  /* ============================================================
   * 6. 服务
   * ============================================================ */
  function loadService() {
    return (state.overview ? Promise.resolve(state.overview) : api('/overview')).then(function (d) {
      state.overview = d;
      paintService(d);
      paintOverviewLite(d);
    }, function (e) { handleErr(e); }).catch(function () {});
  }

  function paintOverviewLite(d) {
    paintModeChip(d.mode);
    setText('chip-uptime', '运行 ' + fmtDur(d.uptimeSec));
    if (d.version) setText('chip-version', 'v' + d.version);
  }

  function paintService(d) {
    var box = clear($('#svc-stats'));
    if (box) {
      box.appendChild(statCard('服务状态', 'STATUS', '运行中', null, 'PID ' + (d.pid || '—'), 'is-cy'));
      box.appendChild(statCard('运行时长', 'UPTIME', fmtDur(d.uptimeSec), null, '启动于 ' + dtShort(d.startedAt)));
      box.appendChild(statCard('监听端口', 'PORT', String((d.listen && d.listen.port) || '—'), null, 'IP ' + ((d.listen && d.listen.ip) || '—'), 'is-am'));
      box.appendChild(statCard('镜像包数', 'PACKAGES', fmtNum(d.stats && d.stats.packages), null, '版本 ' + fmtNum(d.stats && d.stats.versions)));
    }
    var info = clear($('#svc-info'));
    if (info) {
      [
        ['状态', '运行中'],
        ['PID', d.pid || '—'],
        ['版本', d.version || '—'],
        ['模式', d.mode || '—'],
        ['监听', ((d.listen && d.listen.ip) || '?') + ':' + ((d.listen && d.listen.port) || '?')],
        ['Registry', d.registryUrl || '—'],
        ['启动时间', dt(d.startedAt)],
        ['配置文件', d.configPath || '—'],
        ['Node', (d.node && d.node.version) || '—'],
        ['平台', (d.node && d.node.platform) || '—']
      ].forEach(function (kv) { info.appendChild(kvRow(kv[0], kv[1])); });
    }
  }

  function serviceAction(kind) {
    if (kind === 'open') {
      var url = (state.overview && state.overview.registryUrl) || (location.origin + '/');
      window.open(url, '_blank');
      toast('已打开 ' + url, 'ok');
      return;
    }
    var isStop = kind === 'shutdown';
    confirmBox({
      title: isStop ? '停止服务' : '重启服务',
      danger: isStop,
      confirmText: isStop ? '停止服务' : '立即重启',
      message: isStop ? '确定要停止镜像源服务吗？' : '确定要重启镜像源服务吗？',
      detail: isStop ? '停止后需要手动重新启动服务，所有客户端将无法安装依赖。' : '重启期间服务会短暂不可用（通常几秒）。'
    }).then(function (ok) {
      if (!ok) return;
      setText('svc-status', isStop ? '正在停止…' : '正在重启…');
      api('/service/' + (isStop ? 'shutdown' : 'restart'), { method: 'POST', timeout: 20000 }).then(function () {
        watchService(isStop);
      }, function (e) {
        /* 重启时连接被切断是正常现象 */
        if (!isStop && (e.code === 'NETWORK' || e.code === 'TIMEOUT')) watchService(false);
        else { setText('svc-status', '操作失败：' + e.message); handleErr(e); }
      });
    });
  }

  function watchService(isStop) {
    var ov = el('div', { class: 'overlay' }, [
      el('div', { class: 'spinner-lg' }),
      el('h2', { text: isStop ? '服务已停止' : '服务正在重启' }),
      el('p', { id: 'watch-msg', text: isStop ? '进程已退出。请在本机重新启动镜像源服务，然后点击下方按钮。' : '等待服务重新监听端口，通常几秒钟…' }),
      el('div', { class: 'dots', text: '· · ·' }),
      isStop ? el('button', { class: 'btn', type: 'button', text: '重新连接', onclick: function () { tryReconnect(false); } }) : null
    ]);
    document.body.appendChild(ov);
    var t0 = Date.now();
    var timer = setInterval(function () {
      fetch(API + '/session', { cache: 'no-store', headers: getToken() ? { 'X-Mirror-Token': getToken() } : {} })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (j) {
          if (j && j.ok) {
            clearInterval(timer);
            if (ov.parentNode) ov.parentNode.removeChild(ov);
            toast(isStop ? '服务已恢复响应' : '服务重启完成', 'ok');
            state.overview = null;
            setText('svc-status', '服务已就绪（' + dtShort(new Date()) + '）');
            loadSession().catch(function () {});
            /* 重启完成：实际监听已与配置一致，收起“需重启”横幅；若正停在配置页则刷新表单 */
            syncRestartBanner();
            if (state.page === 'config') loadConfig(state.cfg.revealed).catch(function () {});
            loadService();
          }
        }, function () { /* 还在重启 */ });
      if (!isStop && Date.now() - t0 > 90000) {
        clearInterval(timer);
        var msg = $('#watch-msg');
        if (msg) msg.textContent = '等待超过 90 秒仍未响应，请检查服务进程与端口占用，然后点「重新连接」。';
        ov.appendChild(el('button', { class: 'btn', type: 'button', text: '重新连接', onclick: function () { tryReconnect(false); } }));
      }
    }, 2000);
  }

  function tryReconnect() {
    toast('正在重新连接服务…', 'info');
    loadSession().then(function () {
      toast('已重新连接到服务', 'ok');
      loadService();
    }, function () { toast('仍然无法连接服务，请确认进程已启动', 'err'); });
  }

  /* ============================================================
   * 事件绑定
   * ============================================================ */
  function bindGlobal() {
    /* 导航 */
    $$('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-page')); });
    });

    /* 令牌按钮 */
    var tb = $('#btn-token');
    if (tb) tb.addEventListener('click', function () { openTokenModal(getToken() ? '当前已保存令牌，可修改或清空。' : '本机回环地址默认免鉴权；如需远程访问，请填写令牌。'); });

    /* 复制（委托） */
    document.addEventListener('click', function (ev) {
      var c = ev.target.closest ? ev.target.closest('[data-copy-target]') : null;
      if (!c) return;
      var t = document.getElementById(c.getAttribute('data-copy-target'));
      if (t) copyText(t.value !== undefined ? t.value : t.textContent, '内容');
    });

    /* 概览 */
    on('ov-refresh', 'click', function () { loadOverview(); toast('已刷新概览', 'ok', 1800); });
    var acts = $('#ov-actions');
    if (acts) acts.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!b) return;
      var a = b.getAttribute('data-act');
      if (a === 'add') { go('packages'); addPackagesModal(''); }
      else if (a === 'upload') { go('packages'); uploadModal(); }
      else if (a === 'export') { go('migrate'); }
      else if (a === 'scan') { go('migrate'); setTimeout(runScan, 80); }
    });

    /* 包管理 */
    on('pkg-refresh', 'click', function () { loadPackages(); toast('已刷新包列表', 'ok', 1600); });
    on('pkg-add', 'click', function () { addPackagesModal(''); });
    on('pkg-upload', 'click', function () { uploadModal(); });
    on('pkg-q', 'input', debounce(function () { state.pkg.q = $('#pkg-q').value.trim(); state.pkg.page = 1; loadPackages(); }, 340));
    on('pkg-q', 'keydown', function (ev) { if (ev.key === 'Enter') { state.pkg.q = $('#pkg-q').value.trim(); state.pkg.page = 1; loadPackages(); } });
    on('pkg-source', 'change', function () { state.pkg.source = $('#pkg-source').value; state.pkg.page = 1; loadPackages(); });
    /* 快捷筛选「缺 tarball / 不缺 tarball」：点一下筛选，再点同一个回到全部（两个按钮互斥高亮） */
    on('pkg-tb', 'click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-tb]') : null;
      if (!b) return;
      var v = b.getAttribute('data-tb');
      state.pkg.tarballs = state.pkg.tarballs === v ? 'all' : v;
      state.pkg.page = 1;
      loadPackages();
    });
    on('pkg-sort', 'change', function () { state.pkg.sort = $('#pkg-sort').value; state.pkg.page = 1; loadPackages(); });
    on('pkg-size', 'change', function () { state.pkg.size = Number($('#pkg-size').value) || 20; state.pkg.page = 1; loadPackages(); });
    on('pkg-chk-all', 'change', function () {
      var on = $('#pkg-chk-all').checked;
      state.pkg.items.forEach(function (i) { if (on) state.pkg.selected[i.name] = true; else delete state.pkg.selected[i.name]; });
      paintPackages();
    });
    on('pkg-sel-clear', 'click', function () { state.pkg.selected = {}; paintPackages(); });
    on('pkg-del-sel', 'click', batchDelete);
    on('pkg-export-sel', 'click', exportSelected);
    on('pkg-fill-tarball', 'click', fillTarballs);
    on('pkg-fill-tags-all', 'click', function () { fillAllTarballs('tags'); });
    on('pkg-fill-latest-all', 'click', function () { fillAllTarballs('latest'); });
    on('pkg-fill-all-all', 'click', function () { fillAllTarballs('all'); });
    on('pkg-fill-conc', 'change', function () {
      var e = $('#pkg-fill-conc');
      var v = Number(e && e.value);
      if (!isFinite(v) || v < 1) { if (e) e.value = ''; toast('并发数已改回用配置页的值', 'info'); return; }
      v = Math.max(1, Math.min(32, Math.round(v)));
      if (e) e.value = String(v);
      api('/config', { method: 'PUT', body: { upstream: { concurrency: v } } }).then(function () {
        if (state.cfg && state.cfg.raw && state.cfg.raw.upstream) state.cfg.raw.upstream.concurrency = v;
        toast('并发下载数已保存为 ' + v + '（下次补 tarball 生效）', 'ok');
      }, function (e2) { handleErr(e2); });
    });

    var tbody = $('#pkg-tbody');
    if (tbody) {
      tbody.addEventListener('change', function (ev) {
        var t = ev.target;
        if (t && t.getAttribute && t.getAttribute('data-name')) toggleSelect(t.getAttribute('data-name'), t.checked);
      });
      tbody.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!b) return;
        var act = b.getAttribute('data-act'), name = b.getAttribute('data-name');
        if (act === 'detail') openDetail(name);
        else if (act === 'del') delPackage(name);
        else if (act === 'deprecate') deprecateModal(name, null);
      });
    }

    /* 迁移 */
    on('mig-refresh', 'click', function () { loadBundles(); toast('已刷新 bundle 列表', 'ok', 1600); });
    var segbar = $('#exp-scope');
    if (segbar) segbar.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-scope]') : null;
      if (!b) return;
      $$('.seg', segbar).forEach(function (s) { s.classList.toggle('is-on', s === b); });
      state.mig.scope = b.getAttribute('data-scope');
      var row = $('#exp-selected-row');
      if (row) row.hidden = state.mig.scope !== 'selected';
      var drow = $('#exp-deps-row');
      if (drow) drow.hidden = state.mig.scope !== 'selected';
      var arow = $('#exp-added-row');
      if (arow) arow.hidden = state.mig.scope !== 'added';
      paintSelbar();
    });
    on('exp-run', 'click', function () {
      var scope = state.mig.scope;
      var payload = { scope: scope };
      var nm = ($('#exp-name') && $('#exp-name').value || '').trim();
      if (nm) payload.name = nm;
      var addedLabel = '';
      if (scope === 'selected') {
        var names = selectedNames();
        if (!names.length) { toast('请先在「包管理」页勾选要导出的包', 'warn'); return; }
        payload.names = names;
        var wd = $('#exp-with-deps');
        payload.withDeps = !(wd && wd.checked === false);
        var af = $('#exp-auto-fetch');
        payload.autoFetchDeps = !(af && af.checked === false);
      } else if (scope === 'added') {
        /* 「按添加时间」导出：datetime-local 的值是本地时间，转成毫秒再交给后端统一规范化；
         * 两端都空没有意义（等于全部），直接提示；起晚于止也拦在前端，省得白跑一趟任务。 */
        var fv = ($('#exp-added-from') && $('#exp-added-from').value || '').trim();
        var tv = ($('#exp-added-to') && $('#exp-added-to').value || '').trim();
        if (!fv && !tv) { toast('请至少填写起始或结束时间（留空一端表示不限）', 'warn'); return; }
        var fms = fv ? new Date(fv).getTime() : null;
        var tms = tv ? new Date(tv).getTime() : null;
        if ((fms !== null && !isFinite(fms)) || (tms !== null && !isFinite(tms))) { toast('添加时间格式不正确，请重新选择', 'warn'); return; }
        if (fms !== null && tms !== null && fms > tms) { toast('起始时间不能晚于结束时间', 'warn'); return; }
        payload.addedFrom = fms !== null ? new Date(fms).toISOString() : null;
        payload.addedTo = tms !== null ? new Date(tms).toISOString() : null;
        addedLabel = (fv || '不限') + ' ~ ' + (tv || '不限');
      }
      var btn = $('#exp-run');
      if (addedLabel) setText('exp-status', '正在挑选添加时间在 ' + addedLabel + ' 之间的包并打包，包较多时可能耗时较久…');
      else setText('exp-status', payload.withDeps ? '正在打包（含递归依赖），包较多时可能耗时较久…' : '正在打包，包较多时可能耗时较久…');
      runBundleExport(payload, btn);
    });
    on('imp-run-file', 'click', function () { importBundleFile($('#imp-file') ? $('#imp-file').value : ''); });
    on('imp-pick', 'click', function (ev) { ev.stopPropagation(); var i = $('#imp-input'); if (i) i.click(); });
    on('imp-input', 'change', function () { var i = $('#imp-input'); if (i.files && i.files[0]) importBundleUpload(i.files[0]); i.value = ''; });
    var drop = $('#imp-drop');
    if (drop) {
      drop.addEventListener('click', function () { var i = $('#imp-input'); if (i) i.click(); });
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.add('is-over'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); if (ev === 'dragleave') drop.classList.remove('is-over'); });
      });
      drop.addEventListener('drop', function (e) {
        drop.classList.remove('is-over');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) importBundleUpload(f);
      });
    }
    on('scan-run', 'click', runScan);
    on('scan-import', 'click', function () { importScan('sel'); });
    on('scan-import-new', 'click', function () { importScan('new'); });
    on('scan-import-all', 'click', function () { importScan('all'); });
    on('scan-filter', 'input', debounce(paintScan, 200));
    on('scan-chk-all', 'change', function () {
      var on = $('#scan-chk-all').checked;
      var flt = ($('#scan-filter') && $('#scan-filter').value || '').trim().toLowerCase();
      ((state.mig.scan && state.mig.scan.packages) || []).forEach(function (p) {
        if (flt && String(p.name || '').toLowerCase().indexOf(flt) < 0) return;
        var k = p.name + '@' + p.version;
        if (on) state.mig.scanSel[k] = true; else delete state.mig.scanSel[k];
      });
      paintScan();
    });
    var scanTb = $('#scan-tbody');
    if (scanTb) scanTb.addEventListener('change', function (ev) {
      var t = ev.target, k = t && t.getAttribute && t.getAttribute('data-scan');
      if (!k) return;
      if (t.checked) state.mig.scanSel[k] = true; else delete state.mig.scanSel[k];
      var row = t.closest ? t.closest('tr') : null;
      if (row) row.classList.toggle('is-selected', t.checked);
      paintScan();
    });

    /* 配置 */
    on('cfg-reload', 'click', function () { loadConfig(state.cfg.revealed); toast('已重新载入配置', 'ok', 1600); });
    on('cfg-save', 'click', function () { saveConfig(this); });
    on('cfg-save-2', 'click', function () { saveConfig(this); });
    on('cfg-restart-now', 'click', function () { serviceAction('restart'); });
    on('npmrc-run', 'click', loadNpmrc);
    on('token-regen', 'click', regenToken);

    /* 日志 */
    on('log-refresh', 'click', function () { loadLogs(); toast('已刷新日志', 'ok', 1500); });
    on('log-lines', 'change', function () { loadLogs(); });
    on('log-level', 'change', function () { loadLogs(); });
    on('log-follow', 'change', function () {
      if ($('#log-follow').checked) { loadLogs(); if (!state.timers.logs) startPoll('logs', loadLogs, POLL_LOGS); }
      else stopPoll('logs');
    });
    on('log-download', 'click', function () {
      var text = state.logs.lines.join('\r\n');
      if (!text) { toast('没有可下载的日志', 'warn'); return; }
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: 'mirror-logs-' + nowStamp() + '.txt' });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('日志已下载', 'ok');
    });
    on('log-clear', 'click', function () {
      confirmBox({ title: '清空日志', danger: true, confirmText: '清空', message: '确定清空日志文件？', detail: '清空后无法恢复。' }).then(function (ok) {
        if (!ok) return;
        api('/logs', { method: 'DELETE' }).then(function () {
          toast('日志已清空', 'ok');
          loadLogs();
        }, function (e) { handleErr(e); });
      });
    });

    /* 服务 */
    on('svc-refresh', 'click', function () { state.overview = null; loadService(); toast('已刷新服务状态', 'ok', 1600); });
    var sva = $('#view-service');
    if (sva) sva.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!b) return;
      serviceAction(b.getAttribute('data-act'));
    });

    /* 标签页可见性：暂停轮询 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { state.paused = true; stopAllPolls(); }
      else { state.paused = false; resumePolls(); }
    });

    /* hash 变化（浏览器前进/后退） */
    window.addEventListener('hashchange', function () {
      var p = (location.hash || '').replace(/^#\/?/, '');
      if (p && p !== state.page && PAGES.indexOf(p) >= 0) go(p);
    });
  }

  function on(id, ev, fn) { var n = document.getElementById(id); if (n) n.addEventListener(ev, fn); }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  function consumeUrlToken() {
    var href = location.href, idx = href.indexOf('token=');
    if (idx < 0) return false;
    try {
      var url = new URL(href);
      var t = url.searchParams.get('token');
      if (!t) return false;
      setToken(t);
      url.searchParams.delete('token');
      var qs = url.searchParams.toString();
      history.replaceState(null, '', url.pathname + (qs ? '?' + qs : '') + url.hash);
      toast('已从地址栏读取并保存访问令牌', 'ok');
      return true;
    } catch (e) { return false; }
  }

  function init() {
    consumeUrlToken();
    startClock();
    bindGlobal();
    /* 静态的容器框（面板 / 统计卡）在页面加载后统一铺上背景动效；
     * 弹窗与抽屉在创建时由 modal()/openDetail() 自己插。 */
    $$('.panel,.stat').forEach(decorateFx);

    /* 恢复最后一次筛选状态 */
    if ($('#pkg-size')) state.pkg.size = Number($('#pkg-size').value) || 20;

    var p = (location.hash || '').replace(/^#\/?/, '');
    go(PAGES.indexOf(p) >= 0 ? p : 'overview');

    loadSession().catch(function () {});
    /* 补 tarball 的并发数输入框：开机后拉一次配置填进去 */
    api('/config', { timeout: 15000 }).then(function (d) {
      state.cfg.raw = d.config || {};
      state.cfg.path = d.path || '—';
      syncFillConc();
    }, function () { /* 配置页会自行提示 */ });
    /* 非概览页也需要顶栏的模式/版本/运行时长，单独拉一次 */
    if (state.page !== 'overview') {
      api('/overview', { timeout: 15000 }).then(function (d) {
        state.overview = d;
        paintOverviewLite(d);
      }, function () { /* 各页面自身会提示错误 */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
