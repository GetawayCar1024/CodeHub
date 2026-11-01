// Build a release package of CodeHub with the Node.js runtime included, so nothing has to be installed.
//
//   node packaging/package.mjs windows    # dist/CodeHub-<version>-windows-x64.zip
//   node packaging/package.mjs linux      # dist/CodeHub-<version>-linux-x64.tar.gz (run on Linux)
//
// The Node.js archive is downloaded from nodejs.org (checked against SHASUMS256.txt) and cached in
// build/. Behind a proxy: set HTTPS_PROXY and NODE_USE_ENV_PROXY=1.
// The staged folder is kept in dist/ (packaging/linux/build-deb.sh builds the .deb from it).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION } from '../src/version.js';
import { createZip } from '../src/zip.js';

const NODE_VERSION = '24.22.2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (target !== 'windows' && target !== 'linux') {
  console.error('usage: node packaging/package.mjs windows|linux');
  process.exit(1);
}
const win = target === 'windows';
const nodeName = `node-v${NODE_VERSION}-${win ? 'win' : 'linux'}-x64`;
const nodeArchive = nodeName + (win ? '.zip' : '.tar.xz');
const pkgName = `CodeHub-${VERSION}-${target}-x64`;

const cache = path.join(ROOT, 'build');
const dist = path.join(ROOT, 'dist');
const stage = path.join(dist, pkgName);
fs.mkdirSync(cache, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- Node.js runtime
const base = `https://nodejs.org/dist/v${NODE_VERSION}/`;
const archive = path.join(cache, nodeArchive);
const sums = (await download(base + 'SHASUMS256.txt')).toString();
const want = sums.split('\n').find((l) => l.trim().endsWith('  ' + nodeArchive))?.split(/\s+/)[0];
if (!want) throw new Error(nodeArchive + ' not in SHASUMS256.txt');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
if (!fs.existsSync(archive) || sha(archive) !== want) {
  console.log('downloading', base + nodeArchive);
  fs.writeFileSync(archive, await download(base + nodeArchive));
  if (sha(archive) !== want) throw new Error(nodeArchive + ': checksum mismatch');
}
const extracted = path.join(cache, nodeName);
const nodeBin = path.join(extracted, win ? 'node.exe' : 'bin/node');
if (!fs.existsSync(nodeBin)) {
  // bsdtar on Windows reads zip archives as well
  execFileSync('tar', ['-xf', nodeArchive, `${nodeName}/${win ? 'node.exe' : 'bin/node'}`, `${nodeName}/LICENSE`], { cwd: cache, stdio: 'inherit' });
}

// ---- files
const copy = (rel, to = rel) => fs.cpSync(path.join(ROOT, rel), path.join(stage, to), { recursive: true });
for (const f of ['server.js', 'package.json', 'src', 'public', 'README.md', 'CHANGELOG.md', 'LICENSE']) copy(f);
fs.copyFileSync(path.join(extracted, 'LICENSE'), path.join(stage, 'LICENSE.node.txt'));

if (win) {
  fs.copyFileSync(nodeBin, path.join(stage, 'node.exe'));
  fs.writeFileSync(path.join(stage, 'start.bat'), [
    '@echo off',
    'rem Start CodeHub on port 8088, then open http://<this computer\'s IP>:8088/ in a browser (admin / 123456).',
    'rem Data is kept in the "data" folder next to this file. Other options: start.bat --port 80',
    'cd /d "%~dp0"',
    'node.exe server.js %*',
    'pause',
    '',
  ].join('\r\n'));
} else {
  fs.mkdirSync(path.join(stage, 'bin'));
  fs.copyFileSync(nodeBin, path.join(stage, 'bin/node'));
  fs.chmodSync(path.join(stage, 'bin/node'), 0o755);
  fs.writeFileSync(path.join(stage, 'codehub'), [
    '#!/bin/sh',
    '# Start CodeHub (default: port 8088, data in the "data" folder next to this file). ./codehub --help',
    'here=$(dirname "$(readlink -f "$0")")',
    'exec "$here/bin/node" "$here/server.js" "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(stage, 'codehub'), 0o755);
}

// ---- archive
function walk(dir, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), rel + e.name + '/') : [rel + e.name]);
}

let out;
if (win) {
  out = path.join(dist, pkgName + '.zip');
  const entries = walk(stage).map((f) => ({ name: pkgName + '/' + f, data: fs.readFileSync(path.join(stage, f)) }));
  fs.writeFileSync(out, createZip(entries));
} else {
  out = path.join(dist, pkgName + '.tar.gz');
  execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', out, pkgName], { cwd: dist, stdio: 'inherit' });
}
console.log(`${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
