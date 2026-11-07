// UI Automation reading. Parts adapted from trycua/cua platform-windows/src/uia/mod.rs (MIT, Copyright (c) 2025
// Cua AI, Inc.; see licenses/cua-LICENSE.txt): one cache request for every property read, and a walk that
// fetches one level per call. Never TreeScope_Subtree/Descendants: a provider may build an unbounded subtree
// in one call (a stalled Chromium renderer then times out the whole walk and returns nothing).
use crate::budget::{Budget, Stop};
use crate::geom::Rect;
use crate::protocol::fail;
use crate::roles;
use serde_json::Value;
use std::time::Duration;
use w32::core::{Interface, BSTR};
use w32::Win32::Foundation::{E_ACCESSDENIED, HWND, LPARAM, WPARAM};
use w32::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, SAFEARRAY};
use w32::Win32::System::Ole::{SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetUBound, SafeArrayUnaccessData};
use w32::Win32::System::Variant::{VARIANT, VT_BOOL, VT_BSTR, VT_I4};
use w32::Win32::UI::Accessibility::*;
use w32::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_GETOBJECT};

const MAX_DEPTH: usize = 60;
const OBJID_CLIENT: i32 = -4;

#[derive(Clone)]
pub struct Node {
    pub el: IUIAutomationElement,
    pub ct: i32,
    pub name: String,
    pub value: Option<String>,
    pub help: String,
    pub bounds: Option<Rect>,
    pub offscreen: bool,
    pub enabled: bool,
    pub focused: bool,
    pub password: bool,
    pub heading: bool,
    pub in_web: bool,
    /// Rich-text box with no ValuePattern (YouTube's comment box): its text isn't read-only.
    pub editable: bool,
}

impl Node {
    pub fn role(&self) -> &'static str {
        if self.editable {
            return roles::name(roles::EDIT, self.password, false);
        }
        roles::name(self.ct, self.password, self.heading)
    }

    /// The texts find-text looks at, like the macOS value/title/description; a password's value never.
    pub fn texts(&self) -> Vec<&str> {
        // Name first: a link's value is its URL, not what the user sees.
        let mut t: Vec<&str> = vec![&self.name];
        if !self.password {
            if let Some(v) = self.value.as_deref() {
                t.push(v);
            }
        }
        t.push(&self.help);
        t.into_iter().filter(|s| !s.trim().is_empty()).collect()
    }
}

#[derive(Default, Debug)]
pub struct WalkEnd {
    pub stop: Option<Stop>,
    pub docs: usize,
    pub web_nodes: usize,
}

pub struct Uia {
    auto: IUIAutomation,
    req: IUIAutomationCacheRequest,
    cond: IUIAutomationCondition,
}

fn is_timeout(e: &w32::core::Error) -> bool {
    e.code().0 as u32 == UIA_E_TIMEOUT
}

fn bstr_variant(v: &VARIANT) -> Option<String> {
    if v.vt() != VT_BSTR {
        return None;
    }
    BSTR::try_from(v).ok().map(|b| b.to_string()).filter(|s| !s.trim().is_empty())
}

fn bool_variant(v: &VARIANT) -> Option<bool> {
    if v.vt() != VT_BOOL {
        return None;
    }
    bool::try_from(v).ok()
}

fn i32_variant(v: &VARIANT) -> Option<i32> {
    if v.vt() != VT_I4 {
        return None;
    }
    i32::try_from(v).ok()
}

impl Uia {
    pub fn new(budget: &Budget) -> Result<Uia, Value> {
        let unavailable = |e: w32::core::Error| fail("unavailable", &format!("UI Automation isn't available: {e}"));
        unsafe {
            let auto: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).map_err(unavailable)?;
            // A hung provider gives up after this long instead of blocking the walk.
            if let Ok(a2) = auto.cast::<IUIAutomation2>() {
                let ms = budget.remaining().min(Duration::from_secs(2)).as_millis().max(200) as u32;
                let _ = a2.SetConnectionTimeout(ms);
                let _ = a2.SetTransactionTimeout(ms);
            }
            let req = auto.CreateCacheRequest().map_err(unavailable)?;
            for p in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_IsEnabledPropertyId,
                UIA_ValueValuePropertyId,
                UIA_IsPasswordPropertyId,
                UIA_HelpTextPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_HeadingLevelPropertyId,
                UIA_ClassNamePropertyId,
                UIA_IsKeyboardFocusablePropertyId,
                UIA_IsTextPatternAvailablePropertyId,
            ] {
                let _ = req.AddProperty(p);
            }
            let _ = req.SetTreeScope(TreeScope_Element);
            let _ = req.SetAutomationElementMode(AutomationElementMode_Full);
            let cond = auto.ControlViewCondition().map_err(unavailable)?;
            Ok(Uia { auto, req, cond })
        }
    }

    fn read(&self, el: IUIAutomationElement, in_web: bool) -> Node {
        unsafe {
            let ct = el.CachedControlType().map(|c| c.0).unwrap_or(0);
            let name = el.CachedName().map(|b| b.to_string()).unwrap_or_default();
            let help = el.CachedHelpText().map(|b| b.to_string()).unwrap_or_default();
            let password = el.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false);
            let value = if password { None } else { el.GetCachedPropertyValue(UIA_ValueValuePropertyId).ok().and_then(|v| bstr_variant(&v)) };
            let heading = el.GetCachedPropertyValue(UIA_HeadingLevelPropertyId).ok().and_then(|v| i32_variant(&v)).is_some_and(|l| l > roles::HEADING_NONE);
            let bounds = el.CachedBoundingRectangle().ok().and_then(|r| Rect::from_ltrb(r.left, r.top, r.right, r.bottom));
            let focusable = el.CachedIsKeyboardFocusable().map(|b| b.as_bool()).unwrap_or(false);
            let has_text = el.GetCachedPropertyValue(UIA_IsTextPatternAvailablePropertyId).ok().and_then(|v| bool_variant(&v)).unwrap_or(false);
            let editable = roles::may_be_rich_text(ct, focusable, has_text) && text_writable(&el);
            Node {
                ct,
                name,
                value,
                help,
                bounds,
                offscreen: el.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false),
                enabled: el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true),
                focused: el.CachedHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false),
                password,
                heading,
                in_web,
                editable,
                el,
            }
        }
    }

    /// Walks the window's tree one level per call, depth first, page content (under a Document) before the
    /// browser's own toolbar, stopping at the budget. Each node goes to `visit` once.
    pub fn walk(&self, hwnd: HWND, budget: &mut Budget, visit: &mut dyn FnMut(&Node)) -> Result<WalkEnd, Value> {
        let mut end = WalkEnd::default();
        let root = match unsafe { self.auto.ElementFromHandleBuildCache(hwnd, &self.req) } {
            Ok(r) => r,
            Err(e) if e.code() == E_ACCESSDENIED => return Err(access_denied(None)),
            Err(e) if is_timeout(&e) => {
                end.stop = Some(Stop::Time);
                return Ok(end);
            }
            Err(e) => return Err(fail("unavailable", &format!("This window can't be read: {e}"))),
        };
        let mut web: Vec<(IUIAutomationElement, usize)> = Vec::new();
        let mut native: Vec<(IUIAutomationElement, usize)> = vec![(root, 0)];
        loop {
            let (el, depth, in_web) = match web.pop() {
                Some((e, d)) => (e, d, true),
                None => match native.pop() {
                    Some((e, d)) => (e, d, false),
                    None => break,
                },
            };
            if let Err(s) = budget.tick() {
                end.stop = Some(s);
                break;
            }
            let node = self.read(el, in_web);
            if in_web {
                end.web_nodes += 1;
            }
            if node.ct == roles::DOCUMENT {
                end.docs += 1;
            }
            visit(&node);
            if depth >= MAX_DEPTH {
                continue;
            }
            let kids = match unsafe { node.el.FindAllBuildCache(TreeScope_Children, &self.cond, &self.req) } {
                Ok(k) => k,
                Err(e) if e.code() == E_ACCESSDENIED && depth == 0 => return Err(access_denied(None)),
                Err(e) if is_timeout(&e) && budget.expired() => {
                    end.stop = Some(Stop::Time);
                    break;
                }
                Err(_) => continue,
            };
            let child_web = in_web || node.ct == roles::DOCUMENT;
            let n = unsafe { kids.Length() }.unwrap_or(0);
            for i in (0..n).rev() {
                if let Ok(k) = unsafe { kids.GetElement(i) } {
                    if child_web {
                        web.push((k, depth + 1));
                    } else {
                        native.push((k, depth + 1));
                    }
                }
            }
        }
        Ok(end)
    }

    /// Where `q` is inside an editor's text (Notepad, rich edits): the line it's on and its exact rect.
    pub fn text_in_document(&self, node: &Node, q: &str) -> Option<(String, Rect)> {
        if node.in_web || !(node.ct == roles::DOCUMENT || node.ct == roles::EDIT) || node.password {
            return None;
        }
        unsafe {
            let tp: IUIAutomationTextPattern = node.el.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
            let found = tp.DocumentRange().ok()?.FindText(&BSTR::from(q.trim()), false, true).ok()?;
            let rect = first_rect(found.GetBoundingRectangles().ok()?)?;
            let line = found.Clone().ok()?;
            let _ = line.ExpandToEnclosingUnit(TextUnit_Line);
            let text = line.GetText(400).map(|b| b.to_string()).unwrap_or_default();
            let text = if text.trim().is_empty() { q.to_string() } else { text };
            Some((text, rect))
        }
    }

    /// Scrolls an element (or one of its 4 nearest ancestors) into view; true when something scrolled.
    pub fn scroll_into_view(&self, el: &IUIAutomationElement) -> bool {
        unsafe {
            let Ok(walker) = self.auto.ControlViewWalker() else { return false };
            let mut cur = Some(el.clone());
            for _ in 0..5 {
                let Some(c) = cur else { break };
                if let Ok(p) = c.GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId) {
                    if p.ScrollIntoView().is_ok() {
                        return true;
                    }
                }
                cur = walker.GetParentElement(&c).ok();
            }
            false
        }
    }

    /// The element with keyboard focus right now, anywhere on the desktop.
    pub fn focused_element(&self) -> Option<IUIAutomationElement> {
        unsafe { self.auto.GetFocusedElement().ok() }
    }

    pub fn parent(&self, el: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        unsafe { self.auto.ControlViewWalker().ok()?.GetParentElement(el).ok() }
    }

    /// A fresh read of one element (same properties as the walk), e.g. after it was focused or changed.
    pub fn node_of(&self, el: &IUIAutomationElement) -> Option<Node> {
        let fresh = unsafe { el.BuildUpdatedCache(&self.req) }.ok()?;
        Some(self.read(fresh, false))
    }

    /// Walks below one element (a dropdown's options) the same one-level-per-call way as `walk`.
    pub fn walk_below(&self, el: &IUIAutomationElement, budget: &mut Budget, visit: &mut dyn FnMut(&Node)) {
        let mut stack: Vec<(IUIAutomationElement, usize)> = vec![(el.clone(), 0)];
        while let Some((cur, depth)) = stack.pop() {
            if budget.tick().is_err() {
                return;
            }
            if depth > 0 {
                let Ok(c) = (unsafe { cur.BuildUpdatedCache(&self.req) }) else { continue };
                visit(&self.read(c, false));
            }
            if depth >= MAX_DEPTH {
                continue;
            }
            let Ok(kids) = (unsafe { cur.FindAll(TreeScope_Children, &self.cond) }) else { continue };
            let n = unsafe { kids.Length() }.unwrap_or(0);
            for i in (0..n).rev() {
                if let Ok(k) = unsafe { kids.GetElement(i) } {
                    stack.push((k, depth + 1));
                }
            }
        }
    }
}

// Pattern calls used by `act`. Adapted from trycua/cua platform-windows/src/browser_setup_ui.rs (MIT, Copyright
// (c) 2025 Cua AI, Inc.; see licenses/cua-LICENSE.txt): get the pattern, call it, read the state back.

/// What a pattern call did. `Busy` is a UIA timeout: the app is handling it (often a dialog it opened).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Did {
    Missing,
    Done,
    Busy,
    Failed,
}

fn did(r: w32::core::Result<()>) -> Did {
    match r {
        Ok(()) => Did::Done,
        Err(e) if is_timeout(&e) => Did::Busy,
        Err(_) => Did::Failed,
    }
}

fn pattern<T: Interface>(el: &IUIAutomationElement, id: UIA_PATTERN_ID) -> Option<T> {
    unsafe { el.GetCurrentPatternAs::<T>(id) }.ok()
}

pub fn invoke(el: &IUIAutomationElement) -> Did {
    match pattern::<IUIAutomationInvokePattern>(el, UIA_InvokePatternId) {
        Some(p) => did(unsafe { p.Invoke() }),
        None => Did::Missing,
    }
}

/// Toggles a checkbox or switch; Done only when the state read back has changed.
pub fn toggle(el: &IUIAutomationElement) -> Did {
    let Some(p) = pattern::<IUIAutomationTogglePattern>(el, UIA_TogglePatternId) else { return Did::Missing };
    unsafe {
        let before = p.CurrentToggleState().ok();
        match did(p.Toggle()) {
            Did::Done => {}
            other => return other,
        }
        if before.is_some() && p.CurrentToggleState().ok() == before { Did::Failed } else { Did::Done }
    }
}

/// Selects a radio button, tab, list item or option; Done only when it reads back as selected.
pub fn select(el: &IUIAutomationElement) -> Did {
    let Some(p) = pattern::<IUIAutomationSelectionItemPattern>(el, UIA_SelectionItemPatternId) else { return Did::Missing };
    unsafe {
        match did(p.Select()) {
            Did::Done => {}
            other => return other,
        }
        match p.CurrentIsSelected() {
            Ok(b) if !b.as_bool() => Did::Failed,
            _ => Did::Done,
        }
    }
}

pub fn expand(el: &IUIAutomationElement) -> Did {
    let Some(p) = pattern::<IUIAutomationExpandCollapsePattern>(el, UIA_ExpandCollapsePatternId) else { return Did::Missing };
    unsafe {
        match p.CurrentExpandCollapseState() {
            Ok(s) if s == ExpandCollapseState_LeafNode => Did::Missing,
            Ok(s) if s == ExpandCollapseState_Expanded => Did::Done,
            _ => did(p.Expand()),
        }
    }
}

/// The text a field shows through ValuePattern (None when it has none).
pub fn value_get(el: &IUIAutomationElement) -> Option<String> {
    let p = pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId)?;
    unsafe { p.CurrentValue() }.ok().map(|b| b.to_string())
}

/// True when the element takes a value (has ValuePattern and isn't read-only).
pub fn value_writable(el: &IUIAutomationElement) -> bool {
    pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId).is_some_and(|p| unsafe { p.CurrentIsReadOnly() }.is_ok_and(|r| !r.as_bool()))
}

pub fn value_set(el: &IUIAutomationElement, text: &str) -> Did {
    let Some(p) = pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId) else { return Did::Missing };
    if unsafe { p.CurrentIsReadOnly() }.is_ok_and(|r| r.as_bool()) {
        return Did::Missing;
    }
    did(unsafe { p.SetValue(&BSTR::from(text)) })
}

/// True when TextPattern says the text isn't read-only (Chrome's contenteditable); mixed or missing is false.
pub fn text_writable(el: &IUIAutomationElement) -> bool {
    let Some(tp) = pattern::<IUIAutomationTextPattern>(el, UIA_TextPatternId) else { return false };
    let ro = unsafe { tp.DocumentRange().and_then(|r| r.GetAttributeValue(UIA_IsReadOnlyAttributeId)) };
    ro.ok().and_then(|v| bool_variant(&v)) == Some(false)
}

/// The whole text of an editor or page through TextPattern, at most `max` UTF-16 units.
pub fn text_of(el: &IUIAutomationElement, max: i32) -> Option<String> {
    let tp = pattern::<IUIAutomationTextPattern>(el, UIA_TextPatternId)?;
    unsafe { tp.DocumentRange().ok()?.GetText(max).ok() }.map(|b| b.to_string())
}

/// Scrolls one step with ScrollPattern; Missing when the element can't scroll that way.
pub fn scroll(el: &IUIAutomationElement, down: bool, right: bool, horizontal: bool, large: bool) -> Did {
    let Some(p) = pattern::<IUIAutomationScrollPattern>(el, UIA_ScrollPatternId) else { return Did::Missing };
    let can = unsafe { if horizontal { p.CurrentHorizontallyScrollable() } else { p.CurrentVerticallyScrollable() } };
    if !can.is_ok_and(|b| b.as_bool()) {
        return Did::Missing;
    }
    let amount = match (if horizontal { right } else { down }, large) {
        (true, true) => ScrollAmount_LargeIncrement,
        (true, false) => ScrollAmount_SmallIncrement,
        (false, true) => ScrollAmount_LargeDecrement,
        (false, false) => ScrollAmount_SmallDecrement,
    };
    let (h, v) = if horizontal { (amount, ScrollAmount_NoAmount) } else { (ScrollAmount_NoAmount, amount) };
    did(unsafe { p.Scroll(h, v) })
}

pub fn set_focus(el: &IUIAutomationElement) -> bool {
    unsafe { el.SetFocus() }.is_ok()
}

pub fn has_focus(el: &IUIAutomationElement) -> bool {
    unsafe { el.CurrentHasKeyboardFocus() }.is_ok_and(|b| b.as_bool())
}

pub fn current_rect(el: &IUIAutomationElement) -> Option<Rect> {
    let r = unsafe { el.CurrentBoundingRectangle() }.ok()?;
    Rect::from_ltrb(r.left, r.top, r.right, r.bottom).filter(|b| b.w > 1 && b.h > 1)
}

pub fn process_id(el: &IUIAutomationElement) -> Option<u32> {
    unsafe { el.CurrentProcessId() }.ok().and_then(|p| u32::try_from(p).ok())
}

/// The first of the [left, top, width, height, ...] doubles UIA returns for a text range.
unsafe fn first_rect(sa: *mut SAFEARRAY) -> Option<Rect> {
    if sa.is_null() {
        return None;
    }
    let mut out = None;
    if let Ok(ub) = SafeArrayGetUBound(sa, 1) {
        let mut data = std::ptr::null_mut();
        if ub >= 3 && SafeArrayAccessData(sa, &mut data).is_ok() {
            let d = std::slice::from_raw_parts(data as *const f64, 4);
            out = Rect::from_ltrb(d[0] as i32, d[1] as i32, (d[0] + d[2]) as i32, (d[1] + d[3]) as i32);
            let _ = SafeArrayUnaccessData(sa);
        }
    }
    let _ = SafeArrayDestroy(sa);
    out
}

pub fn access_denied(app: Option<&str>) -> Value {
    let who = app.unwrap_or("This app");
    fail(
        "access_denied",
        &format!("{who} runs as administrator, so Roamies can't read it. Use a screenshot instead, or restart it without admin rights."),
    )
}

/// Chromium and Electron build their page tree only once a client asks: poke each page widget, without
/// waiting more than 200 ms on a hung renderer.
pub fn nudge_browser(top: HWND) -> bool {
    let widgets = crate::windows::children_with_class(top, "Chrome_RenderWidgetHostHWND");
    for w in &widgets {
        for id in [UiaRootObjectId, OBJID_CLIENT] {
            let mut res = 0usize;
            unsafe { SendMessageTimeoutW(*w, WM_GETOBJECT, WPARAM(0), LPARAM(id as isize), SMTO_ABORTIFHUNG, 200, Some(&mut res)) };
        }
    }
    !widgets.is_empty()
}
