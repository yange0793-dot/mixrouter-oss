'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function consoleFiles() {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  return [...html.matchAll(/<script src="([^"]+)" data-console-core><\/script>/g)]
    .map(([, file]) => path.join(root, 'public', file));
}

const consoleSource = () => consoleFiles().map(file => fs.readFileSync(file, 'utf8')).join('\n');
function runConsole(context) {
  for (const file of consoleFiles()) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(context);
}

module.exports = { consoleSource, runConsole };
