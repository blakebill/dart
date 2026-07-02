'use strict';
// Logs tab: batched, colorized log stream from the main process.
(function () {
  const App = window.App;
  const { $, escapeHtml } = App;
  const api = window.api;

  // Batch log lines (flush at most ~5x/s); each flush appends one <span> chunk
  // of colorized lines, so trimming drops whole chunks from the front instead of
  // re-rendering the entire log.
  // sing-box and mihomo use different log formats. Normalize the common shapes
  // so the log tab still reads like one console.
  const LOG_LINE_RE =
    /^([+-]\d{4}\s+)?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\b\s*/;
  const MIHOMO_KV_RE =
    /^time=(?:"([^"]+)"|(\S+))\s+level=(?:"?([a-z]+)"?)\s+msg=(?:"((?:[^"\\]|\\.)*)"|(.+))$/i;
  const MIHOMO_BRACKET_RE = /^(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\[(\d+)\]\s*(.*)$/i;
  const LEADING_LEVEL_RE = /^\[?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\]?\s+(.+)$/i;

  function levelName(level) {
    const lv = String(level || '').toUpperCase();
    return lv === 'WARNING' ? 'WARN' : lv;
  }

  function unescapeLogString(value) {
    return String(value || '').replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }

  function cleanLooseMessage(value) {
    return unescapeLogString(value).replace(/^"/, '').replace(/"$/, '');
  }

  function structuredLine(time, level, rest) {
    const lv = levelName(level);
    const stamp = time ? `<b class="log-time">${escapeHtml(time)}</b> ` : '';
    return stamp + `<span class="log-lv ${lv.toLowerCase()}">${lv}</span> ${escapeHtml(rest)}\n`;
  }

  function logLineHtml(line) {
    const m = line.match(LOG_LINE_RE);
    if (m) {
      const time = (m[1] || '') + m[2];
      const rest = line.slice(m[0].length);
      return structuredLine(time, m[3], rest);
    }
    const kv = line.match(MIHOMO_KV_RE);
    if (kv) {
      const time = kv[1] || kv[2] || '';
      const msg = kv[4] !== undefined ? unescapeLogString(kv[4]) : cleanLooseMessage(kv[5] || '');
      return structuredLine(time, kv[3], msg);
    }
    const bracket = line.match(MIHOMO_BRACKET_RE);
    if (bracket) {
      return structuredLine('+' + Number(bracket[2]) + 's', bracket[1], bracket[3]);
    }
    const leading = line.match(LEADING_LEVEL_RE);
    if (leading) {
      return structuredLine('', leading[1], leading[2]);
    }
    if (line.startsWith('[gui]')) {
      return `<span class="log-gui">[gui]</span>${escapeHtml(line.slice(5))}\n`;
    }
    return escapeHtml(line) + '\n';
  }
  const logBuf = [];
  let logFlushTimer = null;
  let logLen = 0; // total kept text length across chunks
  if (api && api.onLog) api.onLog((line) => {
    logBuf.push(line);
    if (logFlushTimer) return;
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null;
      const box = $('#logBox');
      let html = '';
      let len = 0;
      for (const l of logBuf) {
        html += logLineHtml(l);
        len += l.length + 1;
      }
      logBuf.length = 0;
      const chunk = document.createElement('span');
      chunk.innerHTML = html;
      chunk._len = len;
      box.appendChild(chunk);
      logLen += len;
      // Cap the kept log length by dropping the oldest chunks.
      while (logLen > 200000 && box.firstChild && box.firstChild !== chunk) {
        logLen -= box.firstChild._len || box.firstChild.textContent.length;
        box.removeChild(box.firstChild);
      }
      if ($('#logAutoScroll').checked) box.scrollTop = box.scrollHeight;
    }, 200);
  });

  $('#logClear').addEventListener('click', () => {
    $('#logBox').textContent = '';
    logLen = 0;
  });
})();
