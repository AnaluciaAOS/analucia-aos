// Entry point for `node --test plugins/analucia/tests`.
// Node 22+ loads a directory argument as a module (this file); Node 20 scans the directory and runs *.test.mjs itself.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(join(__dirname, f)).href);
}
