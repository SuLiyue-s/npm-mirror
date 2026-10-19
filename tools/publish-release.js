#!/usr/bin/env node
'use strict';

/**
 * 把桌面版单 exe 发布到 GitHub Releases（零依赖，仅用 Node 内置 https）。
 *
 * 用法：
 *   node tools/publish-release.js --check-token --token <TOKEN>
 *   node tools/publish-release.js --version 0.0.1 --file dist/npm-mirror-desktop-0.0.1.exe \
 *        [--file dist/SHA256SUMS.txt] \
 *        --token <TOKEN> [--repo SuLiyue-s/npm-mirror] [--notes "..."|--notes-file tmp/notes.md] [--draft]
 *
 * 说明：
 *   - 先按 tag v<version> 查找 Release，不存在则以 master 为基线创建；
 *   - 同名资源已存在时先删除再上传（支持重复发版）；
 *   - 上传走 uploads.github.com，流式读取文件，不整块读入内存。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_REPO = 'SuLiyue-s/npm-mirror';
const UA = 'npm-mirror-desktop-release/1.0';

function fail(code, msg) {
  console.error('[release] ' + msg);
  process.exit(code || 1);
}

function parseArgs(argv) {
  const out = { draft: false, checkToken: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--draft') out.draft = true;
    else if (a === '--check-token') out.checkToken = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) fail(1, '缺少参数值：' + a);
      if (key === 'file') {
        if (!out.files) out.files = [];
        out.files.push(val);
      } else {
        out[key] = val;
      }
      i++;
    } else {
      fail(1, '未知参数：' + a);
    }
  }
  return out;
}

function request(method, host, urlPath, token, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': UA,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    let bodyBuf = null;
    if (opts.json !== undefined) {
      bodyBuf = Buffer.from(JSON.stringify(opts.json), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = bodyBuf.length;
    }
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) headers[k] = v;
    }
    const req = https.request({ method, host, path: urlPath, headers, timeout: 120000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (e) {
          /* 非 JSON 响应 */
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function checkToken(token, repo) {
  const user = await request('GET', 'api.github.com', '/user', token);
  if (user.status === 401) fail(2, 'GitHub token 无效或已过期（HTTP 401）。');
  if (user.status !== 200) fail(2, '校验 token 失败：HTTP ' + user.status + ' ' + (user.text || '').slice(0, 300));
  console.log('[release] token 有效，账号：' + (user.json.login || '?') + (user.json.name ? '（' + user.json.name + '）' : ''));
  const scopes = user.headers['x-oauth-scopes'];
  if (scopes !== undefined) console.log('[release] token scopes：' + (scopes || '(无，可能是 Fine-grained token)'));
  if (user.headers['x-ratelimit-remaining']) {
    console.log('[release] 剩余 API 配额：' + user.headers['x-ratelimit-remaining'] + '/' + user.headers['x-ratelimit-limit']);
  }

  const repoRes = await request('GET', 'api.github.com', '/repos/' + repo, token);
  if (repoRes.status !== 200) {
    fail(2, '无权访问仓库 ' + repo + '：HTTP ' + repoRes.status + ' ' + (repoRes.text || '').slice(0, 300));
  }
  console.log('[release] 仓库可访问：' + repoRes.json.full_name + (repoRes.json.private ? '（私有）' : '（公开）'));
  const push = repoRes.json.permissions && repoRes.json.permissions.push;
  console.log('[release] 推送权限：' + (push ? '有' : '无（无法创建 Release）'));

  const rel = await request('GET', 'api.github.com', '/repos/' + repo + '/releases?per_page=1', token);
  if (rel.status === 200 && Array.isArray(rel.json) && rel.json.length) {
    console.log('[release] 最新 Release：' + rel.json[0].tag_name + '（' + rel.json[0].html_url + '）');
  } else if (rel.status === 200) {
    console.log('[release] 仓库目前还没有 Release。');
  } else {
    console.log('[release] 查询 Release 失败：HTTP ' + rel.status);
  }
  if (!push) fail(2, 'token 对仓库没有 push 权限，无法发布 Release。');
  return true;
}

async function getOrCreateRelease(token, repo, version, tag, name, body, draft) {
  const existing = await request('GET', 'api.github.com', '/repos/' + repo + '/releases/tags/' + encodeURIComponent(tag), token);
  if (existing.status === 200 && existing.json && existing.json.id) {
    console.log('[release] Release 已存在：' + tag + '（id=' + existing.json.id + '）');
    if (draft && !existing.json.draft) {
      // 已正式发布的 Release 不因 -Draft 回退为草稿
    }
    if (body) {
      const upd = await request('PATCH', 'api.github.com', '/repos/' + repo + '/releases/' + existing.json.id, token, {
        json: { name, body }
      });
      if (upd.status === 200) console.log('[release] 已更新 Release 标题与说明。');
    }
    return existing.json;
  }
  if (existing.status !== 404) {
    fail(1, '查询 Release 失败：HTTP ' + existing.status + ' ' + (existing.text || '').slice(0, 300));
  }
  const created = await request('POST', 'api.github.com', '/repos/' + repo + '/releases', token, {
    json: {
      tag_name: tag,
      target_commitish: 'master',
      name,
      body: body || ('v' + version),
      draft: !!draft,
      prerelease: false
    }
  });
  if (created.status !== 201) {
    fail(1, '创建 Release 失败：HTTP ' + created.status + ' ' + (created.text || '').slice(0, 500));
  }
  console.log('[release] 已创建 Release：' + created.json.html_url);
  return created.json;
}

async function uploadAsset(token, repo, releaseId, filePath) {
  const fileName = path.basename(filePath);
  const stat = fs.statSync(filePath);
  const size = stat.size;

  // 同名资源已存在则先删掉，保证重复发版可覆盖
  const list = await request('GET', 'api.github.com', '/repos/' + repo + '/releases/' + releaseId + '/assets?per_page=100', token);
  if (list.status === 200 && Array.isArray(list.json)) {
    for (const asset of list.json) {
      if (asset.name === fileName) {
        console.log('[release] 删除已存在的同名资源：' + fileName + '（id=' + asset.id + '）');
        const del = await request('DELETE', 'api.github.com', '/repos/' + repo + '/releases/assets/' + asset.id, token);
        if (del.status !== 204 && del.status !== 200) fail(1, '删除旧资源失败：HTTP ' + del.status);
      }
    }
  }

  const sha256 = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });

  const uploaded = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        host: 'uploads.github.com',
        path: '/repos/' + repo + '/releases/' + releaseId + '/assets?name=' + encodeURIComponent(fileName),
        headers: {
          Authorization: 'Bearer ' + token,
          'User-Agent': UA,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/octet-stream',
          'Content-Length': size
        },
        timeout: 600000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (e) {
            /* ignore */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('上传超时')));
    req.on('error', reject);
    const s = fs.createReadStream(filePath);
    s.on('error', (e) => req.destroy(e));
    s.pipe(req);
  });

  if (uploaded.status !== 201 || !uploaded.json) {
    fail(1, '上传资源失败：HTTP ' + uploaded.status + ' ' + (uploaded.text || '').slice(0, 500));
  }
  const asset = uploaded.json;
  console.log('[release] 资源上传成功：' + asset.name + '（' + (asset.size / 1048576).toFixed(2) + ' MB）');
  console.log('[release] 下载地址：' + (asset.browser_download_url || ''));
  console.log('[release] 本地 SHA256：' + sha256);
  return asset;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = args.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = args.repo || DEFAULT_REPO;
  if (!token) fail(2, '缺少 token：请用 --token 传入，或设置环境变量 GITHUB_TOKEN。');
  if (!/^[^/]+\/[^/]+$/.test(repo)) fail(1, '格式应为 owner/repo：' + repo);

  if (args.checkToken) {
    await checkToken(token, repo);
    return;
  }

  const version = args.version;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail(1, '缺少或非法 --version（应为 x.y.z）。');
  const fileList = (args.files && args.files.length)
    ? args.files.map((f) => path.resolve(f))
    : [path.resolve(__dirname, '..', 'dist', 'npm-mirror-desktop-' + version + '.exe')];
  for (const f of fileList) {
    if (!fs.existsSync(f)) fail(1, '找不到待上传文件：' + f);
  }
  const exeFile = fileList[0];
  const sizeMB = fs.statSync(exeFile).size / 1048576;
  if (sizeMB < 20) fail(1, '主程序仅 ' + sizeMB.toFixed(2) + ' MB，疑似构建异常，拒绝发布。');

  let notes = args.notes || '';
  if (args['notes-file']) {
    const nf = path.resolve(args['notes-file']);
    if (!fs.existsSync(nf)) fail(1, '找不到说明文件：' + nf);
    notes = fs.readFileSync(nf, 'utf8');
  }
  const tag = 'v' + version;
  const name = 'v' + version + ' 桌面版单 exe';

  const release = await getOrCreateRelease(token, repo, version, tag, name, notes, !!args.draft);
  const uploaded = [];
  for (const f of fileList) {
    uploaded.push(await uploadAsset(token, repo, release.id, f));
  }
  console.log('[release] 完成：' + release.html_url + '（附件 ' + uploaded.length + ' 个：' + uploaded.map((a) => a.name).join('、') + '）');
}

main().catch((e) => fail(1, '发布失败：' + (e && e.message ? e.message : e)));
