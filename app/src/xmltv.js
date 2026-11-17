'use strict';

const { StringDecoder } = require('string_decoder');
const { getTextStream } = require('./http');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(value) {
  if (!value) return '';
  let text = value;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text);
  if (cdata) return cdata[1].trim();
  text = text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
  return text.trim();
}

/** XMLTV date "20260705183000 +0200" -> epoch ms. Without an offset the time is treated as local. */
function parseXmltvDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(value || '').trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s = '0', tz] = m;
  if (!tz) return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  const sign = tz[0] === '-' ? -1 : 1;
  const offsetMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - offsetMin * 60000;
}

function attr(head, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(head) || new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`).exec(head);
  return m ? m[1] : null;
}

function tagText(body, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? decodeXml(m[1]) : '';
}

const MAX_CHANNELS = 50000;

/**
 * Streams an XMLTV document and returns programmes grouped by channel id (lower-cased).
 * Only channels in `wantedIds` and programmes overlapping [fromMs, toMs] are kept.
 * Each programme is a compact tuple: [startMs, endMs, title, description].
 * `channels` lists every <channel> in the document ({ id, name, icon }) for EPG search.
 */
async function loadXmltv(url, { wantedIds, fromMs, toMs, userAgent, onProgress } = {}) {
  const { body, total } = await getTextStream(url, { userAgent, timeoutMs: 120000 });
  const decoder = new StringDecoder('utf8');
  const programmes = new Map();
  const channels = [];
  const seenChannels = new Set();
  let buffer = '';
  let received = 0;
  let count = 0;
  let lastReport = 0;

  const addChannel = (head, inner) => {
    const id = decodeXml(attr(head, 'id') || '');
    if (!id || seenChannels.has(id.toLowerCase()) || channels.length >= MAX_CHANNELS) return;
    seenChannels.add(id.toLowerCase());
    const icon = /<icon\s[^>]*src\s*=\s*["']([^"']+)["']/.exec(inner);
    channels.push({ id, name: tagText(inner, 'display-name') || id, icon: icon ? decodeXml(icon[1]) : '' });
  };

  const consume = () => {
    let pos = 0;
    let nextChannel = -2;
    for (;;) {
      // <channel> elements usually come first; stop looking for them once none are left in this buffer.
      if (nextChannel !== -1 && nextChannel < pos) nextChannel = buffer.indexOf('<channel', pos);
      const nextProgramme = buffer.indexOf('<programme', pos);
      const isChannel = nextChannel >= 0 && (nextProgramme < 0 || nextChannel < nextProgramme);
      const start = isChannel ? nextChannel : nextProgramme;
      if (start < 0) {
        // Keep a small tail in case a tag name is split across chunks.
        buffer = buffer.slice(Math.max(pos, buffer.length - 16));
        return;
      }
      const close = isChannel ? '</channel>' : '</programme>';
      const headEnd = buffer.indexOf('>', start);
      if (headEnd < 0) {
        buffer = buffer.slice(start);
        return;
      }
      if (isChannel && buffer[headEnd - 1] === '/') {
        addChannel(buffer.slice(start, headEnd - 1), '');
        pos = headEnd + 1;
        continue;
      }
      const end = buffer.indexOf(close, start);
      if (end < 0) {
        buffer = buffer.slice(start);
        return;
      }
      const head = buffer.slice(start, headEnd);
      const inner = buffer.slice(headEnd + 1, end);
      pos = end + close.length;

      if (isChannel) {
        addChannel(head, inner);
        continue;
      }
      const channel = (attr(head, 'channel') || '').trim().toLowerCase();
      if (!channel || (wantedIds && !wantedIds.has(channel))) continue;

      const startMs = parseXmltvDate(attr(head, 'start'));
      const endMs = parseXmltvDate(attr(head, 'stop') || attr(head, 'end'));
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      if ((fromMs && endMs < fromMs) || (toMs && startMs > toMs)) continue;

      let desc = tagText(inner, 'desc');
      if (desc.length > 600) desc = `${desc.slice(0, 597)}...`;
      const list = programmes.get(channel) || [];
      list.push([startMs, endMs, tagText(inner, 'title') || 'Untitled', desc]);
      programmes.set(channel, list);
      count++;
    }
  };

  for await (const chunk of body) {
    received += chunk.length;
    buffer += decoder.write(chunk);
    consume();
    if (onProgress && Date.now() - lastReport > 500) {
      lastReport = Date.now();
      onProgress({ received, total, count });
    }
  }
  buffer += decoder.end();
  consume();

  for (const list of programmes.values()) {
    list.sort((a, b) => a[0] - b[0]);
    // Drop overlaps that some providers emit (keep the earlier programme's slot).
    for (let i = list.length - 1; i > 0; i--) {
      if (list[i][0] === list[i - 1][0]) list.splice(i, 1);
    }
  }

  return { programmes, count, channels };
}

module.exports = { loadXmltv, parseXmltvDate, decodeXml };
