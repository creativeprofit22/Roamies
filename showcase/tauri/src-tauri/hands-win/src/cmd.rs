// The verbs: windows, locate, capture, ui and find-text. Runs on the budget's worker thread.
use crate::budget::{publish, Budget, Snapshot, Stop};
use crate::cli::{Cmd, Verb, FIND_NODES_PER_WINDOW, FIND_WINDOWS, UI_NODES};
use crate::com::ComGuard;
use crate::geom::Rect;
use crate::protocol::{self as p, fail, Control, WinInfo};
use crate::rank::{self, Hit};
use crate::target::{app_matches, Target};
use crate::uia::{self, Node, Uia};
use crate::{capture, dpi, hands_off, roles, windows};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;
use w32::Win32::UI::Accessibility::IUIAutomationElement;

const UI_CONTROLS: usize = 260;
const UI_OFFSCREEN: usize = 40;
const PER_WINDOW: usize = 8;

pub fn dispatch(c: Cmd, snap: Snapshot) -> Value {
    let _com = match ComGuard::mta() {
        Ok(g) => g,
        Err(e) => return fail("unavailable", &e),
    };
    if let Err(v) = dpi::verify_thread() {
        return v;
    }
    let cap = match c.verb {
        Verb::Ui(_) => UI_NODES,
        _ => FIND_NODES_PER_WINDOW,
    };
    let mut budget = Budget::new(c.budget_ms, cap);
    let mons = dpi::monitors();
    let fake = c.fake_exe.as_deref().unwrap_or("");
    let res = match &c.verb {
        Verb::Windows => {
            let listed: Vec<WinInfo> = windows::all().into_iter().filter(|w| !w.minimized).collect();
            Ok(p::windows_reply(&listed, windows::front_pid(), &mons))
        }
        Verb::Locate(Target::Screen) => Ok(p::locate_screen_reply(&mons)),
        Verb::Locate(Target::Monitor(n)) => monitor(&mons, *n).map(|_| p::locate_screen_reply(&mons)),
        Verb::Locate(t) => resolve(t).and_then(|w| usable(&w).map(|_| p::locate_reply(&w, &mons))),
        Verb::Capture { out, target: Target::Screen } => capture::screen(out, &mons, None, c.fit).map(|(b, sent)| p::capture_screen_reply(out, b, sent, &mons)),
        Verb::Capture { out, target: Target::Monitor(n) } => {
            monitor(&mons, *n).and_then(|_| capture::screen(out, &mons, Some(*n), c.fit)).map(|(b, sent)| p::capture_screen_reply(out, b, sent, &mons))
        }
        Verb::Capture { out, target } => resolve(target).and_then(|w| guard(&w, fake).map(|_| w)).and_then(|mut w| {
            capture::window(&w, out, c.fit, &budget).map(|(frame, sent)| {
                w.bounds = frame;
                p::capture_window_reply(out, &w, sent, &mons)
            })
        }),
        Verb::Ui(t) => resolve(t).and_then(|w| guard(&w, fake).map(|_| w)).and_then(|w| ui(&w, &mut budget, &snap)),
        Verb::FindText { target, text, scroll } => find_text(target, text, *scroll, fake, &budget, &snap),
    };
    res.unwrap_or_else(|e| e)
}

/// Monitor `n` (1-based, in `monitors` order).
fn monitor(mons: &[p::Monitor], n: usize) -> Result<Rect, Value> {
    mons.get(n.wrapping_sub(1)).map(|m| m.bounds).ok_or_else(|| fail("not_found", &format!("There's no monitor {n}; there are {}.", mons.len())))
}

fn centre_on(w: &WinInfo, r: &Rect) -> bool {
    let (cx, cy) = (w.bounds.x as i64 + w.bounds.w as i64 / 2, w.bounds.y as i64 + w.bounds.h as i64 / 2);
    cx >= r.x as i64 && cx < r.right() && cy >= r.y as i64 && cy < r.bottom()
}

fn not_found(t: &Target) -> Value {
    let what = match t {
        Target::App(n) => format!(" for {n}"),
        _ => String::new(),
    };
    fail("not_found", &format!("No matching window is open{what}."))
}

/// The window a target names. Minimized windows are found too, so the caller can explain why it refuses.
fn resolve(t: &Target) -> Result<WinInfo, Value> {
    let all = windows::all();
    let shown = || all.iter().filter(|w| !w.minimized);
    let found = match t {
        Target::Front => windows::front_pid().and_then(|pid| shown().find(|w| w.pid == pid)).or_else(|| shown().next()),
        Target::Window(id) => all.iter().find(|w| w.id == *id),
        Target::App(name) => shown().find(|w| app_matches(&w.app, &w.exe, name)).or_else(|| all.iter().find(|w| app_matches(&w.app, &w.exe, name))),
        Target::Screen | Target::Monitor(_) => None,
    };
    found.cloned().ok_or_else(|| not_found(t))
}

fn usable(w: &WinInfo) -> Result<(), Value> {
    if w.minimized {
        Err(capture::minimized(w))
    } else {
        Ok(())
    }
}

/// Hands-off apps can be pointed at, never captured or read; elevated apps can't be read at all.
fn guard(w: &WinInfo, fake: &str) -> Result<(), Value> {
    if let Some(name) = hands_off::check(&[&w.exe, fake], &w.class) {
        return Err(hands_off::refusal(name));
    }
    usable(w)
}

fn readable(w: &WinInfo) -> Result<(), Value> {
    if windows::elevated_above_us(w.pid) {
        Err(uia::access_denied(Some(&w.app)))
    } else {
        Ok(())
    }
}

#[derive(Default)]
struct UiCollect {
    view: Rect,
    found: Vec<Control>,
    hidden: Vec<Control>,
    texts: Vec<(i32, i32, String)>,
    elsewhere: Vec<(i32, String)>,
    seen: HashSet<String>,
    seen_off: HashSet<String>,
}

impl UiCollect {
    fn visit(&mut self, n: &Node) {
        let Some(b) = n.bounds.filter(|b| b.w > 1 && b.h > 1) else { return };
        if roles::interactive(n.ct) && n.enabled {
            let label = if n.name.trim().is_empty() { n.help.clone() } else { n.name.clone() };
            let mut c = Control { role: n.role().to_string(), label: label.trim().to_string(), bounds: b, value: n.value.clone(), focused: n.focused, offscreen: false };
            if b.mostly_inside(&self.view) && !n.offscreen {
                if self.found.len() < UI_CONTROLS {
                    self.found.push(c);
                }
            } else if self.hidden.len() < UI_OFFSCREEN {
                c.offscreen = true;
                self.hidden.push(c);
            }
        }
        if n.ct == roles::TEXT || n.heading {
            let raw = if n.name.trim().is_empty() { n.value.clone().unwrap_or_default() } else { n.name.clone() };
            let line: String = rank::clean_line(&raw).chars().take(160).collect();
            if line.chars().count() < 2 {
                return;
            }
            if b.intersects(&self.view) && !n.offscreen {
                if self.seen.insert(line.clone()) {
                    self.texts.push((b.y, b.x, line));
                }
            } else if self.seen_off.insert(line.clone()) {
                self.elsewhere.push((b.y, line));
            }
        }
    }

    fn reply(&self, w: &WinInfo) -> Value {
        let controls = self.found.iter().chain(self.hidden.iter()).take(UI_CONTROLS).enumerate().map(|(i, c)| p::control(i + 1, c)).collect();
        let off: Vec<(i32, String)> = self.elsewhere.iter().filter(|(_, l)| !self.seen.contains(l)).cloned().collect();
        p::ui_reply(w, controls, rank::order_lines(self.texts.clone(), 5000), rank::head_tail(off, 4000))
    }
}

/// A browser whose page tree came back empty right after the nudge gets one more walk.
fn retry_empty_page(nudged: bool, end: &uia::WalkEnd, attempt: usize, budget: &Budget) -> bool {
    nudged && end.docs > 0 && end.web_nodes == 0 && attempt == 0 && budget.remaining() > Duration::from_secs(1)
}

fn ui(w: &WinInfo, budget: &mut Budget, snap: &Snapshot) -> Result<Value, Value> {
    readable(w)?;
    let uia = Uia::new(budget)?;
    let hwnd = windows::hwnd(w.id);
    let mut attempt = 0;
    loop {
        let nudged = uia::nudge_browser(hwnd);
        let mut col = UiCollect { view: w.bounds, ..Default::default() };
        publish(snap, col.reply(w));
        let mut count = 0usize;
        let mut b = budget.with_nodes(UI_NODES);
        let end = uia.walk(hwnd, &mut b, &mut |n: &Node| {
            col.visit(n);
            count += 1;
            if count.is_multiple_of(200) {
                publish(snap, col.reply(w));
            }
        })?;
        if retry_empty_page(nudged, &end, attempt, budget) {
            attempt += 1;
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        let mut v = col.reply(w);
        p::mark_partial(&mut v, end.stop);
        return Ok(v);
    }
}

struct WinSearch {
    shown: Vec<Value>,
    hidden: Vec<Hit<IUIAutomationElement>>,
    stop: Option<Stop>,
}

/// Every element in one window whose text contains `q`: on-screen ones ranked like findTextEls, and the
/// whole-ish matches that are scrolled out of view (for "scroll").
fn search_window(uia: &Uia, w: &WinInfo, q: &str, budget: &Budget) -> Result<WinSearch, Value> {
    let hwnd = windows::hwnd(w.id);
    let view = w.bounds;
    let mut attempt = 0;
    loop {
        let mut shown: Vec<Hit<()>> = Vec::new();
        let mut hidden: Vec<Hit<IUIAutomationElement>> = Vec::new();
        let nudged = uia::nudge_browser(hwnd);
        let mut wb = budget.with_nodes(FIND_NODES_PER_WINDOW);
        // Web pages are searched element by element; their text ranges' lines don't match what's shown.
        let editors = !nudged && !crate::target::is_browser(&w.app, &w.exe);
        let end = uia.walk(hwnd, &mut wb, &mut |n: &Node| {
            let editor = editors && doc_hit(n);
            let (text, b) = match editor.then(|| uia.text_in_document(n, q)).flatten() {
                Some(found) => found,
                None => {
                    let Some(t) = rank::best_text(&n.texts(), q) else { return };
                    let Some(b) = n.bounds.filter(|b| b.w > 1 && b.h > 1) else { return };
                    (t.to_string(), b)
                }
            };
            let Some(score) = rank::score(&text, q).or(editor.then_some(1)) else { return };
            let role = if editor { "text" } else { n.role() };
            // An editor's own IsOffscreen says nothing about where the found line is.
            let on_screen = b.intersects(&view) && (editor || !n.offscreen);
            // Pointing lands on the part that's actually inside the window.
            let b = if on_screen { b.clamp_to(&view).unwrap_or(b) } else { b };
            let item = p::hit(&rank::clean_line(&text), score, role, b);
            if on_screen {
                shown.push(Hit { score, web: n.in_web, area: b.area(), item, el: () });
            } else if hidden.len() < 50 {
                hidden.push(Hit { score, web: n.in_web, area: b.area(), item, el: n.el.clone() });
            }
        })?;
        if retry_empty_page(nudged, &end, attempt, budget) {
            attempt += 1;
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        rank::sort_hits(&mut shown);
        rank::sort_hits(&mut hidden);
        return Ok(WinSearch { shown: shown.into_iter().take(PER_WINDOW).map(|h| h.item).collect(), hidden, stop: end.stop });
    }
}

fn doc_hit(n: &Node) -> bool {
    !n.in_web && (n.ct == roles::DOCUMENT || n.ct == roles::EDIT)
}

/// Hits on screen, scrolled-away hits with their window's z order, and why the search stopped early.
type Found = (Vec<Value>, Vec<(usize, Hit<IUIAutomationElement>)>, Option<Stop>);

fn find_text(t: &Target, q: &str, scroll: bool, fake: &str, budget: &Budget, snap: &Snapshot) -> Result<Value, Value> {
    let all = windows::all();
    let shown: Vec<&WinInfo> = all.iter().filter(|w| !w.minimized).collect();
    let wins: Vec<WinInfo> = match t {
        Target::Screen => shown.iter().filter(|w| hands_off::check(&[&w.exe, fake], &w.class).is_none()).map(|w| (*w).clone()).collect(),
        Target::Monitor(n) => {
            let r = monitor(&dpi::monitors(), *n)?;
            shown.iter().filter(|w| centre_on(w, &r) && hands_off::check(&[&w.exe, fake], &w.class).is_none()).map(|w| (*w).clone()).collect()
        }
        Target::Front => {
            let pid = windows::front_pid().filter(|pid| shown.iter().any(|w| w.pid == *pid)).or(shown.first().map(|w| w.pid));
            shown.iter().filter(|w| Some(w.pid) == pid).map(|w| (*w).clone()).collect()
        }
        Target::App(name) => {
            let m: Vec<WinInfo> = shown.iter().filter(|w| app_matches(&w.app, &w.exe, name)).map(|w| (*w).clone()).collect();
            if m.is_empty() {
                if let Some(min) = all.iter().find(|w| app_matches(&w.app, &w.exe, name)) {
                    return Err(capture::minimized(min));
                }
            }
            m
        }
        Target::Window(_) => vec![resolve(t)?],
    };
    if wins.is_empty() {
        return Err(not_found(t));
    }
    if !matches!(t, Target::Screen | Target::Monitor(_)) {
        for w in &wins {
            guard(w, fake)?;
        }
    }
    let uia = Uia::new(budget)?;
    let wins: Vec<WinInfo> = wins.into_iter().take(FIND_WINDOWS).collect();
    let elevated: Vec<bool> = wins.iter().map(|w| windows::elevated_above_us(w.pid)).collect();
    if elevated.iter().all(|e| *e) {
        return Err(uia::access_denied(Some(&wins[0].app)));
    }
    let search = |hidden_too: bool| -> Result<Found, Value> {
        let mut all_hits = Vec::new();
        let mut hidden = Vec::new();
        let mut stop = None;
        publish(snap, p::find_reply(vec![]));
        for (z, w) in wins.iter().enumerate() {
            if elevated[z] {
                continue;
            }
            if budget.expired() {
                stop = Some(Stop::Time);
                break;
            }
            let r = match search_window(&uia, w, q, budget) {
                Ok(r) => r,
                Err(e) if e["code"] == "access_denied" => continue,
                Err(e) => return Err(e),
            };
            stop = stop.or(r.stop);
            for (i, mut m) in r.shown.into_iter().enumerate() {
                m["window"] = p::win_info(w);
                m["rank"] = json!(z * 100 + i);
                all_hits.push(m);
            }
            if hidden_too {
                hidden.extend(r.hidden.into_iter().map(|h| (z, h)));
            }
            let mut snapshot = p::find_reply(rank::merge_windows(all_hits.clone(), q));
            p::mark_partial(&mut snapshot, stop);
            publish(snap, snapshot);
        }
        Ok((all_hits, hidden, stop))
    };
    let (mut hits, hidden, mut stop) = search(scroll)?;
    // "scroll": nothing whole on screen, so bring the best hidden match into view (front window first), look again.
    if scroll && !hits.iter().any(|m| rank::whole_match(m, q)) {
        let mut best: Vec<&(usize, Hit<IUIAutomationElement>)> = hidden.iter().filter(|(_, h)| rank::whole_match(&h.item, q)).collect();
        best.sort_by_key(|(z, _)| *z);
        if best.iter().any(|(_, h)| uia.scroll_into_view(&h.el)) {
            std::thread::sleep(Duration::from_millis(350));
            let again = search(false)?;
            hits = again.0;
            stop = again.2;
        }
    }
    let mut v = p::find_reply(rank::merge_windows(hits, q));
    p::mark_partial(&mut v, stop);
    Ok(v)
}
