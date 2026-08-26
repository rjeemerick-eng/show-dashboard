#!/usr/bin/env node
// Audit checklist from CLAUDE.md for the single-file HTML UIs.
// Usage: node scripts/audit-html.js public/editor.html [public/display.html ...]
//   1. extract inline JS -> node --check
//   2. duplicate element IDs
//   3. duplicate function definitions
//   4. every inline on*-handler function is defined
//   5. settings-panel div balance (skipped if no settings-panel)
const fs = require('fs');
const cp = require('child_process');

let anyFail = false;

function audit(file) {
  const html = fs.readFileSync(file, 'utf8');
  let fail = 0;
  console.log('== ' + file + ' ==');

  // 1. extract inline scripts, node --check
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const js = scripts.join('\n;\n');
  const tmp = require('os').tmpdir() + '/audit-extract-' + process.pid + '.js';
  fs.writeFileSync(tmp, js);
  try {
    cp.execSync('node --check ' + JSON.stringify(tmp), { stdio: 'pipe' });
    console.log('OK  node --check');
  } catch (e) {
    fail = 1;
    console.log('FAIL node --check:\n' + e.stderr.toString());
  }
  fs.unlinkSync(tmp);

  // 2. duplicate ids (static HTML only; template-generated ids are dynamic)
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]).filter(id => !id.includes('${'));
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) { fail = 1; console.log('FAIL duplicate ids: ' + [...new Set(dup)].join(', ')); }
  else console.log('OK  no duplicate ids');

  // 3. duplicate function definitions
  const fns = [...js.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1]);
  const dupFn = fns.filter((f, i) => fns.indexOf(f) !== i);
  if (dupFn.length) { fail = 1; console.log('FAIL duplicate functions: ' + [...new Set(dupFn)].join(', ')); }
  else console.log('OK  no duplicate function definitions');

  // 4. inline handlers reference defined functions
  const defined = new Set(fns);
  [...js.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)].forEach(m => defined.add(m[1]));
  const builtins = new Set(['document','window','event','fetch','navigator','JSON','String','parseInt','setTimeout','location','Math','Number','Object','Array','console','confirm','prompt','alert','this','encodeURIComponent','decodeURIComponent','Date','URL','localStorage']);
  const handlerAttrs = [...html.matchAll(/\son(?:click|change|input|blur|keydown|error|load)="([^"]+)"/g)].map(m => m[1]);
  const missing = new Set();
  for (const h of handlerAttrs) {
    for (const m of h.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (['if','for','while','switch','catch','function','return'].includes(name)) continue;
      if (builtins.has(name)) continue;
      if (m.index > 0 && h[m.index - 1] === '.') continue; // method call
      if (!defined.has(name)) missing.add(name);
    }
  }
  if (missing.size) { fail = 1; console.log('FAIL undefined handler fns: ' + [...missing].join(', ')); }
  else console.log('OK  all inline handlers defined');

  // 5. settings-panel div balance
  const start = html.indexOf('id="settings-panel"');
  if (start !== -1) {
    const from = html.lastIndexOf('<div', start);
    let depth = 0, end = -1;
    const tag = /<\/?div\b[^>]*>/g;
    tag.lastIndex = from;
    let m;
    while ((m = tag.exec(html)) !== null) {
      depth += m[0][1] === '/' ? -1 : 1;
      if (depth === 0) { end = m.index; break; }
    }
    if (end === -1) { fail = 1; console.log('FAIL settings-panel divs never balance'); }
    else {
      const mainAt = html.indexOf('<!-- MAIN');
      if (mainAt !== -1 && end > mainAt) { fail = 1; console.log('FAIL settings-panel div closes after <!-- MAIN --> block'); }
      else console.log('OK  settings-panel div balance');
    }
  } else console.log('SKIP settings-panel not present');

  if (fail) anyFail = true;
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node scripts/audit-html.js <file.html> [...]'); process.exit(2); }
files.forEach(audit);
process.exit(anyFail ? 1 : 0);
