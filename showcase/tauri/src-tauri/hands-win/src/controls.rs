// What one walk of a window yields: the `ui` controls (numbered 1.. the same way for `ui` and `act`, with
// the element behind each id) and find-text's ranked hits. Both verbs share Uia::walk; there's no second walker.
use crate::budget::{Budget, Stop};
use crate::cli::FIND_NODES_PER_WINDOW;
use crate::geom::Rect;
use crate::protocol::{self as p, Control, WinInfo};
use crate::rank::{self, Hit};
use crate::uia::{self, Node, Uia};
use crate::{roles, windows};
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;
use w32::Win32::UI::Accessibility::IUIAutomationElement;

pub const UI_CONTROLS: usize = 260;
const UI_OFFSCREEN: usize = 40;
pub const PER_WINDOW: usize = 8;
/// Nodes `act` keeps for label and option lookups beyond the numbered controls.
const KEPT_NODES: usize = 4000;

#[derive(Default)]
pub struct UiCollect {
    pub view: Rect,
    pub found: Vec<Control>,
    pub hidden: Vec<Control>,
    pub texts: Vec<(i32, i32, String)>,
    elsewhere: Vec<(i32, String)>,
    pub seen: HashSet<String>,
    seen_off: HashSet<String>,
    found_nodes: Vec<Node>,
    hidden_nodes: Vec<Node>,
    /// When set, every node with a size is kept too (act needs labels, editors and options).
    pub keep_all: bool,
    pub all: Vec<Node>,
}

impl UiCollect {
    pub fn new(view: Rect) -> UiCollect {
        UiCollect { view, ..Default::default() }
    }

    pub fn visit(&mut self, n: &Node) {
        let Some(b) = n.bounds.filter(|b| b.w > 1 && b.h > 1) else { return };
        if self.keep_all && self.all.len() < KEPT_NODES {
            self.all.push(n.clone());
        }
        if roles::interactive(n.ct) && n.enabled {
            let label = if n.name.trim().is_empty() { n.help.clone() } else { n.name.clone() };
            let mut c = Control { role: n.role().to_string(), label: label.trim().to_string(), bounds: b, value: n.value.clone(), focused: n.focused, offscreen: false };
            if b.mostly_inside(&self.view) && !n.offscreen {
                if self.found.len() < UI_CONTROLS {
                    self.found.push(c);
                    self.found_nodes.push(n.clone());
                }
            } else if self.hidden.len() < UI_OFFSCREEN {
                c.offscreen = true;
                self.hidden.push(c);
                self.hidden_nodes.push(n.clone());
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

    pub fn has_content(&self) -> bool {
        !self.found.is_empty() || !self.hidden.is_empty() || !self.texts.is_empty()
    }

    /// No control has a name, or there's no text: the app likely draws its own pixels.
    pub fn needs_ocr(&self) -> bool {
        self.texts.is_empty() || !self.found.iter().chain(&self.hidden).any(|c| !c.label.is_empty())
    }

    /// The numbered controls in `ui` order: id (from 1), what `ui` shows, and the element behind it.
    pub fn numbered(&self) -> impl Iterator<Item = (usize, &Control, &Node)> {
        self.found.iter().zip(&self.found_nodes).chain(self.hidden.iter().zip(&self.hidden_nodes)).take(UI_CONTROLS).enumerate().map(|(i, (c, n))| (i + 1, c, n))
    }

    pub fn by_id(&self, id: usize) -> Option<(&Control, &Node)> {
        self.numbered().find(|(i, _, _)| *i == id).map(|(_, c, n)| (c, n))
    }

    pub fn controls_json(&self) -> Vec<Value> {
        self.found.iter().chain(self.hidden.iter()).take(UI_CONTROLS).enumerate().map(|(i, c)| p::control(i + 1, c)).collect()
    }

    pub fn ordered_texts(&self, max: usize) -> Vec<String> {
        rank::order_lines(self.texts.clone(), max)
    }

    pub fn reply(&self, w: &WinInfo) -> Value {
        let off: Vec<(i32, String)> = self.elsewhere.iter().filter(|(_, l)| !self.seen.contains(l)).cloned().collect();
        p::ui_reply(w, self.controls_json(), self.ordered_texts(5000), rank::head_tail(off, 4000))
    }
}

/// A browser whose page tree came back empty right after the nudge gets one more walk.
pub fn retry_empty_page(nudged: bool, end: &uia::WalkEnd, attempt: usize, budget: &Budget) -> bool {
    nudged && end.docs > 0 && end.web_nodes == 0 && attempt == 0 && budget.remaining() > Duration::from_secs(1)
}

pub struct WinSearch {
    pub shown: Vec<Hit<IUIAutomationElement>>,
    pub hidden: Vec<Hit<IUIAutomationElement>>,
    pub stop: Option<Stop>,
}

/// Every element in one window whose text contains `q`: on-screen ones ranked like findTextEls, and the
/// whole-ish matches that are scrolled out of view (for "scroll").
pub fn search_window(uia: &Uia, w: &WinInfo, q: &str, budget: &Budget) -> Result<WinSearch, Value> {
    let hwnd = windows::hwnd(w.id);
    let view = w.bounds;
    let mut attempt = 0;
    loop {
        let mut shown: Vec<Hit<IUIAutomationElement>> = Vec::new();
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
            let item = p::hit(&rank::clean_line(&text), score, role, b, "uia");
            let hit = Hit { score, web: n.in_web, area: b.area(), item, el: n.el.clone() };
            if on_screen {
                shown.push(hit);
            } else if hidden.len() < 50 {
                hidden.push(hit);
            }
        })?;
        if retry_empty_page(nudged, &end, attempt, budget) {
            attempt += 1;
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        rank::sort_hits(&mut shown);
        rank::sort_hits(&mut hidden);
        shown.truncate(PER_WINDOW);
        return Ok(WinSearch { shown, hidden, stop: end.stop });
    }
}

fn doc_hit(n: &Node) -> bool {
    !n.in_web && (n.ct == roles::DOCUMENT || n.ct == roles::EDIT)
}
