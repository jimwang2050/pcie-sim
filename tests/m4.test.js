import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('M4/版本：version.json 与 package.json 一致', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const build = JSON.parse(await readFile(new URL('version.json', root), 'utf8'));
  assert.equal(build.version, pkg.version, 'version.json 需要跟随 package.json');
  assert.ok('commit' in build);
});

test('M4/入口：index.html 只使用相对资源路径', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|data:|mailto:|#)/.test(u));
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.ok(!ref.startsWith('/'), `绝对路径会破坏子路径部署：${ref}`);
  }
  assert.ok(refs.some((r) => r.endsWith('js/main.js')), '缺少入口模块引用');
  assert.ok(refs.some((r) => r.endsWith('css/style.css')), '缺少样式引用');
});
