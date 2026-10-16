'use strict';
// Syntax-checks every server and browser script and compiles every EJS template, without running the app.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ejs = require('ejs');

const root = path.resolve(__dirname, '..');
const walk = (dir, ext, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out); else if (p.endsWith(ext)) out.push(p);
  }
  return out;
};
let failures = 0;
for (const f of [...walk(path.join(root, 'src'), '.js'), ...walk(path.join(root, 'public', 'js'), '.js'), ...walk(path.join(root, 'tests'), '.js'), ...walk(path.join(root, 'scripts'), '.js'), path.join(root, 'server.js')]) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { failures++; console.error(`SYNTAX ERROR ${path.relative(root, f)}\n${e.stderr}`); }
}
const templates = walk(path.join(root, 'views'), '.ejs');
for (const f of templates) {
  try { ejs.compile(fs.readFileSync(f, 'utf8'), { filename: f, views: [path.join(root, 'views')] }); } catch (e) { failures++; console.error(`TEMPLATE ERROR ${path.relative(root, f)}\n${e.message}`); }
}
console.log(failures ? `${failures} problem(s) found.` : `Syntax OK: scripts and ${templates.length} EJS templates compile.`);
process.exit(failures ? 1 : 0);
