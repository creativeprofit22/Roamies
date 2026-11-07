// What the Roamie is doing and has done, in plain words, for the panel: "Reading notes.md" while a tool runs,
// then "Read notes.md" in the recent list. Only names a file, app or site,
// never a path, a command or what was typed.
// Either slash, whatever the OS: a Windows path must never show in full on a Mac, or the other way round.
const base = (p) => String(p ?? '').split(/[\\/]+/).filter(Boolean).at(-1) || 'a folder';
const host = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return 'a page'; } };
const short = (s, n = 28) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const appOf = (t) => { t = String(t ?? '').trim(); return !t || t === 'screen' || t === 'front' || t.startsWith('window:') ? '' : short(t, 20); };

// [while it runs, once it's done] for a tool call; null for the ones that aren't worth a line.
export function describe(name, args = {}) {
  switch (name) {
    case 'take_screenshot': { const a = appOf(args.target); return a ? [`Looking at ${a}`, `Looked at ${a}`] : ['Looking at your screen', 'Looked at your screen']; }
    case 'list_windows': return ['Checking your windows', 'Checked your windows'];
    case 'read_window': { const a = appOf(args.target); return a ? [`Reading ${a}`, `Read ${a}`] : ['Reading a window', 'Read a window']; }
    case 'act_in_app': { const a = appOf(args.target); return a ? [`Working in ${a}`, `Worked in ${a}`] : ['Working in an app', 'Worked in an app']; }
    case 'point_at': return ['Pointing it out', 'Pointed it out'];
    case 'read_file': return [`Reading ${short(base(args.path))}`, `Read ${short(base(args.path))}`];
    case 'list_files': return [`Looking in ${short(base(args.dir))}`, `Looked in ${short(base(args.dir))}`];
    case 'search_files': return ['Searching your files', 'Searched your files'];
    case 'write_file': return [`Saving ${short(base(args.path))}`, `Saved ${short(base(args.path))}`];
    case 'run_command': return ['Running a command', 'Ran a command'];
    case 'fetch_url': return [`Opening ${host(args.url)}`, `Read ${host(args.url)}`];
    case 'web_search': return ['Searching the web', 'Searched the web'];
    case 'remember_commitment': return ['Adding a reminder', 'Added a reminder'];
    case 'update_commitment': return ['Updating a reminder', 'Updated a reminder'];
    case 'remember_fact': return ['Saving to memory', 'Saved to memory'];
    case 'forget_fact': return ['Forgetting it', 'Forgot it'];
    case 'open': {
      const t = String(args.target ?? '');
      const what = /^https?:\/\//i.test(t) ? host(t) : short(base(t));
      return [`Opening ${what}`, `Opened ${what}`];
    }
    default: return null;
  }
}

// The recent list: newest first, at most `max` lines. A failed tool says so.
export function createActivity({ max = 12, now = () => Date.now() } = {}) {
  const recent = [];
  const running = new Map();
  const add = (kind, text) => { recent.unshift({ at: now(), kind, text }); recent.length = Math.min(recent.length, max); };
  return {
    recent,
    asked(text) { add('ask', short(text, 80)); },
    start(id, name, args) { const d = describe(name, args); if (d) running.set(id, d); return d?.[0] ?? null; },
    end(id, isError) { const d = running.get(id); running.delete(id); if (d) add(isError ? 'bad' : 'did', isError ? `Couldn't finish: ${d[1].charAt(0).toLowerCase()}${d[1].slice(1)}` : d[1]); },
    // What it's doing right now (the newest tool still running), or null.
    doing() { return [...running.values()].at(-1)?.[0] ?? null; },
    stopped() { running.clear(); },
  };
}
