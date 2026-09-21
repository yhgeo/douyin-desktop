// Remove the previous build output before building.
//
// Why this exists: electron-builder cannot replace an existing `dist/win-unpacked`. It writes
// `win-unpacked.tmp` and renames it over the old directory, and Windows refuses that rename
// while the old one exists (EPERM). The workaround was to move `dist` aside by hand before
// each build - which left a ~470 MB `dist.prev.<timestamp>` behind every single time. Cleaning
// first removes both the failure and the leftovers.
//
// It exits non-zero on failure on purpose: a half-deleted dist only surfaces later as a
// confusing electron-builder error, and the usual cause is the portable build still running.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', 'dist');

if (!fs.existsSync(DIST)) {
  console.log('clean-dist: 没有旧的 dist，跳过');
  process.exit(0);
}

try {
  fs.rmSync(DIST, { recursive: true, force: true });
  console.log('clean-dist: 已删除 dist/');
} catch (error) {
  console.error('clean-dist: 删除 dist/ 失败 -> ' + error.code);
  console.error('  ' + String(error.message).split('\n')[0]);
  console.error('');
  console.error('  通常是便携版或 dist/win-unpacked/抖音.exe 还在运行，占用了里面的文件。');
  console.error('  完全退出它（含后台残留进程）后，重新执行 npm run dist。');
  process.exit(1);
}
