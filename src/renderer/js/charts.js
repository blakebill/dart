'use strict';
// Theme palette + the two traffic charts: the dashboard chart (filled area +
// grid) and the sidebar sparkline (plain line), driven by one factory.
(function () {
  const App = window.App;
  const { $, fmtBytes } = App;

  // Cache chart colors so the per-second redraw doesn't call getComputedStyle.
  const palette = { border: '#222', green: '#22c55e', accent: '#3b82f6', textDim: '#98a2b3' };
  function refreshPalette() {
    const cs = getComputedStyle(document.documentElement);
    const get = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    palette.border = get('--border', '#222');
    palette.green = get('--green', '#22c55e');
    palette.accent = get('--accent', '#3b82f6');
    palette.textDim = get('--text-dim', '#98a2b3');
  }
  const AXIS_FONT = '10px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
  // Compact speed label for axes ("1.2M/s", "850K/s", "0") — narrower than the
  // full fmtBytes form, so it fits the Y gutter without clipping.
  function fmtRate(n) {
    if (n < 1) return '0';
    if (n < 1024) return Math.round(n) + 'B/s';
    const units = ['K', 'M', 'G', 'T'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n >= 10 ? Math.round(n) : n.toFixed(1)) + units[i] + '/s';
  }
  // Resolve a preference ('dark' | 'light' | 'system') to the effective theme,
  // consulting the OS for 'system'.
  function effectiveTheme(pref) {
    if (pref === 'system') {
      try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch (_) {
        return 'dark';
      }
    }
    return pref === 'light' ? 'light' : 'dark';
  }

  // Paint the resolved theme: set data-theme, refresh the chart palette, and
  // mirror the effective value to localStorage so theme-init.js can match it
  // before first paint next launch (avoids the dark→light flash).
  function paintTheme(pref) {
    const th = effectiveTheme(pref);
    try { localStorage.setItem('theme', th); } catch (e) { /* ignore */ }
    if (document.documentElement.getAttribute('data-theme') !== th) {
      document.documentElement.setAttribute('data-theme', th);
      refreshPalette();
    }
  }

  let osThemeBound = false;
  function applyTheme(theme) {
    App.themePref = theme === 'light' || theme === 'system' ? theme : 'dark';
    // Re-paint automatically when the OS light/dark setting changes, but only
    // while following the system.
    if (!osThemeBound) {
      osThemeBound = true;
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          if (App.themePref === 'system') paintTheme('system');
        });
      } catch (_) { /* matchMedia unavailable */ }
    }
    paintTheme(App.themePref);
    if (App.renderThemeLabel) App.renderThemeLabel();
  }

  function makeChart(sel, opts) {
    const canvas = $(sel);
    if (!canvas) return { push() {}, reset() {}, draw() {} };
    const ctx = canvas.getContext('2d');
    const {
      size, upEl, downEl, upTotalEl, downTotalEl,
      fill = false, lineWidth = 2, fallbackW = 0, fallbackH = 0, axes = null,
    } = opts;
    const up = new Array(size).fill(0);
    const down = new Array(size).fill(0);
    let sessionUp = 0;
    let sessionDown = 0;
    let lastUp = 0;
    let lastDown = 0;
    const pad = fill ? 8 : 2;
    const base = fill ? 4 : 1;

    // Plot rect inside the canvas. The canvas already spans the panel's content
    // width (left-aligned with the heading), so 'outer' only keeps a 2px safety
    // inset (the line stroke is 2px wide) plus room at the bottom for the time
    // labels; the speed labels are drawn as an overlay, not in a gutter.
    function plotRect(W, H) {
      if (axes === 'outer') return { x0: 2, y0: 10, x1: W - 2, y1: H - 16 };
      return { x0: 0, y0: 0, x1: W, y1: H };
    }

    function series(arr, color, p, top) {
      const w = p.x1 - p.x0;
      const h = p.y1 - p.y0;
      const stepX = w / (arr.length - 1);
      const x = (i) => p.x0 + i * stepX;
      const y = (v) => p.y1 - (v / top) * (h - pad) - base;
      if (fill) {
        ctx.beginPath();
        ctx.moveTo(x(0), y(arr[0]));
        for (let i = 1; i < arr.length; i++) ctx.lineTo(x(i), y(arr[i]));
        ctx.lineTo(p.x1, p.y1);
        ctx.lineTo(p.x0, p.y1);
        ctx.closePath();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.moveTo(x(0), y(arr[0]));
      for (let i = 1; i < arr.length; i++) ctx.lineTo(x(i), y(arr[i]));
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }

    // Outer axes: full-width gridlines with the speed labels (Y, dynamic) drawn
    // as a faint overlay just inside the left edge — no reserved gutter — and
    // time marks (X) along the bottom. A 1/s push cadence makes `size` ≈ secs.
    function drawOuterAxes(p, top) {
      ctx.font = AXIS_FONT;
      ctx.strokeStyle = palette.border;
      for (let i = 0; i <= 2; i++) {
        const f = i / 2; // 0 (top) .. 1 (bottom)
        const gy = p.y0 + (p.y1 - p.y0) * f;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x0, gy);
        ctx.lineTo(p.x1, gy);
        ctx.stroke();
        // Label sits inside the plot at the left, hugging its gridline: the top
        // one below its line, the rest above, so none clip the canvas edges.
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = palette.textDim;
        ctx.textAlign = 'left';
        ctx.textBaseline = i === 0 ? 'top' : 'bottom';
        ctx.fillText(fmtRate(top * (1 - f)), p.x0 + 3, gy + (i === 0 ? 2 : -2));
      }
      ctx.globalAlpha = 0.75;
      ctx.textBaseline = 'bottom';
      const marks = [
        [p.x0, 'left', '-' + size + 's'],
        [(p.x0 + p.x1) / 2, 'center', '-' + Math.round(size / 2) + 's'],
        [p.x1, 'right', 'now'],
      ];
      for (const [mx, align, label] of marks) {
        ctx.textAlign = align;
        ctx.fillText(label, mx, p.y1 + 14);
      }
      ctx.globalAlpha = 1;
    }

    // Inner axes: peak speed (Y reference) top-left and the time span
    // bottom-right, drawn faintly inside the plot — for the compact sparkline.
    function drawInnerAxes(p, top) {
      ctx.fillStyle = palette.textDim;
      ctx.font = '8px -apple-system, "Segoe UI", sans-serif';
      ctx.globalAlpha = 0.7;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(fmtRate(top), p.x0 + 2, p.y0 + 1);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(size + 's', p.x1 - 2, p.y1 - 1);
      ctx.globalAlpha = 1;
    }

    function isCanvasVisible() {
      return !document.hidden && (
        canvas.offsetParent !== null ||
        (typeof canvas.getClientRects === 'function' && canvas.getClientRects().length > 0)
      );
    }
    function draw() {
      if (!isCanvasVisible()) return;
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth || fallbackW;
      const H = canvas.clientHeight || fallbackH;
      if (!W) return; // tab hidden, nothing to size against
      setLabels(lastUp, lastDown);
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const p = plotRect(W, H);
      const top = Math.max(1, ...up, ...down) * 1.25; // headroom above the peak
      if (axes === 'outer') drawOuterAxes(p, top);
      series(down, palette.green, p, top);
      series(up, palette.accent, p, top);
      if (axes === 'inner') drawInnerAxes(p, top);
    }

    function setLabels(u, d) {
      if (upEl) { const e = $(upEl); if (e) e.textContent = fmtBytes(u) + '/s'; }
      if (downEl) { const e = $(downEl); if (e) e.textContent = fmtBytes(d) + '/s'; }
      if (upTotalEl) { const e = $(upTotalEl); if (e) e.textContent = fmtBytes(sessionUp); }
      if (downTotalEl) { const e = $(downTotalEl); if (e) e.textContent = fmtBytes(sessionDown); }
    }
    function push(u, d) {
      // Clash /traffic is ~1 Hz; treat each sample as one second of throughput.
      lastUp = Math.max(0, Number(u) || 0);
      lastDown = Math.max(0, Number(d) || 0);
      sessionUp += lastUp;
      sessionDown += lastDown;
      up.push(lastUp); up.shift();
      down.push(lastDown); down.shift();
      draw();
    }
    function reset() {
      up.fill(0); down.fill(0);
      sessionUp = 0;
      sessionDown = 0;
      lastUp = 0;
      lastDown = 0;
      draw();
    }
    window.addEventListener('resize', draw);
    return { push, reset, draw };
  }

  App.refreshPalette = refreshPalette;
  App.applyTheme = applyTheme;
  App.trafficChart = makeChart('#trafficChart', {
    size: 60,
    upEl: '#trafficUp',
    downEl: '#trafficDown',
    upTotalEl: '#trafficUpTotal',
    downTotalEl: '#trafficDownTotal',
    fill: true,
    axes: 'outer',
    lineWidth: 2,
    fallbackH: 120,
  });
  App.miniChart = makeChart('#miniTraffic', {
    size: 48, upEl: '#miniUp', downEl: '#miniDown', axes: 'inner', lineWidth: 1.5, fallbackW: 176, fallbackH: 40,
  });
})();
