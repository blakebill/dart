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
  const LOG_LIMIT = 120000;
  const LOG_FLUSH_LINES = 240;
  let logBuf = [];
  let logBufStart = 0;
  let logBufLen = 0;
  let logFlushTimer = null;
  let logLen = 0; // total kept text length across chunks
  let lastLogSequence = 0;
  let historyLoaded = !(api && api.getRecentLogs);
  let pendingLiveLogs = [];
  let clearGeneration = 0;

  function scheduleLogFlush(delay = 200) {
    if (logFlushTimer || document.hidden || App.currentTab !== 'logs' || logBufStart >= logBuf.length) return;
    logFlushTimer = setTimeout(flushLogs, delay);
  }

  function flushLogs() {
    logFlushTimer = null;
    if (document.hidden || App.currentTab !== 'logs' || logBufStart >= logBuf.length) return;
    const end = Math.min(logBuf.length, logBufStart + LOG_FLUSH_LINES);
    let html = '';
    let len = 0;
    for (let index = logBufStart; index < end; index++) {
      const line = logBuf[index];
      html += logLineHtml(line);
      len += line.length + 1;
    }
    logBufStart = end;
    logBufLen -= len;
    const drained = logBufStart >= logBuf.length;
    if (drained) {
      logBuf = [];
      logBufStart = 0;
      logBufLen = 0;
    } else if (logBufStart > 1000) {
      logBuf = logBuf.slice(logBufStart);
      logBufStart = 0;
    }

    const box = $('#logBox');
    const chunk = document.createElement('span');
    chunk.innerHTML = html;
    chunk._len = len;
    box.appendChild(chunk);
    logLen += len;
    while (logLen > LOG_LIMIT && box.firstChild && box.firstChild !== chunk) {
      logLen -= box.firstChild._len || box.firstChild.textContent.length;
      box.removeChild(box.firstChild);
    }
    // During history backfill, reading scrollHeight after every chunk forces a
    // full synchronous layout. Scroll once after the final chunk instead.
    if (drained && $('#logAutoScroll').checked) box.scrollTop = box.scrollHeight;
    scheduleLogFlush(16);
  }

  function enqueueLog(value) {
    const sequence = value && typeof value === 'object' ? Number(value.sequence) || 0 : 0;
    if (sequence && sequence <= lastLogSequence) return false;
    if (sequence) lastLogSequence = sequence;
    const line = String(value && typeof value === 'object' ? value.line || '' : value || '');
    logBuf.push(line);
    logBufLen += line.length + 1;
    while (logBufLen > LOG_LIMIT && logBufStart < logBuf.length) {
      logBufLen -= logBuf[logBufStart++].length + 1;
    }
    if (logBufStart > 1000 && logBufStart * 2 > logBuf.length) {
      logBuf = logBuf.slice(logBufStart);
      logBufStart = 0;
    }
    return true;
  }

  function appendLog(value) {
    if (enqueueLog(value)) scheduleLogFlush();
  }

  if (api && api.onLog) api.onLog((value) => {
    if (!historyLoaded) pendingLiveLogs.push(value);
    else appendLog(value);
  });
  if (!historyLoaded) {
    const historyGeneration = clearGeneration;
    api.getRecentLogs().then((snapshot) => {
      if (historyGeneration !== clearGeneration) return;
      for (const entry of snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : []) enqueueLog(entry);
    }).catch(() => {}).finally(() => {
      historyLoaded = true;
      for (const entry of pendingLiveLogs) enqueueLog(entry);
      pendingLiveLogs = [];
      scheduleLogFlush(0);
    });
  }

  $('#logClear').addEventListener('click', () => {
    clearGeneration++;
    if (api.clearRecentLogs) api.clearRecentLogs().catch(() => {});
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
    logBuf = [];
    logBufStart = 0;
    logBufLen = 0;
    pendingLiveLogs = [];
    $('#logBox').textContent = '';
    logLen = 0;
  });

  App.flushLogs = () => scheduleLogFlush(0);
})();
