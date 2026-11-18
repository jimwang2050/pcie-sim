/**
 * 静态站点自检：子路径引用、文件存在性、模块图完整性，可选 HTTP 检查。
 *
 *   node scripts/check-site.mjs
 *   node scripts/check-site.mjs --base http://127.0.0.1:8123/pcie-sim/
 *
 * 不需要浏览器；HTTP 模式用于校验部署产物的状态码与 MIME。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1] : null;

const errors = [];
const warnings = [];
const seen = new Set();

function rel(p) {
  return path.relative(root, p).split(path.sep).join('/');
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 收集 index.html 中的本地引用。 */
function htmlRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|data:|mailto:|#)/.test(u));
}

/** 从 JS 源码里取相对模块引用。 */
function jsRefs(code) {
  return [...code.matchAll(/['"](\.[^'"]*\.js)['"]/g)].map((m) => m[1]);
}

async function walkModules(entry) {
  const queue = [entry];
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!(await exists(file))) {
      errors.push(`引用缺失：${rel(file)}`);
      continue;
    }
    const code = await readFile(file, 'utf8');
    for (const ref of jsRefs(code)) {
      queue.push(path.resolve(path.dirname(file), ref));
    }
    seen.add(rel(file));
  }
  return visited;
}

async function listJs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listJs(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const indexFile = path.join(root, 'index.html');
const html = await readFile(indexFile, 'utf8');
const refs = htmlRefs(html);

if (!refs.length) errors.push('index.html 没有本地资源引用');
for (const ref of refs) {
  if (ref.startsWith('/')) errors.push(`绝对路径会破坏子路径部署：${ref}`);
  const file = path.resolve(root, ref);
  if (!(await exists(file))) errors.push(`index.html 引用缺失：${ref}`);
  seen.add(rel(file));
}

const entry = refs.find((r) => r.endsWith('.js'));
if (!entry) errors.push('index.html 未引用入口模块');
else await walkModules(path.resolve(root, entry));

if (!(await exists(path.join(root, '.nojekyll')))) errors.push('缺少 .nojekyll（GitHub Pages 需要）');

const allJs = await listJs(path.join(root, 'js'));
for (const file of allJs) {
  if (!seen.has(rel(file))) warnings.push(`未被入口引用的模块：${rel(file)}`);
}

// 运行时不应依赖测试、文档或脚本目录
for (const ref of seen) {
  if (/^(tests|docs|scripts|browser-tests)\//.test(ref)) errors.push(`运行产物引用了非运行文件：${ref}`);
}

if (base) {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  for (const ref of seen) {
    const url = `${prefix}${ref}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      errors.push(`HTTP 请求失败：${url}（${e.message}）`);
      continue;
    }
    if (!res.ok) {
      errors.push(`HTTP ${res.status}：${url}`);
      continue;
    }
    const type = res.headers.get('content-type') || '';
    if (ref.endsWith('.js') && !/javascript/.test(type)) errors.push(`MIME 非 JS：${url} → ${type}`);
    if (ref.endsWith('.css') && !/text\/css/.test(type)) errors.push(`MIME 非 CSS：${url} → ${type}`);
  }
  try {
    const res = await fetch(prefix);
    if (!res.ok) errors.push(`HTTP ${res.status}：${prefix}`);
  } catch (e) {
    errors.push(`首页请求失败：${prefix}（${e.message}）`);
  }
}

const summary = {
  entry,
  files: seen.size,
  warnings,
  errors,
  httpChecked: Boolean(base),
};
console.log(JSON.stringify(summary, null, 2));
if (errors.length) process.exit(1);
