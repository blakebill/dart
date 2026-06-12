'use strict';
// Logs tab: batched, colorized log stream from the main process.
(function () {
  const App = window.App;
  const { $, escapeHtml } = App;
  const api = window.api;

  // Batch log lines (flush at most ~5x/s); each flush appends one <span> chunk
  // of colorized lines, so trimming drops whole chunks from the front instead of
  // re-rendering the entire log.
  // sing-box lines look like "+0800 2026-06-10 15:48:07 ERROR ..."; lines from
  // the GUI itself start with "[gui]". Anything else passes through uncolored.
  const LOG_LINE_RE =
    /^([+-]\d{4}\s+)?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\b\s*/;
  function logLineHtml(line) {
    const m = line.match(LOG_LINE_RE);
    if (m) {
      const lv = m[3] === 'WARNING' ? 'WARN' : m[3];
      const time = (m[1] || '') + m[2];
      const rest = line.slice(m[0].length);
      return (
        `<b class="log-time">${escapeHtml(time)}</b> ` +
        `<span class="log-lv ${lv.toLowerCase()}">${lv}</span> ${escapeHtml(rest)}\n`
      );
    }
    if (line.startsWith('[gui]')) {
      return `<span class="log-gui">[gui]</span>${escapeHtml(line.slice(5))}\n`;
    }
    return escapeHtml(line) + '\n';
  }
  const logBuf = [];
  let logFlushTimer = null;
  let logLen = 0; // total kept text length across chunks
  api.onLog((line) => {
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
