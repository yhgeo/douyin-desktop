// Remove leftover build directories: `dist.prev.*`, `dist.stale.*`, `dist-<version>`.
//
// These are what an older build workflow left behind - `dist` had to be moved aside before
// each build, and every move left a full copy. `npm run dist` no longer does that (see
// clean-dist.js), so this only cleans up history.
//
// On Windows a file that another process holds open cannot be deleted, and a bare
// "另一个程序正在使用此文件" says nothing useful. So this reports the exact files that are
// still held, and what to do about them, instead of failing silently.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/** Sizes here are often a single 1 MB file, where "0 MB" reads as "already empty". */
const human = (bytes) => (bytes >= 1048576
  ? Math.round(bytes / 1048576) + ' MB'
  : Math.max(1, Math.round(bytes / 1024)) + ' KB');

const isStale = (name) => name.startsWith('dist.prev.')
  || name.startsWith('dist.stale.')
  || /^dist-\d/.test(name);

const sizeOf = (dir) => {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else { try { total += fs.statSync(file).size; } catch { /* raced away */ } }
    }
  };
  walk(dir);
  return total;
};

/** The files that blocked a delete, so the report can name them. */
const blocked = (dir) => {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      try { fs.renameSync(file, file + '.lockprobe'); fs.renameSync(file + '.lockprobe', file); }
      catch { out.push(path.relative(ROOT, file)); }
    }
  };
  walk(path.join(ROOT, dir));
  return out;
};

const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && isStale(entry.name))
  .map((entry) => entry.name)
  .sort();

if (dirs.length === 0) {
  console.log('clean-stale: 没有残留的构建目录');
  process.exit(0);
}

let freed = 0;
const stuck = [];

for (const dir of dirs) {
  const bytes = sizeOf(path.join(ROOT, dir));
  try {
    fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
    freed += bytes;
    console.log('  已删除 ' + dir + '  (' + human(bytes) + ')');
  } catch {
    stuck.push({ dir, files: blocked(dir) });
  }
}

if (stuck.length === 0) {
  console.log('');
  console.log('clean-stale: 全部清掉，释放 ' + human(freed));
  process.exit(0);
}

console.error('');
console.error('clean-stale: ' + stuck.length + ' 个目录没能删除：');
for (const item of stuck) {
  const size = human(sizeOf(path.join(ROOT, item.dir)));
  console.error('  ' + item.dir + '  (剩 ' + size + ')');
  for (const file of item.files) console.error('      被占用: ' + file);
}
console.error('');
console.error('  这些文件正被别的进程打开着 —— Windows 不允许删除已打开的文件，与文件权限无关。');
console.error('  它们已被 .gitignore 忽略，留着不影响使用，每个约 1 MB。');
console.error('  要彻底清掉：重启后先不要打开任何会索引该目录的程序，直接运行 npm run clean:stale。');
process.exit(1);
