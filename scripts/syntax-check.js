'use strict';

/**
 * `npm run check` — a fast sanity pass that needs no network:
 *   1. every .js file parses (node --check)
 *   2. every .ejs template compiles
 *   3. the SQL migration files are non-empty
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ejs = require('ejs');

const root = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', 'data', '.git']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(root);
let failures = 0;
let js = 0;
let tpl = 0;
let sql = 0;

for (const file of files) {
  const rel = path.relative(root, file);
  if (file.endsWith('.js')) {
    js += 1;
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) {
      failures += 1;
      console.error(`SYNTAX ERROR  ${rel}\n${res.stderr}`);
    }
  } else if (file.endsWith('.ejs')) {
    tpl += 1;
    try {
      ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
    } catch (err) {
      failures += 1;
      console.error(`TEMPLATE ERROR  ${rel}\n${err.message}`);
    }
  } else if (file.endsWith('.sql')) {
    sql += 1;
    if (!fs.readFileSync(file, 'utf8').trim()) {
      failures += 1;
      console.error(`EMPTY MIGRATION  ${rel}`);
    }
  }
}

console.log(`Checked ${js} JavaScript files, ${tpl} EJS templates and ${sql} SQL migrations.`);
if (failures) {
  console.error(`${failures} problem(s) found.`);
  process.exit(1);
}
console.log('All good.');
