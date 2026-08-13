'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = 'C:\\Users\\delinger\\Desktop\\dsh\\dsh-desktop\\node_modules\\@deepseek-ai';
const names = JSON.parse(fs.readFileSync(path.join(__dirname, 'missing-packages.json'), 'utf8'));
const out = {};
for (const n of names) {
  try {
    out[n] = JSON.parse(fs.readFileSync(path.join(root, n, 'package.json'), 'utf8')).version;
  } catch (e) { out[n] = 'MISSING'; }
}
console.log(JSON.stringify(out, null, 2));
