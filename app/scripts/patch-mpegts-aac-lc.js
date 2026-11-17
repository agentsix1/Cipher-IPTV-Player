'use strict';
/**
 * mpegts.js forces HE-AAC (mp4a.40.5) on Chrome, which delays audio vs video on IPTV.
 * Patch the dist build to advertise AAC-LC like Android does.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'mpegts.js', 'dist', 'mpegts.js');
let s = fs.readFileSync(file, 'utf8');
const replacements = [
  [
    '(s=5,d=n,o=new Array(4),n>=6?d=n-3:1===l&&(s=2,o=new Array(2),d=n))',
    '(s=2,o=new Array(2),d=n)',
  ],
  [
    '(a=5,o=n,t=new Array(4),n>=6?o=n-3:1===r&&(a=2,t=new Array(2),o=n))',
    '(a=2,t=new Array(2),o=n)',
  ],
];

let total = 0;
for (const [from, to] of replacements) {
  let n = 0;
  while (s.includes(from)) {
    s = s.replace(from, to);
    n += 1;
  }
  total += n;
  console.log(from.slice(0, 24) + '…', '->', n);
}

if (!total) {
  if (s.includes('(s=2,o=new Array(2),d=n)') && s.includes('(a=2,t=new Array(2),o=n)')) {
    console.log('already patched');
    process.exit(0);
  }
  console.error('patch patterns not found');
  process.exit(1);
}

fs.writeFileSync(file, s);
console.log('patched', total, 'sites');
