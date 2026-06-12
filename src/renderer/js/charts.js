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
  function applyTheme(theme) {
    const th = theme === 'light' ? 'light' : 'dark';
    // Mirror to localStorage so theme-init.js can set it before first paint
    // on the next launch (avoids the dark→light flash).
    try { localStorage.setItem('theme', th); } catch (e) { /* ignore */ }
    if (document.documentElement.getAttribute('data-theme') === th) return;
    document.documentElement.setAttribute('data-theme', th);
    refreshPalette();
  }

  function makeChart(sel, opts) {
    const canvas = $(sel);
    if (!canvas) return { push() {}, reset() {}, draw() {} };
    const ctx = canvas.getContext('2d');
    const { size, upEl, downEl, fill = false, lineWidth = 2, fallbackW = 0, fallbackH = 0, axes = null } = opts;
    const up = new Array(size).fill(0);
    const down = new Array(size).fill(0);
    const pad = fill ? 8 : 2;
    const base = fill ? 4 : 1;

    // Plot rect inside the canvas. 'outer' axes reserve gutters for the speed
    // (Y) and time (X) labels drawn alongside the plot; otherwise the plot
    // fills the canvas (inner axes are drawn over it).
    function plotRect(W, H) {
      // Wider left gutter so speed labels never clip; right gutter keeps the
      // "now" tick and the latest point off the edge.
      if (axes === 'outer') return { x0: 58, y0: 9, x1: W - 16, y1: H - 18 };
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

    // Outer axes: gridlines with speed labels (Y, dynamic) at left and time
    // marks (X) along the bottom — a 1/s push cadence makes `size` ≈ seconds.
    function drawOuterAxes(p, top) {
      ctx.fillStyle = palette.textDim;
      ctx.font = AXIS_FONT;
      ctx.strokeStyle = palette.border;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 2; i++) {
        const f = i / 2; // 0 (top) .. 1 (bottom)
        const gy = p.y0 + (p.y1 - p.y0) * f;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x0, gy);
        ctx.lineTo(p.x1, gy);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillText(fmtRate(top * (1 - f)), p.x0 - 5, gy);
      }
      ctx.textBaseline = 'top';
      const marks = [
        [p.x0, 'left', '-' + size + 's'],
        [(p.x0 + p.x1) / 2, 'center', '-' + Math.round(size / 2) + 's'],
        [p.x1, 'right', 'now'],
      ];
      for (const [mx, align, label] of marks) {
        ctx.textAlign = align;
        ctx.fillText(label, mx, p.y1 + 4);
      }
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

    function draw() {
      if (document.hidden) return; // window in tray: skip the canvas work
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth || fallbackW;
      const H = canvas.clientHeight || fallbackH;
      if (!W) return; // tab hidden, nothing to size against
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
    }
    function push(u, d) {
      up.push(u); up.shift();
      down.push(d); down.shift();
      setLabels(u, d);
      draw();
    }
    function reset() {
      up.fill(0); down.fill(0);
      setLabels(0, 0);
      draw();
    }
    window.addEventListener('resize', draw);
    return { push, reset, draw };
  }

  App.refreshPalette = refreshPalette;
  App.applyTheme = applyTheme;
  App.trafficChart = makeChart('#trafficChart', {
    size: 60, upEl: '#trafficUp', downEl: '#trafficDown', fill: true, axes: 'outer', lineWidth: 2, fallbackH: 160,
  });
  App.miniChart = makeChart('#miniTraffic', {
    size: 48, upEl: '#miniUp', downEl: '#miniDown', axes: 'inner', lineWidth: 1.5, fallbackW: 176, fallbackH: 40,
  });
})();
