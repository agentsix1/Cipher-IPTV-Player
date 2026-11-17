'use strict';

function stamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function write(level, msg, err) {
  const line = `[${stamp()}] [${level}] ${msg}${err ? ` :: ${err.stack || err.message || err}` : ''}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
}

module.exports = {
  info: (msg) => write('INFO', msg),
  warn: (msg, err) => write('WARN', msg, err),
  error: (msg, err) => write('ERROR', msg, err),
};
