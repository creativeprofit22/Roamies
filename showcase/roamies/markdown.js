// Markdown in the Sidekick's replies, read while it streams in (an unclosed ** or ` just waits for its pair).
//  - blocks(text): headings, paragraphs (the first is the lead), - / 1. lists with one level of nesting,
//    > quotes, ``` code, --- rules, | tables | and a closing "Sources:" line, for the research card.
//  - inline(text): **bold**, __bold__, *italic*, _italic_, ~~strike~~, `code` and [links](https://…), as spans.
//  - flat(text): one-line-at-a-time plain text plus a style per character, for the dot-grid speech bubbles,
//    which have no room for layout: markers go, bullets become •, headings turn bold.
// Pure functions (no DOM), so the sidecar tests can run them. Loaded after core.js.
(() => {
  const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

  // ---------- inline ----------
  // Spans: { t: 'text', s } | { t: 'code', s } | { t: 'b' | 'i' | 's', c: spans } | { t: 'a', href, c: spans }
  const INLINE = [
    { re: /`([^`\n]+)`/y, make: (m) => ({ t: 'code', s: m[1] }) },
    { re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y, make: (m) => (SAFE_LINK.test(m[2]) ? { t: 'a', href: m[2], c: inline(m[1]) } : { t: 'text', s: m[1] }) },
    { re: /<(https?:\/\/[^>\s]+)>/y, make: (m) => ({ t: 'a', href: m[1], c: [{ t: 'text', s: m[1] }] }) },
    { re: /\*\*(?=\S)([^\n]*?\S)\*\*/y, make: (m) => ({ t: 'b', c: inline(m[1]) }) },
    { re: /__(?=\S)([^\n]*?\S)__(?!\w)/y, make: (m) => ({ t: 'b', c: inline(m[1]) }) },
    { re: /~~(?=\S)([^\n]*?\S)~~/y, make: (m) => ({ t: 's', c: inline(m[1]) }) },
    { re: /\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/y, make: (m) => ({ t: 'i', c: inline(m[1]) }) },
    { re: /(?<![\w])_(?=\S)([^_\n]*?\S)_(?![\w])/y, make: (m) => ({ t: 'i', c: inline(m[1]) }) },
  ];
  const OPENERS = /[`[<*_~]/;
  function inline(text) {
    const out = [];
    let buf = '', i = 0;
    const flush = () => { if (buf) { out.push({ t: 'text', s: buf }); buf = ''; } };
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length && /[\\`*_~[\]()<>#|-]/.test(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }
      if (OPENERS.test(ch)) {
        let hit = null;
        for (const r of INLINE) {
          r.re.lastIndex = i;
          const m = r.re.exec(text);
          if (m) { hit = [r.make(m), m[0].length]; break; }
        }
        if (hit) { flush(); out.push(hit[0]); i += hit[1]; continue; }
      }
      buf += ch; i++;
    }
    flush();
    return out;
  }

  // ---------- blocks ----------
  const BULLET = /^(\s*)[-*+•]\s+(.*)$/, NUM = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
  const isRule = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

  function blocks(text) {
    const lines = String(text ?? '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0, lead = false;
    const para = [];
    const endPara = () => {
      if (!para.length) return;
      out.push({ t: 'p', lead: !lead, c: inline(para.join(' ')) });
      lead = true; para.length = 0;
    };
    while (i < lines.length) {
      const line = lines[i], trimmed = line.trim();
      if (!trimmed) { endPara(); i++; continue; }
      // ``` code (an unclosed fence runs to the end: it's still streaming)
      const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        endPara();
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
        i++;
        out.push({ t: 'code', lang: fence[2] || '', s: body.join('\n') });
        lead = true;
        continue;
      }
      const src = /^\**sources?\**\s*:\s*(.*)$/i.exec(trimmed);
      if (src) { endPara(); out.push({ t: 'src', c: inline(src[1]) }); i++; continue; }
      const head = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
      if (head) { endPara(); out.push({ t: 'h', level: head[1].length, c: inline(head[2]) }); lead = true; i++; continue; }
      if (isRule(line) && !BULLET.test(line)) { endPara(); out.push({ t: 'hr' }); i++; continue; }
      if (trimmed.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        endPara();
        const head = cells(line), rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
        out.push({ t: 'table', head: head.map(inline), rows: rows.map((r) => head.map((_, k) => inline(r[k] ?? ''))) });
        lead = true;
        continue;
      }
      if (/^\s*>/.test(line)) {
        endPara();
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push({ t: 'quote', c: blocks(q.join('\n')).map((b) => (b.t === 'p' ? { ...b, lead: false } : b)) });
        lead = true;
        continue;
      }
      if (BULLET.test(line) || NUM.test(line)) {
        endPara();
        const ordered = !BULLET.test(line);
        const list = { t: ordered ? 'ol' : 'ul', start: ordered ? +NUM.exec(line)[2] : 1, items: [] };
        const base = (BULLET.exec(line) ?? NUM.exec(line))[1].length;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            // A blank line inside a list: it carries on only if the next line is another item.
            const next = lines[i + 1] ?? '';
            if (BULLET.test(next) || NUM.test(next)) { i++; continue; }
            break;
          }
          const bm = BULLET.exec(l), nm = NUM.exec(l), m = bm ?? nm;
          if (m) {
            const ind = m[1].length, body = bm ? bm[2] : nm[3];
            if (ind > base + 1 && list.items.length) {
              const parent = list.items[list.items.length - 1];
              (parent.sub ??= { t: nm ? 'ol' : 'ul', start: nm ? +nm[2] : 1, items: [] }).items.push({ c: inline(body) });
            } else if ((!!nm) === ordered) list.items.push({ c: inline(body) });
            else break; // the other kind of list starts here
            i++;
            continue;
          }
          // A wrapped line belongs to the item above it.
          if (/^\s{2,}\S/.test(l) && list.items.length) { const it = list.items[list.items.length - 1]; it.c = inline(`${flatText(it.c)} ${l.trim()}`); i++; continue; }
          break;
        }
        out.push(list);
        lead = true;
        continue;
      }
      para.push(trimmed);
      i++;
    }
    endPara();
    return out;
  }

  const flatText = (spans) => spans.map((s) => (s.c ? flatText(s.c) : s.s)).join('');

  // ---------- flat (speech bubbles) ----------
  // Styles per character: bit 1 bold, 2 code, 4 italic, 8 link.
  const BOLD = 1, CODE = 2, ITAL = 4, LINK = 8;
  function flat(text) {
    let s = '';
    const sty = [];
    const put = (str, st) => { s += str; for (let k = 0; k < str.length; k++) sty.push(st); };
    const walk = (spans, st) => {
      for (const sp of spans) {
        if (sp.t === 'text') put(sp.s, st);
        else if (sp.t === 'code') put(sp.s, st | CODE);
        else if (sp.t === 'a') walk(sp.c, st | LINK);
        else walk(sp.c, st | (sp.t === 'b' ? BOLD : sp.t === 'i' ? ITAL : 0));
      }
    };
    const lines = String(text ?? '').replace(/\r/g, '').split('\n');
    let inCode = false;
    lines.forEach((raw, n) => {
      if (n) put('\n', 0);
      if (/^\s*(`{3,}|~{3,})/.test(raw)) { inCode = !inCode; s = s.replace(/\n$/, ''); sty.length = s.length; return; }
      if (inCode) { put(raw, CODE); return; }
      let line = raw, st = 0;
      const head = /^\s*#{1,6}\s+(.*?)\s*#*$/.exec(line);
      if (head) { line = head[1]; st = BOLD; }
      const bm = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bm && !head) { put(`${bm[1]}• `, 0); line = bm[2]; }
      const q = /^\s*>\s?(.*)$/.exec(line);
      if (q) line = q[1];
      if (isRule(raw) && !bm) return;
      // Streaming: a ** or ` that hasn't closed yet hides its marker and styles what follows.
      let tail = '', tailSt = 0;
      const open = pendingOpen(line);
      if (open) { tail = open.linkText ?? line.slice(open.at + open.len); tailSt = open.st; line = line.slice(0, open.at); }
      walk(inline(line), st);
      if (tail) walk(inline(tail), st | tailSt);
    });
    return { s, sty };
  }
  // The last unclosed ** / ` / [text]( in a line, if any.
  function pendingOpen(line) {
    const tick = (line.match(/`/g) ?? []).length % 2 ? line.lastIndexOf('`') : -1;
    if (tick >= 0) return { at: tick, len: 1, st: CODE };
    const stars = line.split('**').length - 1;
    if (stars % 2) { const at = line.lastIndexOf('**'); if (/\S/.test(line.slice(at + 2, at + 3) || 'x')) return { at, len: 2, st: BOLD }; }
    // A link still streaming in shows only its text.
    const link = /\[([^\]\n]+)\]\([^)]*$/.exec(line);
    if (link) return { at: link.index, len: 0, st: LINK, linkText: link[1] };
    return null;
  }
  const api = { blocks, inline, flat, text: flatText, BOLD, CODE, ITAL, LINK };
  (globalThis.Roamie ??= {}).md = api;
})();
