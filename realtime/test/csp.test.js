// Guards against CSP regressions: nginx sends script-src 'self', so inline
// event-handler attributes and inline <script> blocks are blocked by browsers.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..', 'src');
const bad = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== 'vendor') walk(p); continue; }
    if (!/\.(html|js|php)$/.test(f.name)) continue;
    const t = fs.readFileSync(p, 'utf8');
    const rel = path.relative(root, p);
    if (/\son(click|change|submit|load|error|input|keydown|keyup|focus|blur)\s*=\s*["'\\]/i.test(t)) bad.push(rel + ': inline on* handler');
    if (/javascript:/i.test(t)) bad.push(rel + ': javascript: URL');
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(t) && !/\.js$/.test(f.name)) bad.push(rel + ': inline <script>');
  }
})(root);
if (bad.length) { console.error('FAIL CSP:\n' + bad.join('\n')); process.exit(1); }
console.log('PASS no inline handlers/scripts (CSP script-src \'self\' safe)');
