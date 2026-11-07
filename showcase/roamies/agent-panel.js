// The research card: when an answer comes from the web (a search or a fetched page) or turns into a list, it
// streams into this card instead of the Roamie's speech bubble, as a one-line answer, points and the sites
// it used, with full markdown (markdown.js). It opens just past the cursor and then stays put
// while the Roamie keeps following the cursor. Drag it by its top bar; later cards open where it was left.
// Real type in the setup guide's look (pixel frame, Martian Mono), scrollable, closable, links open in the browser.
// The overlay is click-through, so the host asks Roamie.panelHit(x, y) whether the cursor is over it.
// API: Roamie.panel.open({ status, near }) .status(text) .append(text) .end() .fail(text) .close() .isOpen .onLink
(() => {
  const R = window.Roamie;
  const css = `
.rp { --bg: #051214; --panel: #071a1c; --ink: #e8fffa; --ink-2: #b4d8d1; --ink-3: #8ab8b0; --accent: #78ffe2;
  --line-hi: #2f7c74; --line-hot: #4fbfa9; --s: 2px; --ease: cubic-bezier(.2, .8, .2, 1);
  --notch: polygon(
    calc(var(--s) * 2) 0, calc(100% - var(--s) * 2) 0, calc(100% - var(--s) * 2) var(--s), calc(100% - var(--s)) var(--s),
    calc(100% - var(--s)) calc(var(--s) * 2), 100% calc(var(--s) * 2), 100% calc(100% - var(--s) * 2),
    calc(100% - var(--s)) calc(100% - var(--s) * 2), calc(100% - var(--s)) calc(100% - var(--s)),
    calc(100% - var(--s) * 2) calc(100% - var(--s)), calc(100% - var(--s) * 2) 100%, calc(var(--s) * 2) 100%,
    calc(var(--s) * 2) calc(100% - var(--s)), var(--s) calc(100% - var(--s)), var(--s) calc(100% - var(--s) * 2),
    0 calc(100% - var(--s) * 2), 0 calc(var(--s) * 2), var(--s) calc(var(--s) * 2), var(--s) var(--s), calc(var(--s) * 2) var(--s));
  position: fixed; z-index: 5; width: 380px; display: flex; flex-direction: column;
  background: var(--line-hot); clip-path: var(--notch); padding: 2px; box-sizing: border-box;
  font: 400 12.5px/1.6 "Martian Mono", ui-monospace, Menlo, monospace; color: var(--ink);
  filter: drop-shadow(0 0 10px rgba(120, 255, 226, .18)) drop-shadow(0 8px 22px rgba(0, 0, 0, .45));
  opacity: 0; transform: translateX(-8px) scale(.98); transform-origin: top left;
  transition: opacity .16s var(--ease), transform .16s var(--ease); pointer-events: auto; cursor: default; }
.rp.on { opacity: 1; transform: none; }
.rp-in { background: rgba(5, 18, 20, .97); color: var(--ink); clip-path: var(--notch); display: flex; flex-direction: column; min-height: 0; flex: 1; }
.rp-head { display: flex; align-items: center; gap: 8px; padding: 9px 8px 8px 14px; border-bottom: 1px solid #12302e; cursor: grab; touch-action: none; user-select: none; }
.rp.drag .rp-head { cursor: grabbing; }
.rp.drag { transition: none; }
.rp-dot { width: 6px; height: 6px; background: var(--accent); box-shadow: 0 0 6px var(--accent); flex: none; }
.rp.busy .rp-dot { animation: rp-blink .9s steps(2, jump-none) infinite; }
.rp-status { flex: 1; font-size: 11px; line-height: 1.3; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-x { all: unset; width: 26px; height: 26px; display: grid; place-items: center; color: var(--ink-3); cursor: pointer; flex: none; }
.rp-x:hover { color: var(--ink); background: #0d2a2a; }
.rp-x:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.rp-body { overflow-y: auto; padding: 12px 16px 14px; min-height: 0; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--line-hi) transparent; }
.rp-body > :first-child { margin-top: 0; }
.rp-body p { margin: 0 0 8px; }
.rp-body p.lead { font-weight: 600; font-size: 13.5px; line-height: 1.5; color: var(--ink); margin-bottom: 10px; }
.rp-body h4 { margin: 12px 0 6px; font: 600 11px/1.3 "Martian Mono", ui-monospace, monospace; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); }
.rp-body ul, .rp-body ol { margin: 0 0 8px; padding: 0; list-style: none; }
.rp-body li { position: relative; padding-left: 16px; margin: 0 0 6px; color: var(--ink-2); }
.rp-body ul > li::before { content: ""; position: absolute; left: 2px; top: .62em; width: 5px; height: 5px; background: var(--accent); }
.rp-body ol { counter-reset: n; }
.rp-body ol > li { counter-increment: n; padding-left: 22px; }
.rp-body ol > li::before { content: counter(n) "."; position: absolute; left: 0; color: var(--accent); }
.rp-body b { color: var(--ink); font-weight: 600; }
.rp-body em { font-style: italic; color: var(--ink); }
.rp-body s { color: var(--ink-3); }
.rp-body code { font: inherit; color: var(--accent); }
.rp-body a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; cursor: pointer; }
.rp-body a:hover { color: #a8ffed; }
.rp-body a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.rp-body li > ul, .rp-body li > ol { margin: 6px 0 0; }
.rp-body blockquote { margin: 0 0 8px; padding: 2px 0 2px 12px; border-left: 2px solid var(--line-hi); color: var(--ink-2); }
.rp-body blockquote p { margin: 0 0 4px; }
.rp-body pre { margin: 0 0 10px; padding: 9px 11px; background: #030c0d; border: 1px solid #12302e; overflow-x: auto;
  font: 400 11.5px/1.55 "Martian Mono", ui-monospace, monospace; color: var(--ink-2); white-space: pre; }
.rp-body pre code { color: inherit; }
.rp-body hr { border: 0; border-top: 1px solid #12302e; margin: 10px 0; }
.rp-table { overflow-x: auto; margin: 0 0 10px; }
.rp-body table { border-collapse: collapse; font-size: 11.5px; line-height: 1.45; min-width: 100%; }
.rp-body th, .rp-body td { text-align: left; padding: 5px 9px; border-bottom: 1px solid #12302e; vertical-align: top; color: var(--ink-2); }
.rp-body th { color: var(--ink); font-weight: 600; border-bottom-color: var(--line-hi); }
.rp-src { margin: 10px 0 0; padding-top: 9px; border-top: 1px solid #12302e; font-size: 11px; line-height: 1.5; color: var(--ink-3); }
.rp-caret { display: inline-block; width: 7px; height: 1.05em; vertical-align: -0.15em; background: var(--accent); margin-left: 2px; animation: rp-blink .9s steps(2, jump-none) infinite; }
@keyframes rp-blink { 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { .rp { transform: none; transition: opacity .1s linear; } .rp.busy .rp-dot, .rp-caret { animation: none; } }
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // Model text → DOM through markdown.js, safely: elements and textContent only, never HTML.
  const mk = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const spans = (parent, list) => {
    for (const sp of list) {
      if (sp.t === 'text') parent.append(sp.s);
      else if (sp.t === 'code') { const e = mk('code'); e.textContent = sp.s; parent.append(e); }
      else if (sp.t === 'a') { const a = mk('a'); a.href = sp.href; a.title = sp.href; spans(a, sp.c); parent.append(a); }
      else { const e = mk(sp.t === 'b' ? 'b' : sp.t === 'i' ? 'em' : 's'); spans(e, sp.c); parent.append(e); }
    }
  };
  const list = (blk) => {
    const e = mk(blk.t);
    if (blk.t === 'ol' && blk.start !== 1) e.start = blk.start;
    if (blk.t === 'ol') e.style.counterReset = `n ${blk.start - 1}`;
    for (const it of blk.items) { const li = mk('li'); spans(li, it.c); if (it.sub) li.append(list(it.sub)); e.append(li); }
    return e;
  };
  const block = (blk) => {
    switch (blk.t) {
      case 'p': { const p = mk('p', blk.lead ? 'lead' : ''); spans(p, blk.c); return p; }
      case 'h': { const h = mk('h4'); spans(h, blk.c); return h; }
      case 'ul': case 'ol': return list(blk);
      case 'quote': { const q = mk('blockquote'); for (const b of blk.c) q.append(block(b)); return q; }
      case 'code': { const pre = mk('pre'), c = mk('code'); c.textContent = blk.s; pre.append(c); return pre; }
      case 'hr': return mk('hr');
      case 'src': { const p = mk('p', 'rp-src'); p.append('Sources: '); spans(p, blk.c); return p; }
      case 'table': {
        const wrapEl = mk('div', 'rp-table'), t = mk('table'), thead = mk('thead'), tb = mk('tbody'), hr = mk('tr');
        for (const c of blk.head) { const th = mk('th'); th.scope = 'col'; spans(th, c); hr.append(th); }
        thead.append(hr);
        for (const r of blk.rows) { const tr = mk('tr'); for (const c of r) { const td = mk('td'); spans(td, c); tr.append(td); } tb.append(tr); }
        t.append(thead, tb); wrapEl.append(t);
        return wrapEl;
      }
      default: return mk('div');
    }
  };
  const render = (body, text, streaming) => {
    const md = R.md;
    body.replaceChildren(...(md ? md.blocks(text).map(block) : [Object.assign(mk('p'), { textContent: text })]));
    if (streaming) {
      const caret = mk('span', 'rp-caret'); caret.setAttribute('aria-hidden', 'true');
      let host = body.lastElementChild ?? body;
      while (host.lastElementChild && /^(UL|OL|LI|BLOCKQUOTE|PRE|DIV|TABLE|TBODY|TR)$/.test(host.tagName)) host = host.lastElementChild;
      host.append(caret);
    }
  };

  let el = null, body = null, statusEl = null, text = '', streaming = false, raf = 0, closeTimer = 0, hovered = false, follow = true, drag = null;
  // Where the user last dragged it (kept between launches); otherwise it opens beside the cursor.
  const POS_KEY = 'roamies.cardPos';
  let userPos = null;
  try { userPos = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null'); } catch { userPos = null; }
  const build = () => {
    el = document.createElement('section');
    el.className = 'rp';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Answer from the web');
    const inner = document.createElement('div'); inner.className = 'rp-in';
    const head = document.createElement('div'); head.className = 'rp-head';
    const dot = document.createElement('span'); dot.className = 'rp-dot'; dot.setAttribute('aria-hidden', 'true');
    statusEl = document.createElement('span'); statusEl.className = 'rp-status'; statusEl.setAttribute('aria-live', 'polite');
    const x = document.createElement('button'); x.className = 'rp-x'; x.type = 'button'; x.setAttribute('aria-label', 'Close');
    x.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>';
    x.addEventListener('click', () => api.close());
    body = document.createElement('div'); body.className = 'rp-body';
    // Scrolling up to reread stops the auto-follow; scrolling back to the bottom resumes it.
    body.addEventListener('scroll', () => { follow = body.scrollTop + body.clientHeight >= body.scrollHeight - 8; }, { passive: true });
    head.append(dot, statusEl, x);
    // Drag it by the top bar; it stays where it's put.
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.rp-x')) return;
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      el.classList.add('drag');
      try { head.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => { if (drag) moveTo(e.clientX - drag.dx, e.clientY - drag.dy); });
    const drop = () => {
      if (!drag) return;
      drag = null; el.classList.remove('drag');
      userPos = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
      try { localStorage.setItem(POS_KEY, JSON.stringify(userPos)); } catch {}
    };
    head.addEventListener('pointerup', drop);
    head.addEventListener('pointercancel', drop);
    // Links open in the browser (through the sidecar's safety check), never inside this overlay.
    body.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      api.onLink?.(a.getAttribute('href'));
    });
    body.addEventListener('auxclick', (e) => { if (e.target.closest('a')) e.preventDefault(); });
    inner.append(head, body);
    el.append(inner);
    el.addEventListener('pointerenter', () => { hovered = true; });
    el.addEventListener('pointerleave', () => { hovered = false; });
    document.body.append(el);
  };
  const paint = () => {
    raf = 0;
    if (!el) return;
    render(body, text, streaming);
    if (follow) body.scrollTop = body.scrollHeight;
    // Growing taller must not push it off the bottom of the screen.
    if (!drag && api.isOpen) moveTo(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

  const bounds = () => { const S = R.safe ?? { top: 0, right: 0, bottom: 0, left: 0 }; return { l: S.left + 8, t: S.top + 8, r: innerWidth - S.right - 8, b: innerHeight - S.bottom - 8 }; };
  // Kept fully on screen, however tall it grows.
  const moveTo = (x, y) => {
    const B = bounds(), w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.round(Math.max(B.l, Math.min(x, B.r - w)))}px`;
    el.style.top = `${Math.round(Math.max(B.t, Math.min(y, B.b - h)))}px`;
  };
  // Where the user left it; otherwise just past the cursor and the Sidekick beside it (right of them, else left).
  const place = (near) => {
    const B = bounds(), w = el.offsetWidth;
    el.style.maxHeight = `${Math.min(B.b - B.t, 560)}px`;
    if (userPos) return moveTo(userPos.x, userPos.y);
    if (!near) return moveTo(B.l + 8, B.t + 8);
    const [cx, cy] = near.cursor, a = near.buddy;
    const right = Math.max(cx, a ? a.x + a.r : cx) + 24, left = Math.min(cx, a ? a.x - a.r : cx) - 24 - w;
    const x = right + w <= B.r ? right : left >= B.l ? left : right;
    el.style.transformOrigin = x < cx ? 'top right' : 'top left';
    moveTo(x, cy - 28);
  };

  const armClose = () => {
    clearTimeout(closeTimer);
    // Read at leisure: it stays while the cursor is on it, and goes a while after the answer is done.
    const tick = () => { if (hovered) { closeTimer = setTimeout(tick, 4000); return; } api.close(); };
    closeTimer = setTimeout(tick, 60000);
  };

  const api = {
    get isOpen() { return !!el && el.classList.contains('on'); },
    // Still looking things up or writing: the Sidekick stays out (following the cursor) until it's done.
    get working() { return api.isOpen && streaming; },
    get center() { if (!api.isOpen) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
    open({ status = 'Searching the web', near } = {}) {
      clearTimeout(closeTimer);
      if (!el) build();
      const wasOpen = api.isOpen;
      text = ''; streaming = true; follow = true;
      el.classList.add('busy');
      statusEl.textContent = status;
      paint();
      // A follow-up reuses the open card where it is.
      if (!wasOpen) place(near);
      requestAnimationFrame(() => el.classList.add('on'));
      return api;
    },
    status(s) { if (el) statusEl.textContent = s; return api; },
    append(s) { if (!el) return api; text += s; schedule(); return api; },
    end(label = 'From the web') {
      if (!el) return api;
      streaming = false; el.classList.remove('busy'); statusEl.textContent = label;
      schedule(); armClose();
      return api;
    },
    fail(msg) { if (!el) return api; text = text || msg; return api.end("Couldn't finish"); },
    close() {
      clearTimeout(closeTimer);
      if (!el || !el.classList.contains('on')) return;
      el.classList.remove('on');
      hovered = false;
    },
  };
  R.panel = api;
  R.panelHit = (x, y) => {
    if (drag) return true;
    if (!api.isOpen) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
})();
