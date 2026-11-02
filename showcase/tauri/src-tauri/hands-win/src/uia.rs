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
use w32::Win32::System::Variant::{VARIANT, VT_BSTR, VT_I4};
use w32::Win32::UI::Accessibility::*;
use w32::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_GETOBJECT};

const MAX_DEPTH: usize = 60;
const OBJID_CLIENT: i32 = -4;

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
}

impl Node {
    pub fn role(&self) -> &'static str {
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
