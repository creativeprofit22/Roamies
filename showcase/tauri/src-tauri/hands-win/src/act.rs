// The act verb: clicks, fills, chooses, scrolls and presses keys in another app, step by step like
// hands/main.swift (892-1151). Every step tries UI Automation first, falls back to real input, and checks it
// worked. Nothing is sent before the window is known to be safe (not hands-off, not input-only, not above
// us) and really in front; that's re-checked before every step.
use crate::budget::{publish, Budget, Snapshot};
use crate::cli::UI_NODES;
use crate::controls::{search_window, UiCollect};
use crate::fill::{self, Filled, How, Kind, Ways};
use crate::forms::{self, Cand};
use crate::geom::Rect;
use crate::input::{self, InputError};
use crate::keys::{self, Combo};
use crate::plan::{act_error, Action, Dir, Plan, Step, FOCUS_MS, STEP_MARGIN_MS, WALK_MS};
use crate::protocol::{self as p, Control, WinInfo};
use crate::rank;
use crate::uia::{self, Did, Node, Uia};
use crate::{cmd, dpi, elevation, focus, hands_off, risky, roles, windows};
use roamies_paste_core::{Chord, ClipboardPaste, SystemClip};
use serde_json::Value;
use std::thread::sleep;
use std::time::{Duration, Instant};
use w32::Win32::Foundation::{HWND, POINT};
use w32::Win32::UI::Accessibility::IUIAutomationElement;
use w32::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};

const TEXTS_CHARS: usize = 2000;
const TO_END_MS: u64 = 25_000;
const TREE_ITEM: i32 = 50024;
const DATA_ITEM: i32 = 50029;
const PANE: i32 = 50033;

/// `total` is the whole verb's budget (the same deadline the main thread enforces).
pub fn run(plan: &Plan, fake: &str, total: &Budget, snap: &Snapshot) -> Value {
    match act(plan, fake, total, snap) {
        Ok(v) | Err(v) => v,
    }
}

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

/// A refusal built by the shared helpers, with the `done: []` every act error carries.
fn nothing_done(mut v: Value) -> Value {
    if v["done"].is_null() {
        v["done"] = Value::Array(vec![]);
    }
    v
}

fn act(plan: &Plan, fake: &str, total: &Budget, snap: &Snapshot) -> Result<Value, Value> {
    publish(snap, act_error("timeout", "The app didn't answer in time, so nothing was clicked or typed.", &[]));
    let w = cmd::resolve(&plan.target).map_err(nothing_done)?;
    if let Some(name) = hands_off::act_check(&[&w.exe, fake], &w.class) {
        return Err(nothing_done(hands_off::act_refusal(name)));
    }
    if elevation::input_blocked(w.pid) {
        return Err(nothing_done(elevation::refusal(&w.app)));
    }
    let hwnd = windows::hwnd(w.id);
    if !focus::bring_to_front(hwnd, Instant::now() + ms(FOCUS_MS)) {
        return Err(focus::refused(&w.app));
    }
    let w = window_now(&w);
    if w.minimized {
        return Err(nothing_done(crate::capture::minimized(&w)));
    }
    let uia = Uia::new(&Budget::new(2000, 0)).map_err(nothing_done)?;
    let mons: Vec<Rect> = dpi::monitors().iter().map(|m| m.bounds).collect();
    let mut a = Act { uia, w, hwnd, fake: fake.to_string(), col: UiCollect::new(Rect::new(0, 0, 0, 0)), done: vec![], mons, step: 0 };
    a.walk(&Budget::new(WALK_MS, 0));
    for (i, s) in plan.steps.iter().enumerate() {
        a.step = i + 1;
        let late = act_error("timeout", &format!("Step {}: {} didn't answer in time", i + 1, a.w.app), &a.done);
        // A step gets only the time really left, so a slow app can't run it into the hard deadline mid-input.
        let left = total.remaining().saturating_sub(ms(STEP_MARGIN_MS));
        if left.is_zero() {
            return Err(late);
        }
        publish(snap, late);
        let budget = Budget::new((s.budget_ms() as u128).min(left.as_millis()) as u64, 0);
        a.front_ok(s)?;
        a.run_step(s, &budget)?;
    }
    let mut reply = p::act_reply(&a.w, &a.done);
    if plan.changes() {
        publish(snap, reply.clone());
        a.w = window_now(&a.w);
        a.settle(Instant::now() + ms(1500).min(total.remaining()));
        let texts = cap_chars(a.col.ordered_texts(400), TEXTS_CHARS);
        reply = p::act_changed(&a.w, &a.done, a.col.controls_json(), texts);
    }
    Ok(reply)
}

/// The window as it is now (restored, moved), or as it was when it can't be found any more.
fn window_now(w: &WinInfo) -> WinInfo {
    windows::all().into_iter().find(|x| x.id == w.id).unwrap_or_else(|| w.clone())
}

fn cap_chars(lines: Vec<String>, max: usize) -> Vec<String> {
    let mut left = max;
    let mut out = Vec::new();
    for l in lines {
        let n = l.chars().count();
        if n > left {
            break;
        }
        left -= n;
        out.push(l);
    }
    out
}

fn centre(r: Rect) -> (i32, i32) {
    (r.x + r.w / 2, r.y + r.h / 2)
}

fn rect_of(v: &Value) -> Option<Rect> {
    let b = v["bounds"].as_array()?;
    let n = |i: usize| b.get(i).and_then(Value::as_i64).map(|x| x as i32);
    Some(Rect::new(n(0)?, n(1)?, n(2)?, n(3)?))
}

/// The top-level window under a screen point.
fn root_at(x: i32, y: i32) -> Option<HWND> {
    let h = unsafe { WindowFromPoint(POINT { x, y }) };
    if h.is_invalid() {
        return None;
    }
    let root = unsafe { GetAncestor(h, GA_ROOT) };
    Some(if root.is_invalid() { h } else { root })
}

fn app_of(h: HWND) -> String {
    windows::all().into_iter().find(|w| windows::hwnd(w.id) == h).map(|w| w.app).unwrap_or_else(|| "another app".into())
}

fn is_field(n: &Node) -> bool {
    n.enabled && (n.ct == roles::EDIT || n.editable || (matches!(n.ct, roles::COMBOBOX | roles::DOCUMENT) && uia::value_writable(&n.el)))
}

/// What a field shows now: its value, else its document text (Notepad's editor).
fn shows(el: &IUIAutomationElement) -> String {
    uia::value_get(el).filter(|v| !v.is_empty()).or_else(|| uia::text_of(el, 4000)).unwrap_or_default()
}

fn same(a: &Node, b: &Node) -> bool {
    a.ct == b.ct && a.bounds == b.bounds && a.name == b.name
}

struct Act {
    uia: Uia,
    w: WinInfo,
    hwnd: HWND,
    fake: String,
    col: UiCollect,
    done: Vec<String>,
    mons: Vec<Rect>,
    step: usize,
}

impl Act {
    fn err(&self, code: &str, msg: &str) -> Value {
        act_error(code, msg, &self.done)
    }

    fn input_err(&self, e: InputError) -> Value {
        self.err(e.code(), &format!("Step {}: {}", self.step, e.message()))
    }

    fn walk(&mut self, budget: &Budget) {
        let mut col = UiCollect::new(self.w.bounds);
        col.keep_all = true;
        uia::nudge_browser(self.hwnd);
        let mut b = Budget::new(budget.remaining().min(ms(WALK_MS)).as_millis() as u64, UI_NODES);
        let _ = self.uia.walk(self.hwnd, &mut b, &mut |n: &Node| col.visit(n));
        self.col = col;
    }

    fn settle(&mut self, deadline: Instant) {
        let sig = |c: &UiCollect| c.found.iter().chain(&c.hidden).map(|c| format!("{}|{}", c.role, c.label)).collect::<Vec<_>>();
        let left = || Budget::new(deadline.saturating_duration_since(Instant::now()).as_millis() as u64, 0);
        self.walk(&left());
        for _ in 0..4 {
            if Instant::now() + ms(400) > deadline {
                break;
            }
            sleep(ms(200));
            let prev = sig(&self.col);
            self.walk(&left());
            if sig(&self.col) == prev {
                break;
            }
        }
    }

    /// The foreground window must still be one we may touch; keys, typing and click_at also need the
    /// target itself in front.
    fn front_ok(&mut self, s: &Step) -> Result<(), Value> {
        if s.action == Action::Wait {
            return Ok(());
        }
        if let Some(fg) = focus::foreground_root() {
            let pid = windows::pid_of(fg);
            let exe = windows::exe_path(pid).unwrap_or_default();
            let fake = if fg == self.hwnd { self.fake.as_str() } else { "" };
            if let Some(name) = hands_off::act_check(&[&exe, fake], &windows::class_of(fg)) {
                return Err(self.err("hands_off", &format!("Blocked for safety: {name} came to the front, and I never type or click in it.")));
            }
            if pid != std::process::id() && elevation::input_blocked(pid) {
                let mut v = elevation::refusal(&app_of(fg));
                v["done"] = serde_json::json!(self.done);
                return Err(v);
            }
        }
        if matches!(s.action, Action::Key | Action::Type | Action::ClickAt) {
            self.ensure_front()?;
        }
        Ok(())
    }

    fn ensure_front(&mut self) -> Result<(), Value> {
        if focus::is_front(self.hwnd) || focus::bring_to_front(self.hwnd, Instant::now() + ms(1500)) {
            return Ok(());
        }
        let other = focus::foreground_root().map(app_of).unwrap_or_else(|| "another app".into());
        Err(focus::wrong_app(self.step, &other, &self.w.app, &self.done))
    }

    /// Clicks a screen point after checking what's there: never a hands-off, input-only or elevated app;
    /// with `own`, only the target app (something covering it gets refused, not clicked).
    fn click(&mut self, x: i32, y: i32, own: bool) -> Result<(), Value> {
        if let Some(h) = root_at(x, y) {
            let pid = windows::pid_of(h);
            let exe = windows::exe_path(pid).unwrap_or_default();
            let fake = if h == self.hwnd { self.fake.as_str() } else { "" };
            if let Some(name) = hands_off::act_check(&[&exe, fake], &windows::class_of(h)) {
                return Err(self.err("hands_off", &format!("Blocked for safety: that spot is on {name}, and I never click in it.")));
            }
            if pid != std::process::id() && elevation::input_blocked(pid) {
                let mut v = elevation::refusal(&app_of(h));
                v["done"] = serde_json::json!(self.done);
                return Err(v);
            }
            if own && h != self.hwnd && pid != self.w.pid {
                let other = app_of(h);
                return Err(self.err("covered", &format!("Step {}: {other} covers that spot in {}, so I didn't click it.", self.step, self.w.app)));
            }
        }
        if own {
            self.ensure_front()?;
        }
        input::click(x, y).map_err(|e| self.input_err(e))
    }

    /// Clicks the middle of an element, scrolling it into view first when it's outside the window.
    fn click_el(&mut self, el: &IUIAutomationElement, top: bool) -> Result<bool, Value> {
        let inside = |r: Rect, w: Rect| w.contains(centre(r).0, centre(r).1);
        let mut r = uia::current_rect(el);
        if r.is_some_and(|r| !inside(r, self.w.bounds)) && self.uia.scroll_into_view(el) {
            sleep(ms(300));
            r = uia::current_rect(el);
        }
        let Some(r) = r.filter(|r| inside(*r, self.w.bounds)) else { return Ok(false) };
        let (x, y) = centre(r);
        // Text fields: near the top line, where the first row of text is.
        let y = if top { y.min(r.y + 12) } else { y };
        self.click(x, y, true)?;
        Ok(true)
    }

    fn key(&mut self, combo: &str) -> Result<(), Value> {
        let c: Combo = keys::parse(combo).map_err(|_| self.err("usage", &format!("unknown key {combo}")))?;
        input::key(&c).map_err(|e| self.input_err(e))
    }

    fn type_text(&mut self, text: &str) -> Result<(), Value> {
        input::type_text(text).map_err(|e| self.input_err(e))
    }

    /// Presses a control through UI Automation: Invoke, else Toggle, else select it. An answer that timed
    /// out means the app is busy with what it opened: that's done, never pressed again.
    fn press(el: &IUIAutomationElement) -> bool {
        [uia::invoke, uia::toggle, uia::select].iter().any(|f| matches!(f(el), Did::Done | Did::Busy))
    }

    fn by_id(&self, s: &Step) -> Option<(Control, Node)> {
        s.id.and_then(|id| self.col.by_id(id)).map(|(c, n)| (c.clone(), n.clone()))
    }

    fn no_id(&self, s: &Step) -> Value {
        let raw = s.id_raw.clone().unwrap_or_else(|| "?".into());
        self.err("not_found", &format!("Step {}: no control with id {raw}. Call read_window again.", self.step))
    }

    fn risky_stop(&self, label: &str) -> Value {
        self.err(
            "confirm",
            &format!("Stopped before clicking \"{label}\": it could delete, pay, send or sign out, and the user hasn't said yes to that. Tell them, and let them click it themselves."),
        )
    }

    fn run_step(&mut self, s: &Step, budget: &Budget) -> Result<(), Value> {
        match s.action {
            Action::Focus | Action::Click | Action::PressButton => self.by_id_step(s, budget),
            Action::Set | Action::Fill => self.fill(s, budget),
            Action::ClickText => self.click_text(s, budget),
            Action::Type => self.type_step(s),
            Action::Choose => self.choose(s, budget),
            Action::Scroll => self.scroll(s, budget),
            Action::Key => {
                let Some(c) = s.key else { return Err(self.err("usage", &format!("Step {}: unknown key {}", self.step, s.key_name))) };
                input::key(&c).map_err(|e| self.input_err(e))?;
                self.done.push(format!("pressed {}", s.key_name));
                Ok(())
            }
            Action::ClickAt => {
                let Some((x, y)) = forms::click_point(s.x, s.y, s.global, self.w.bounds, &self.mons) else {
                    return Err(self.err("usage", &format!("Step {}: {},{} isn't on any screen.", self.step, s.x, s.y)));
                };
                self.click(x, y, false)?;
                self.done.push(format!("clicked at {},{}", s.x as i64, s.y as i64));
                Ok(())
            }
            Action::Wait => {
                sleep(Duration::from_secs_f64(s.seconds));
                self.done.push("waited".into());
                Ok(())
            }
        }
    }

    fn by_id_step(&mut self, s: &Step, budget: &Budget) -> Result<(), Value> {
        let Some((c, n)) = self.by_id(s) else { return Err(self.no_id(s)) };
        let label = if c.label.is_empty() { None } else { Some(c.label.clone()) };
        if s.action != Action::Focus && risky::risky(&c.label) && !s.confirmed {
            return Err(self.risky_stop(&c.label));
        }
        if s.action == Action::Focus {
            if !(uia::set_focus(&n.el) && uia::has_focus(&n.el)) {
                // The fallback is a real click, so it needs the same yes as a click step.
                if risky::risky(&c.label) && !s.confirmed {
                    return Err(self.risky_stop(&c.label));
                }
                self.click_el(&n.el, is_field(&n))?;
            }
            self.done.push(format!("focused {}", label.unwrap_or_else(|| "field".into())));
            return Ok(());
        }
        if is_field(&n) {
            // "Pressing" a text box doesn't put the cursor in it; focus and click so typing lands there.
            uia::set_focus(&n.el);
            self.click_el(&n.el, true)?;
            self.done.push(format!("clicked {}", label.unwrap_or_else(|| "field".into())));
        } else {
            if !Self::press(&n.el) && !self.click_el(&n.el, false)? {
                return Err(self.err("not_found", &format!("Step {}: couldn't click {}: it isn't on screen.", self.step, label.as_deref().unwrap_or("that control"))));
            }
            self.done.push(format!("clicked {}", label.unwrap_or_else(|| "control".into())));
        }
        sleep(ms(150));
        self.walk(budget);
        Ok(())
    }

    /// Where some text is in the window (on screen first, else scrolled out of view).
    fn anchor(&self, near: &str, budget: &Budget) -> Result<Rect, Value> {
        let r = search_window(&self.uia, &self.w, near, budget)?;
        r.shown.iter().chain(&r.hidden).find_map(|h| rect_of(&h.item)).ok_or(Value::Null)
    }

    fn click_text(&mut self, s: &Step, budget: &Budget) -> Result<(), Value> {
        let q = s.text.trim().to_string();
        let mut hit: Option<(IUIAutomationElement, String)> = None;
        let fq = forms::fold(&q);
        // A checkbox or radio by its label: press the control itself; clicking the words doesn't always tick it.
        let boxed = self.col.numbered().find(|(_, c, n)| matches!(n.ct, roles::CHECKBOX | roles::RADIO) && !c.offscreen && !fq.is_empty() && forms::fold(&c.label) == fq).map(|(_, c, n)| (n.el.clone(), c.label.clone()));
        if let Some(b) = boxed {
            hit = Some(b);
        } else if !s.near.is_empty() && !q.is_empty() {
            let Ok(a) = self.anchor(&s.near, budget) else {
                return Err(self.err("not_found", &format!("Step {}: no text \"{}\" on this page to find \"{q}\" near.", self.step, s.near)));
            };
            let r = search_window(&self.uia, &self.w, &q, budget).map_err(|e| self.with_done(e))?;
            let all: Vec<_> = r.shown.into_iter().chain(r.hidden).filter(|h| rank::whole_match(&h.item, &q)).collect();
            let best = all.iter().map(|h| h.score).min();
            let all: Vec<_> = all.into_iter().filter(|h| Some(h.score) == best).collect();
            let rects: Vec<Option<Rect>> = all.iter().map(|h| rect_of(&h.item)).collect();
            hit = forms::nearest_after(a, &rects).map(|i| (all[i].el.clone(), all[i].item["text"].as_str().unwrap_or(&q).to_string()));
        } else if !q.is_empty() {
            let r = search_window(&self.uia, &self.w, &q, budget).map_err(|e| self.with_done(e))?;
            hit = r.shown.iter().find(|h| rank::whole_match(&h.item, &q)).map(|h| (h.el.clone(), h.item["text"].as_str().unwrap_or(&q).to_string()));
            if hit.is_none() {
                // Scrolled out of view: bring the best one in and look again.
                if let Some(h) = r.hidden.iter().find(|h| rank::whole_match(&h.item, &q)) {
                    if self.uia.scroll_into_view(&h.el) {
                        sleep(ms(300));
                        let r = search_window(&self.uia, &self.w, &q, budget).map_err(|e| self.with_done(e))?;
                        hit = r.shown.iter().find(|h| rank::whole_match(&h.item, &q)).map(|h| (h.el.clone(), h.item["text"].as_str().unwrap_or(&q).to_string()));
                    }
                }
            }
        }
        let Some((el, text)) = hit.filter(|_| !q.is_empty()) else {
            return Err(self.err(
                "not_found",
                &format!("Step {}: no visible text \"{}\" in {}. Check the exact words with a screenshot or read_window.", self.step, s.text, self.w.app),
            ));
        };
        let text = if text.is_empty() { q.clone() } else { text };
        if risky::risky(&text) && !s.confirmed {
            return Err(self.risky_stop(&text));
        }
        if !self.press_text(&el)? && !self.click_el(&el, false)? {
            return Err(self.err("not_found", &format!("Step {}: couldn't click \"{q}\".", self.step)));
        }
        self.done.push(format!("clicked \"{text}\""));
        sleep(ms(150));
        self.walk(budget);
        Ok(())
    }

    fn with_done(&self, mut v: Value) -> Value {
        v["done"] = serde_json::json!(self.done);
        v
    }

    /// Activates what a piece of text belongs to: focuses a text field, else presses the element or the
    /// nearest of its 6 ancestors that can be pressed (a link around its text, a button around its label).
    fn press_text(&mut self, el: &IUIAutomationElement) -> Result<bool, Value> {
        let mut cur = Some(el.clone());
        for _ in 0..7 {
            let Some(c) = cur else { break };
            if let Some(n) = self.uia.node_of(&c) {
                if matches!(n.ct, DATA_ITEM | PANE) || n.ct == 50032 {
                    break;
                }
                if is_field(&n) {
                    uia::set_focus(&c);
                    return self.click_el(&c, true);
                }
            }
            if Self::press(&c) {
                return Ok(true);
            }
            cur = self.uia.parent(&c);
        }
        Ok(false)
    }

    fn type_step(&mut self, s: &Step) -> Result<(), Value> {
        // Typing outside a text field fires page shortcuts (YouTube's k pauses, digits switch views).
        let focused = self.uia.focused_element();
        let ok = focused.as_ref().is_some_and(|f| uia::process_id(f) == Some(self.w.pid) && self.uia.node_of(f).is_some_and(|n| is_field(&n)));
        if !ok {
            return Err(self.err(
                "not_editable",
                &format!("Step {}: the cursor isn't in a text field, so typing would go nowhere. Use {{do:'fill', field, text}} to fill a field by its label.", self.step),
            ));
        }
        self.type_text(&s.text)?;
        self.done.push("typed text".into());
        Ok(())
    }

    /// Fields (and their names) that fill can match, on screen first.
    fn fields(&self) -> Vec<(Node, String)> {
        let mut out: Vec<(Node, String)> = Vec::new();
        for n in self.col.all.iter().filter(|n| is_field(n)) {
            if !out.iter().any(|(o, _)| same(o, n)) {
                out.push((n.clone(), n.name.trim().to_string()));
            }
        }
        out
    }

    /// The field a form label names: its own label or placeholder, else the field next to the visible
    /// label text. With no name and exactly one field in view, that one (Notepad's editor).
    fn field_for(&self, name: &str, budget: &Budget) -> Option<(Node, String)> {
        let fields = self.fields();
        let cands: Vec<Cand> = fields
            .iter()
            .map(|(n, l)| Cand { names: forms::names_of(l, &[&n.help]), rect: n.bounds, offscreen: n.offscreen || !n.bounds.is_some_and(|b| b.mostly_inside(&self.w.bounds)) })
            .collect();
        if name.trim().is_empty() {
            let shown: Vec<usize> = (0..cands.len()).filter(|&i| !cands[i].offscreen).collect();
            return (shown.len() == 1).then(|| fields[shown[0]].clone());
        }
        if let Some(i) = forms::by_name(&cands, name) {
            return Some(fields[i].clone());
        }
        let r = search_window(&self.uia, &self.w, name, budget).ok()?;
        let lab = r.shown.iter().chain(&r.hidden).find(|h| rank::whole_match(&h.item, name)).and_then(|h| rect_of(&h.item))?;
        forms::by_label(&cands, lab).map(|i| fields[i].clone())
    }

    /// Puts the cursor in a field, replaces its text and reads back what it shows, in the order `fill::fill`
    /// sets out. `last_resort` allows the clipboard paste and putting the old text back when nothing else
    /// worked; type-to-search in a dropdown goes without, so the typed text stays for the suggestions.
    fn type_into(&mut self, n: &Node, text: &str, last_resort: bool) -> Result<Filled, Value> {
        uia::set_focus(&n.el);
        if !self.click_el(&n.el, true)? {
            return Ok(Filled::NotHere);
        }
        sleep(ms(80));
        let kind = if n.password {
            Kind::Password
        } else if n.in_web {
            Kind::Web
        } else {
            Kind::Native
        };
        fill::fill(&mut Field { act: self, n, last_resort }, text, kind)
    }

    /// The keyboard focus is on this field (or something inside it) in the target app.
    fn focus_in(&self, n: &Node) -> bool {
        uia::has_focus(&n.el)
            || self.uia.focused_element().is_some_and(|f| uia::process_id(&f) == Some(self.w.pid) && uia::current_rect(&f).zip(uia::current_rect(&n.el)).is_some_and(|(a, b)| a.intersects(&b)))
    }

    /// Selects the field's text and pastes over it, then gives the clipboard back. Nothing is sent unless
    /// the field has focus and the target is in front; only Ctrl+A and Ctrl+V, never Enter.
    fn paste_into(&mut self, n: &Node, text: &str) -> Result<bool, Value> {
        if !self.focus_in(n) {
            return Ok(false);
        }
        self.ensure_front()?;
        // Clipboard busy (another app holds it open): nothing was sent, so the read-back reports it.
        let Ok(clip) = SystemClip::new_private() else { return Ok(false) };
        self.key("ctrl+a")?;
        let mut sink = ClipboardPaste { clip, chord: KeysChord(None), settle: ms(50), wait: ms(300) };
        let r = sink.insert(text);
        if let Some(e) = sink.chord.0.take() {
            return Err(self.input_err(e));
        }
        sleep(ms(120));
        Ok(r.is_ok())
    }

    fn fill(&mut self, s: &Step, budget: &Budget) -> Result<(), Value> {
        let text = s.text.clone();
        let name = s.field.trim().to_string();
        let by_id = |a: &Act| a.by_id(s).map(|(c, n)| (n, c.label));
        if s.action == Action::Set && by_id(self).is_none() {
            return Err(self.no_id(s));
        }
        if by_id(self).is_none() && self.field_for(&name, budget).is_none() {
            sleep(ms(300));
            self.walk(budget);
        }
        // Same field under every post ("Write a reply…"): the one that goes with the near text.
        let mut near_field = None;
        if !s.near.is_empty() {
            let Ok(a) = self.anchor(&s.near, budget) else {
                return Err(self.err("not_found", &format!("Step {}: no text \"{}\" on this page to find the field near.", self.step, s.near)));
            };
            let q = forms::fold(&name);
            let fields: Vec<(Node, String)> = self.fields().into_iter().filter(|(n, l)| q.is_empty() || forms::names_of(l, &[&n.help]).iter().any(|x| x.contains(&q))).collect();
            let rects: Vec<Option<Rect>> = fields.iter().map(|(n, _)| n.bounds).collect();
            near_field = forms::nearest_after(a, &rects).map(|i| fields[i].clone());
        }
        let Some((n, label)) = near_field.or_else(|| by_id(self)).or_else(|| self.field_for(&name, budget)) else {
            return Err(self.err("not_found", &format!("Step {}: no text field called \"{name}\" here. Check its label with read_window.", self.step)));
        };
        let label = if label.trim().is_empty() { if name.is_empty() { "the field".to_string() } else { name.clone() } } else { label.trim().to_string() };
        let (now, how) = match self.type_into(&n, &text, true)? {
            Filled::Shown(now, how) => (now, how),
            Filled::Failed { shows, put_back, pasted } => return Err(self.mismatch(&n, &label, &shows, put_back, pasted, &text)),
            Filled::NotHere => return Err(self.err("not_editable", &format!("Step {}: couldn't put the cursor in \"{label}\", so nothing was typed.", self.step))),
        };
        let pasted = if how == How::Pasted { " (pasted)" } else { "" };
        if s.action == Action::Set {
            self.done.push(format!("set {label}{pasted}"));
        } else if n.password {
            // Windows never gives a password field's text back, so there's nothing to read back.
            self.done.push(format!("{label} = \"••••\""));
        } else {
            let shown: String = now.trim().chars().take(60).collect();
            self.done.push(format!("{label} = \"{shown}\"{pasted}"));
        }
        self.walk(budget);
        Ok(())
    }

    fn mismatch(&self, n: &Node, label: &str, now: &str, put_back: bool, pasted: bool, text: &str) -> Value {
        let now = now.trim();
        let back = if put_back { " It shows its old text again." } else { " Its old text couldn't be put back." };
        if now.is_empty() && !uia::value_writable(&n.el) && n.ct != roles::EDIT && !n.editable {
            return self.err(
                "mismatch",
                &format!("Step {}: \"{label}\" can't be typed in; it opens a picker. Use click_text on it, then on the month arrows (e.g. 'Next Month') and the day.{back}", self.step),
            );
        }
        let cut: String = now.chars().take(80).collect();
        let ways = if pasted { "typed, set and pasted into" } else { "typed and set into" };
        let skipped = if !pasted && !text.is_empty() { " (the clipboard was busy, so it wasn't pasted)" } else { "" };
        self.err(
            "mismatch",
            &format!("Step {}: {ways} \"{label}\"{skipped} but it showed \"{cut}\".{back} If a cookie banner or pop-up covers the page, close it first (click_text its button), then fill again; otherwise check the field with read_window.", self.step),
        )
    }

    /// A menu item or list option with this text: under the dropdown, in the app's popup windows, then
    /// anywhere in the window. Exact text first, then text that starts with it.
    fn find_option(&mut self, drop: &Node, option: &str, budget: &Budget) -> Option<Node> {
        let q = forms::fold(option);
        let opt_role = |ct: i32| matches!(ct, roles::LIST_ITEM | roles::MENU_ITEM | roles::TEXT | roles::BUTTON | roles::RADIO | roles::HYPERLINK | TREE_ITEM | DATA_ITEM);
        let pick = |nodes: &[Node]| -> Option<Node> {
            let mut prefix = None;
            for n in nodes.iter().filter(|n| opt_role(n.ct) && !same(n, drop)) {
                for t in n.texts().into_iter().map(forms::fold).filter(|t| !t.is_empty()) {
                    if t == q {
                        return Some(n.clone());
                    }
                    if prefix.is_none() && t.starts_with(&q) && t.chars().count() <= q.chars().count() + 25 {
                        prefix = Some(n.clone());
                    }
                }
            }
            prefix
        };
        let mut below = Vec::new();
        let mut b = Budget::new(budget.remaining().min(ms(1500)).as_millis() as u64, 2000);
        self.uia.walk_below(&drop.el, &mut b, &mut |n: &Node| below.push(n.clone()));
        if let Some(o) = pick(&below) {
            return Some(o);
        }
        for pw in windows::all().into_iter().filter(|x| x.pid == self.w.pid && x.id != self.w.id).take(4) {
            let mut nodes = Vec::new();
            let mut b = Budget::new(budget.remaining().min(ms(1000)).as_millis() as u64, 2000);
            let _ = self.uia.walk(windows::hwnd(pw.id), &mut b, &mut |n: &Node| nodes.push(n.clone()));
            if let Some(o) = pick(&nodes) {
                return Some(o);
            }
        }
        self.walk(budget);
        pick(&self.col.all)
    }

    fn activate(&mut self, n: &Node) -> Result<(), Value> {
        let pressed = [uia::select, uia::invoke, uia::toggle].iter().any(|f| matches!(f(&n.el), Did::Done | Did::Busy));
        if !pressed {
            self.click_el(&n.el, false)?;
        }
        Ok(())
    }

    fn choose(&mut self, s: &Step, budget: &Budget) -> Result<(), Value> {
        let option = s.option.trim().to_string();
        let name = s.field.trim().to_string();
        let drop_role = |n: &Node| matches!(n.ct, roles::COMBOBOX | roles::SPLIT_BUTTON | roles::BUTTON | roles::EDIT);
        let found = self.by_id(s).map(|(c, n)| (n, c.label)).or_else(|| {
            let drops: Vec<(Node, String)> = self.col.numbered().filter(|(_, _, n)| drop_role(n)).map(|(_, c, n)| (n.clone(), c.label.clone())).collect();
            let cands: Vec<Cand> = drops.iter().map(|(n, l)| Cand { names: forms::names_of(l, &[&n.help]), rect: n.bounds, offscreen: n.offscreen }).collect();
            if let Some(i) = forms::by_name(&cands, &name) {
                return Some(drops[i].clone());
            }
            // No usable name and the page has exactly one dropdown in view: that's the one.
            let page: Vec<&(Node, String)> = drops.iter().filter(|(n, _)| n.ct == roles::COMBOBOX && !n.offscreen && n.in_web).collect();
            (page.len() == 1).then(|| page[0].clone())
        });
        let Some((e, label)) = found.filter(|_| !option.is_empty()) else {
            return Err(self.err("not_found", &format!("Step {}: no dropdown called \"{name}\" here, or no option given. Check with read_window.", self.step)));
        };
        let label = if label.trim().is_empty() { name.clone() } else { label.trim().to_string() };
        if risky::risky(&option) && !s.confirmed {
            return Err(self.err("confirm", &format!("Stopped before choosing \"{option}\": it could delete, pay, send or sign out, and the user hasn't said yes to that.")));
        }
        if uia::expand(&e.el) == Did::Missing && !Self::press(&e.el) {
            self.click_el(&e.el, false)?;
        }
        sleep(ms(350));
        let typeable = e.ct == roles::EDIT || (e.ct == roles::COMBOBOX && uia::value_writable(&e.el));
        if let Some(o) = self.find_option(&e, &option, budget) {
            self.activate(&o)?;
        } else if typeable && !matches!(self.type_into(&e, &option, false)?, Filled::NotHere) && {
            sleep(ms(500));
            true
        } {
            // Type-to-search: the suggestions appear once there's text in the box.
            match self.find_option(&e, &option, budget) {
                Some(o) => self.activate(&o)?,
                None => {
                    self.ensure_front()?;
                    self.key("return")?;
                }
            }
        } else {
            let focused_here = self.uia.focused_element().and_then(|f| self.uia.node_of(&f)).is_some_and(|f| is_field(&f) || same(&f, &e));
            if focused_here || e.ct == roles::COMBOBOX {
                self.ensure_front()?;
                self.type_text(&option)?;
                sleep(ms(350));
                self.key("return")?;
            } else {
                self.ensure_front()?;
                self.key("escape")?;
                return Err(self.err("not_found", &format!("Step {}: opened \"{label}\" but no option \"{option}\" showed up. Take a screenshot to see the choices.", self.step)));
            }
        }
        sleep(ms(450));
        let now = uia::value_get(&e.el).filter(|v| !v.trim().is_empty()).or_else(|| self.uia.node_of(&e.el).map(|n| n.name)).unwrap_or_default();
        let now = now.trim();
        let took = now.is_empty() || forms::fold(now).contains(&forms::fold(&option).chars().take(40).collect::<String>());
        let cut: String = now.chars().take(60).collect();
        self.done.push(if took {
            format!("chose \"{option}\" in {label}{}", if now.is_empty() { String::new() } else { format!(" (shows \"{cut}\")") })
        } else {
            format!("tried to choose \"{option}\" in {label}, but it still shows \"{cut}\"")
        });
        self.walk(budget);
        Ok(())
    }

    /// The text a page shows now, to tell when scrolling to the end stops loading more.
    fn page_sig(&mut self, budget: &Budget) -> String {
        self.walk(budget);
        cap_chars(self.col.ordered_texts(400), 4000).join("|")
    }

    fn scroll(&mut self, s: &Step, budget: &Budget) -> Result<(), Value> {
        let inner = Rect::new(self.w.bounds.x + 4, self.w.bounds.y + 4, (self.w.bounds.w - 8).max(1), (self.w.bounds.h - 8).max(1));
        let in_win = |r: Rect| {
            let (x, y) = centre(r);
            inner.contains(x, y).then_some((x, y))
        };
        let mut p = centre(self.w.bounds);
        let mut el: Option<IUIAutomationElement> = None;
        if let Some((_, n)) = self.by_id(s) {
            if let Some(c) = n.bounds.and_then(in_win) {
                p = c;
            }
            el = Some(n.el);
        } else if !s.text.trim().is_empty() {
            if let Ok(r) = search_window(&self.uia, &self.w, s.text.trim(), budget) {
                if let Some(h) = r.shown.iter().find(|h| rect_of(&h.item).and_then(in_win).is_some()) {
                    p = rect_of(&h.item).and_then(in_win).unwrap_or(p);
                    el = Some(h.el.clone());
                }
            }
        }
        let (down, right, horizontal) = match s.direction {
            Dir::Up => (false, false, false),
            Dir::Down => (true, false, false),
            Dir::Left => (false, false, true),
            Dir::Right => (false, true, true),
        };
        let wheel = |a: &Act, notches: i32| -> Result<(), Value> {
            input::wait_keys_released(1500).map_err(|e| a.input_err(e))?;
            let (dy, dx) = if horizontal { (0, if right { notches } else { -notches }) } else { (if down { notches } else { -notches }, 0) };
            input::wheel(p.0, p.1, dy, dx).map_err(|e| a.input_err(e))
        };
        // Wheel notches land on whatever is under the pointer: check it's this app first.
        let check_point = |a: &mut Act| -> Result<(), Value> {
            if let Some(h) = root_at(p.0, p.1) {
                if h != a.hwnd && windows::pid_of(h) != a.w.pid {
                    let other = app_of(h);
                    return Err(a.err("covered", &format!("Step {}: {other} covers {} there, so I didn't scroll.", a.step, a.w.app)));
                }
            }
            a.ensure_front()
        };
        if s.to_end {
            check_point(self)?;
            let deadline = Instant::now() + ms(TO_END_MS).min(budget.remaining().saturating_sub(ms(1500)));
            let (mut last, mut same_n, mut rounds) = (String::new(), 0, 0);
            while Instant::now() < deadline && same_n < 2 {
                for _ in 0..4 {
                    wheel(self, 5)?;
                    sleep(ms(50));
                }
                sleep(ms(900));
                let left = deadline.saturating_duration_since(Instant::now()).as_millis() as u64;
                let sig = self.page_sig(&Budget::new(left.clamp(300, 1500), 0));
                if sig == last {
                    same_n += 1;
                } else {
                    same_n = 0;
                    rounds += 1;
                }
                last = sig;
            }
            let more = if rounds > 2 { format!(" (more loaded {} times)", rounds - 1) } else { String::new() };
            self.done.push(format!("scrolled to the {}{more}", if down { "end" } else { "top" }));
            self.walk(budget);
            return Ok(());
        }
        // ScrollPattern on the element or its nearest scrollable ancestor; the wheel when nothing scrolls that way.
        let mut scrolled = false;
        let mut cur = el;
        for _ in 0..8 {
            let Some(c) = cur else { break };
            if uia::scroll(&c, down, right, horizontal, false) != Did::Missing {
                for _ in 1..s.amount {
                    let _ = uia::scroll(&c, down, right, horizontal, false);
                    sleep(ms(40));
                }
                scrolled = true;
                break;
            }
            cur = self.uia.parent(&c);
        }
        if !scrolled {
            check_point(self)?;
            for _ in 0..s.amount {
                wheel(self, 1)?;
                sleep(ms(40));
            }
        }
        sleep(ms(250));
        let dir = match s.direction {
            Dir::Up => "up",
            Dir::Down => "down",
            Dir::Left => "left",
            Dir::Right => "right",
        };
        self.done.push(format!("scrolled {dir}"));
        self.walk(budget);
        Ok(())
    }
}

/// One field in the target app, as `fill::fill` sees it.
struct Field<'a> {
    act: &'a mut Act,
    n: &'a Node,
    last_resort: bool,
}

impl Ways for Field<'_> {
    type Err = Value;

    fn set_value(&mut self, text: &str) -> bool {
        uia::value_writable(&self.n.el) && uia::value_set(&self.n.el, text) == Did::Done
    }

    fn type_keys(&mut self, text: &str) -> Result<bool, Value> {
        if !self.act.focus_in(self.n) {
            return Ok(false);
        }
        self.act.key("ctrl+a")?;
        if text.is_empty() {
            self.act.key("delete")?;
        } else {
            self.act.type_text(text)?;
        }
        sleep(ms(120));
        // Chrome updates a rich-text box's accessible text a beat after the keys land; an early read looked like a failed type.
        if self.n.editable {
            let until = Instant::now() + ms(600);
            while !forms::reads_back(&shows(&self.n.el), text) && Instant::now() < until {
                sleep(ms(60));
            }
        }
        Ok(true)
    }

    fn paste(&mut self, text: &str) -> Result<bool, Value> {
        if !self.last_resort {
            return Ok(false);
        }
        self.act.paste_into(self.n, text)
    }

    fn shows(&mut self) -> String {
        shows(&self.n.el)
    }

    fn put_back(&mut self, old: &str) -> bool {
        if !self.last_resort {
            return false;
        }
        if self.set_value(old) {
            return true;
        }
        if old.is_empty() {
            return self.act.focus_in(self.n) && self.act.key("ctrl+a").and_then(|_| self.act.key("delete")).is_ok();
        }
        self.act.paste_into(self.n, old).unwrap_or(false)
    }
}

/// Ctrl+V through SendInput (which waits for the user to let go of their keys). The input error is kept
/// so the step reports it with its own code once the clipboard is back.
struct KeysChord(Option<InputError>);

impl Chord for KeysChord {
    fn paste(&mut self) -> Result<(), String> {
        let c = keys::parse("ctrl+v").map_err(|_| "ctrl+v".to_string())?;
        input::key(&c).map_err(|e| {
            let m = e.message();
            self.0 = Some(e);
            m
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_texts_by_characters() {
        let lines = vec!["abc".to_string(), "de".to_string(), "fghij".to_string()];
        assert_eq!(cap_chars(lines.clone(), 5), vec!["abc", "de"]);
        assert_eq!(cap_chars(lines, 2), Vec::<String>::new());
    }

    #[test]
    fn refusals_carry_done() {
        let v = nothing_done(hands_off::act_refusal("KeePassXC"));
        assert_eq!(v["code"], "hands_off");
        assert_eq!(v["done"], serde_json::json!([]));
        let kept = nothing_done(act_error("focus", "x", &["clicked a".to_string()]));
        assert_eq!(kept["done"], serde_json::json!(["clicked a"]));
    }
}
