// Windows apps by their Start-menu name: list them once per session, match the name people say, launch it.
// Logic follows CursorTouch/Windows-MCP (MIT): Get-StartApps, AppsFolder localized names, .lnk fallback.

// No user text in here: the list is the same for every request.
export const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$apps = @()
try { $apps += Get-StartApps | ForEach-Object { [pscustomobject]@{ name = $_.Name; appId = $_.AppID } } } catch {}
try {
  $sh = New-Object -ComObject Shell.Application
  $f = $sh.NameSpace('shell:AppsFolder')
  if (-not $f) { $f = $sh.NameSpace('shell:::{4234d49b-0245-4df3-b780-3893943456e1}') }
  if ($f) { $apps += $f.Items() | ForEach-Object { [pscustomobject]@{ name = $_.Name; appId = $_.Path } } }
} catch {}
if ($apps.Count -eq 0) {
  foreach ($d in @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")) {
    try { $apps += Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk | ForEach-Object { [pscustomobject]@{ name = $_.BaseName; appId = $_.FullName; lnk = $true } } } catch {}
  }
}
ConvertTo-Json -InputObject @($apps) -Compress
`;

export function parseApps(stdout) {
  let data;
  try { data = JSON.parse(String(stdout ?? '').replace(/^\uFEFF/, '').trim() || '[]'); } catch { return []; }
  const seen = new Set(), out = [];
  for (const a of Array.isArray(data) ? data : [data]) {
    const name = String(a?.name ?? '').trim(), appId = String(a?.appId ?? '').trim();
    if (!name || !appId || seen.has(`${name}|${appId}`)) continue;
    seen.add(`${name}|${appId}`);
    out.push(a.lnk ? { name, appId, lnk: true } : { name, appId });
  }
  return out;
}

export const normalize = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// English names for built-in apps, so "Calculator" works where the Start menu says "Calculadora".
// Used only when the matching app is in the list; Settings always opens the Settings app itself.
const SETTINGS = { name: 'Settings', appId: 'ms-settings:' };
const ALIASES = [
  { names: ['calculator', 'calc'], id: /^Microsoft\.WindowsCalculator_/i },
  { names: ['microsoft store', 'store', 'windows store'], id: /^Microsoft\.WindowsStore_/i },
  { names: ['file explorer', 'explorer', 'windows explorer'], id: /^Microsoft\.Windows\.Explorer$/i },
  { names: ['notepad'], id: /^Microsoft\.WindowsNotepad_|(^|\\)notepad\.exe$/i },
  { names: ['paint', 'mspaint'], id: /^Microsoft\.Paint_|(^|\\)mspaint\.exe$/i },
  { names: ['photos'], id: /^Microsoft\.Windows\.Photos_/i },
  { names: ['terminal', 'windows terminal'], id: /^Microsoft\.WindowsTerminal/i },
  { names: ['snipping tool'], id: /^Microsoft\.ScreenSketch_|(^|\\)SnippingTool\.exe$/i },
];

// Query letters in order, each one either right after the previous match or at the start of a later word,
// and the first at a word start: "gc" → Google Chrome, "vscode" → Visual Studio Code. Pieces must be initials
// only or at most one per two letters, so "whatsapp" can't be spelled out of a long name's initials.
function wordSubsequence(q, name) {
  const letters = q.replace(/ /g, '');
  const starts = (i) => i === 0 || name[i - 1] === ' ';
  const maxPieces = Math.max(2, Math.ceil(letters.length / 2));
  // pieces: word-start jumps so far; initials: every piece so far is one letter long.
  const go = (qi, ni, pieces, initials) => {
    if (qi === letters.length) return initials || pieces <= maxPieces;
    for (let i = ni; i < name.length; i++) {
      if (name[i] !== letters[qi]) continue;
      const joined = qi > 0 && i === ni;
      if (!joined && !starts(i)) continue;
      if (go(qi + 1, i + 1, pieces + (joined ? 0 : 1), initials && !joined)) return true;
    }
    return false;
  };
  return letters.length > 0 && go(0, 0, 0, true);
}

// Lower is better; null means no match.
function tier(q, n) {
  if (!q || !n) return null;
  if (n === q) return 1;
  if (n.startsWith(q + ' ')) return 2;
  if (n.startsWith(q)) return 3;
  if (wordSubsequence(q, n)) return 4;
  const words = n.split(' ');
  if (q.split(' ').every((w) => words.some((nw) => nw.startsWith(w)))) return 5;
  return null;
}

const byRank = (a, b) => a.score - b.score || a.app.name.length - b.app.name.length || a.app.name.localeCompare(b.app.name);

export function matchApp(query, apps) {
  const q = normalize(query);
  if (!q) return null;
  if (q === 'settings' || q === 'windows settings') return { app: SETTINGS, score: 0 };
  const alias = ALIASES.find((a) => a.names.includes(q));
  const aliased = alias && apps.find((a) => alias.id.test(a.appId));
  if (aliased) return { app: aliased, score: 0 };
  const hits = apps.map((app) => ({ app, score: tier(q, normalize(app.name)) })).filter((h) => h.score != null);
  return hits.sort(byRank)[0] ?? null;
}

const bigrams = (s) => { const b = new Set(); for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2)); return b; };
const overlap = (a, b) => { const x = bigrams(a), y = bigrams(b); let n = 0; for (const g of x) if (y.has(g)) n++; return x.size + y.size ? (2 * n) / (x.size + y.size) : 0; };

// Names for a "did you mean": tier matches first, then the most shared letter pairs.
export function closest(query, apps, n = 3) {
  const q = normalize(query);
  const ranked = apps.map((app) => {
    const nm = normalize(app.name), t = tier(q, nm);
    return { name: app.name, t: t ?? 9, sim: overlap(q.replace(/ /g, ''), nm.replace(/ /g, '')) };
  }).filter((r) => r.t < 9 || r.sim >= 0.25)
    .sort((a, b) => a.t - b.t || b.sim - a.sim || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return [...new Set(ranked.map((r) => r.name))].slice(0, n);
}

export const launchTarget = (app) => (app.appId === 'ms-settings:' ? 'ms-settings:' : app.lnk ? app.appId : `shell:AppsFolder\\${app.appId}`);

// The list costs a PowerShell start (about a second), so it's kept for the session and re-read once on a miss
// (the app may have been installed since). A failed list is never cached, so the next call tries again.
export function createAppFinder({ list }) {
  let cache = null;
  const load = (fresh) => {
    if (!fresh && cache) return cache;
    const p = Promise.resolve().then(list).then((a) => a ?? []);
    cache = p;
    p.catch(() => { if (cache === p) cache = null; });
    return p;
  };
  return {
    async find(query) {
      let apps;
      try { apps = await load(false); } catch (error) { return { match: null, apps: [], failed: true, error }; }
      let m = matchApp(query, apps);
      if (!m) {
        // A failed refresh keeps the list we already have rather than reporting a failure.
        try { apps = await load(true); } catch { cache = Promise.resolve(apps); }
        m = matchApp(query, apps);
      }
      return { match: m, apps };
    },
  };
}
