'use strict';

const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '..', '..', 'dist', 'Cipher', 'data', 'player-debug.log');
const text = fs.readFileSync(logPath, 'utf8');

function decodeP(u) {
  const q = (String(u).match(/[?&]p=([^&]+)/) || [])[1] || '';
  let b = decodeURIComponent(q).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try {
    return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
  } catch (err) {
    return { err: err.message, sample: b.slice(0, 60) };
  }
}

const lines = text.split(/\r?\n/).filter((l) => l.includes('16460') && l.includes('url0'));
console.log('16460 url0 lines', lines.length);
for (const line of lines.slice(0, 4)) {
  try {
    const j = JSON.parse(line);
    console.log('tag', j.tag, 'decoded', decodeP(j.data.url0));
  } catch (err) {
    console.log('bad line', err.message);
  }
}

const opens = text.split(/\r?\n/).filter((l) => l.includes('"vlc.open"') && l.includes('xoxpl'));
console.log('vlc.open xoxpl', opens.length);
for (const line of opens.slice(-3)) {
  try {
    const j = JSON.parse(line);
    console.log('open decoded', decodeP(j.data.url));
  } catch (err) {
    console.log('bad open', err.message);
  }
}

const host = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'Cipher', 'data', 'host.log'), 'utf8');
const around = [...host.matchAll(/Stream[^\n]{0,160}/g)].slice(-30);
console.log('recent Stream lines:');
for (const m of around) console.log(m[0]);

