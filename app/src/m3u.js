'use strict';

/**
 * Parses an extended M3U playlist into raw entries.
 * Each entry: { name, url, attrs: { 'tvg-id', 'group-title', ... }, group }
 * epgUrls is every guide URL the file itself declares.
 */
function addEpgUrls(list, seen, value) {
  for (const part of String(value || '').split(',')) {
    const url = part.trim().replace(/^["']|["']$/g, '');
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    list.push(url);
  }
}

function parseM3u(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  const epgUrls = [];
  const seenEpg = new Set();
  let pending = null;
  let pendingGroup = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      const attrs = parseAttributes(line);
      addEpgUrls(epgUrls, seenEpg, attrs['url-tvg']);
      addEpgUrls(epgUrls, seenEpg, attrs['x-tvg-url']);
      continue;
    }

    const epgComment = /^#EPG:\s*(.+)$/i.exec(line);
    if (epgComment) {
      addEpgUrls(epgUrls, seenEpg, epgComment[1]);
      continue;
    }

    const looseGuide = /^(?:url-tvg|x-tvg-url)\s*=\s*(.+)$/i.exec(line);
    if (looseGuide) {
      addEpgUrls(epgUrls, seenEpg, looseGuide[1]);
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      const commaIdx = findNameComma(line);
      const head = commaIdx >= 0 ? line.slice(0, commaIdx) : line;
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
      pending = { name, attrs: parseAttributes(head) };
      pendingGroup = null;
      continue;
    }

    if (line.startsWith('#EXTGRP:')) {
      pendingGroup = line.slice(8).trim();
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pending) {
      const attrs = pending.attrs;
      entries.push({
        name: pending.name || attrs['tvg-name'] || 'Unknown',
        url: line,
        attrs,
        group: attrs['group-title'] || pendingGroup || 'Uncategorized',
      });
      pending = null;
      pendingGroup = null;
    }
  }

  return { epgUrl: epgUrls[0] || null, epgUrls, entries };
}

function parseAttributes(text) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

/** The display name follows the first comma that is outside a quoted attribute value. */
function findNameComma(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) return i;
  }
  return -1;
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'uncategorized';
}

module.exports = { parseM3u, slug };
