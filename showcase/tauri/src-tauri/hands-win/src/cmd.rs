// The verbs: windows, locate, capture, ui, locate-control, find-text, select and trusted (with an OCR fallback for apps that share no text),
// plus the test-only ocr-file. Runs on the budget's worker thread.
use crate::budget::{publish, Budget, Snapshot, Stop};
use crate::cli::{Cmd, Verb, FIND_NODES_PER_WINDOW, FIND_WINDOWS, UI_NODES};
use crate::com::ComGuard;
use crate::geom::Rect;
use crate::protocol::{self as p, fail, WinInfo};
use crate::rank::{self, Hit};
use crate::target::{app_matches, Target};
use crate::controls::{retry_empty_page, search_window, UiCollect, PER_WINDOW};
use crate::uia::{self, Node, Uia};
use crate::ocr::{self, Engine};
use crate::{capture, dpi, hands_off, ocr_map, windows};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};
use w32::Win32::UI::Accessibility::IUIAutomationElement;

const OCR_LINES: usize = 200;

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
        Verb::OcrFile { file, origin } => ocr_file(file, *origin, &budget),
        Verb::Image { input, out, crop, size, marks } => image(input, out, *crop, *size, marks.as_deref()),
        Verb::Act(plan) => Ok(crate::act::run(plan, fake, &budget, &snap)),
        Verb::Trusted => Ok(p::trusted_reply()),
        Verb::LocateControl { target, id } => resolve(target).and_then(|w| guard(&w, fake).map(|_| w)).and_then(|w| locate_control(&w, *id, &mut budget, &mons)),
        Verb::Select { out } => crate::select::run(out, c.fit, fake, &budget),
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
pub(crate) fn resolve(t: &Target) -> Result<WinInfo, Value> {
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

/// Walks the window the way `ui` does (same order, same ids); `progress` sees the list as it grows.
fn collect(w: &WinInfo, budget: &mut Budget, progress: &mut dyn FnMut(&UiCollect)) -> Result<(UiCollect, Option<Stop>), Value> {
    readable(w)?;
    let uia = Uia::new(budget)?;
    let hwnd = windows::hwnd(w.id);
    let mut attempt = 0;
    loop {
        let nudged = uia::nudge_browser(hwnd);
        let mut col = UiCollect::new(w.bounds);
        progress(&col);
        let mut count = 0usize;
        let mut b = budget.with_nodes(UI_NODES);
        let end = uia.walk(hwnd, &mut b, &mut |n: &Node| {
            col.visit(n);
            count += 1;
            if count.is_multiple_of(200) {
                progress(&col);
            }
        })?;
        if retry_empty_page(nudged, &end, attempt, budget) {
            attempt += 1;
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        return Ok((col, end.stop));
    }
}

fn ui(w: &WinInfo, budget: &mut Budget, snap: &Snapshot) -> Result<Value, Value> {
    let (col, mut stop) = collect(w, budget, &mut |col| publish(snap, col.reply(w)))?;
    let mut v = col.reply(w);
    if col.needs_ocr() {
        stop = stop.or(ocr_ui(w, &col, &mut v, budget)?);
    }
    p::mark_partial(&mut v, stop);
    Ok(v)
}

/// Where control `id` (as numbered by `ui`) is now, so the caller can point at it.
fn locate_control(w: &WinInfo, id: usize, budget: &mut Budget, mons: &[p::Monitor]) -> Result<Value, Value> {
    let (col, _) = collect(w, budget, &mut |_| {})?;
    let (c, _) = col.by_id(id).ok_or_else(|| fail("not_found", &format!("No control {id} in {}. Read the window again.", w.app)))?;
    Ok(p::locate_control_reply(w, &p::control(id, c), mons))
}

fn add_note(v: &mut Value, note: &str) {
    let n = v["note"].as_str().unwrap_or("");
    v["note"] = json!(if n.is_empty() { note.to_string() } else { format!("{n} {note}") });
}

/// `ui`'s fallback: reads the window's pixels and adds what it says to `texts` (and line rects as `ocr`).
/// Returns why it stopped early; ocr_unavailable only when UI Automation gave nothing either.
fn ocr_ui(w: &WinInfo, col: &UiCollect, v: &mut Value, budget: &Budget) -> Result<Option<Stop>, Value> {
    let engine = match Engine::new() {
        Ok(e) => e,
        Err(e) if !col.has_content() => return Err(e),
        Err(_) => {
            add_note(v, p::NO_OCR);
            return Ok(None);
        }
    };
    if budget.remaining() < ocr::MIN_LEFT {
        return Ok(Some(Stop::Time));
    }
    let t0 = Instant::now();
    let Ok((img, frame)) = capture::grab(w, budget) else { return Ok(None) };
    let read = match engine.read(img, frame, budget) {
        Ok(Some(r)) => r,
        Ok(None) => return Ok(Some(Stop::Time)),
        Err(_) => return Ok(None),
    };
    let lines = &read.lines[..read.lines.len().min(OCR_LINES)];
    let texts = if col.texts.is_empty() {
        rank::order_lines(ocr_map::positioned(lines), 5000)
    } else {
        let mut t: Vec<String> = v["texts"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect();
        for l in lines {
            if !col.seen.contains(&l.text) && !t.contains(&l.text) {
                t.push(l.text.clone());
            }
        }
        t
    };
    v["texts"] = json!(texts);
    v["ocr"] = Value::Array(lines.iter().map(ocr_map::line_json).collect());
    v["source"] = json!("ocr");
    p::mark_ocr(v, t0.elapsed().as_millis() as u64, &engine.lang);
    Ok(None)
}

/// find-text's fallback: windows where UI Automation found nothing on screen are read from their pixels,
/// front to back while time lasts. Returns how long that took and the language when OCR ran;
/// with no OCR language it's skipped, so a miss stays an ordinary empty result.
fn ocr_find(wins: &[WinInfo], skip: &[bool], q: &str, hits: &mut Vec<Value>, stop: &mut Option<Stop>, budget: &Budget, snap: &Snapshot) -> Result<Option<(u64, String)>, Value> {
    let with_hits: HashSet<i64> = hits.iter().filter_map(|m| m["window"]["id"].as_i64()).collect();
    let todo: Vec<usize> = (0..wins.len()).filter(|z| !skip[*z] && !with_hits.contains(&wins[*z].id)).collect();
    if todo.is_empty() {
        return Ok(None);
    }
    let Ok(engine) = Engine::new() else { return Ok(None) };
    let (mut ms, mut ran) = (0u64, false);
    for z in todo {
        if budget.remaining() < ocr::MIN_LEFT {
            *stop = stop.or(Some(Stop::Time));
            break;
        }
        let w = &wins[z];
        let t0 = Instant::now();
        let Ok((img, frame)) = capture::grab(w, budget) else { continue };
        let read = match engine.read(img, frame, budget) {
            Ok(Some(r)) => r,
            Ok(None) => {
                *stop = stop.or(Some(Stop::Time));
                break;
            }
            Err(_) => continue,
        };
        ms += t0.elapsed().as_millis() as u64;
        ran = true;
        for (i, h) in ocr_map::find(&read.lines, q).into_iter().take(PER_WINDOW).enumerate() {
            let mut m = p::hit(&h.text, h.score, "text", h.bounds, "ocr");
            m["window"] = p::win_info(w);
            m["rank"] = json!(z * 100 + i);
            hits.push(m);
        }
        // merge_windows wants front-to-back order.
        hits.sort_by_key(|m| m["rank"].as_u64());
        let mut snapshot = p::find_reply(rank::merge_windows(hits.clone(), q));
        p::mark_partial(&mut snapshot, *stop);
        p::mark_ocr(&mut snapshot, ms, &engine.lang);
        publish(snap, snapshot);
    }
    Ok(ran.then(|| (ms, engine.lang.clone())))
}

/// Test-only: OCR an image file as if it were a window at `origin`.
fn ocr_file(file: &str, origin: (i32, i32), budget: &Budget) -> Result<Value, Value> {
    if !std::path::Path::new(file).is_file() {
        return Err(fail("not_found", &format!("No image at {file}.")));
    }
    let img = ocr::load_image(file).map_err(|e| fail("ocr_failed", &e))?;
    let frame = Rect::new(origin.0, origin.1, img.w, img.h);
    let engine = Engine::new()?;
    let read = engine.read(img, frame, budget)?.ok_or_else(|| fail("timeout", "Not enough time left to read the image."))?;
    Ok(p::ocr_file_reply(&engine.lang, read.lines.iter().map(ocr_map::line_json).collect(), read.ms))
}

/// The `image` verb: crop (source pixels), resize to exactly `size`, draw numbered marks, write JPEG.
fn image(input: &str, out: &str, crop: Option<Rect>, size: Option<(u32, u32)>, marks: Option<&str>) -> Result<Value, Value> {
    let failed = |e: String| fail("image_failed", &e);
    if !std::path::Path::new(input).is_file() {
        return Err(fail("not_found", &format!("No image at {input}.")));
    }
    // Read the marks before any pixel work so a bad file fails fast.
    let marks = match marks {
        Some(f) => {
            let text = std::fs::read_to_string(f).map_err(|e| fail("not_found", &format!("Can't read marks {f}: {e}")))?;
            let v: Value = serde_json::from_str(&text).map_err(|e| fail("usage", &format!("Marks {f} isn't JSON: {e}")))?;
            crate::draw::parse_marks(&v).map_err(|e| fail("usage", &e))?
        }
        None => vec![],
    };
    let img = ocr::load_image(input).map_err(failed)?;
    let whole = Rect::new(0, 0, img.w, img.h);
    let img = match crop {
        Some(c) => {
            let inner = c.intersection(&whole).ok_or_else(|| fail("usage", &format!("--crop {},{},{},{} is outside the {}×{} image.", c.x, c.y, c.w, c.h, img.w, img.h)))?;
            capture::crop(img, whole, inner)
        }
        None => img,
    };
    let to = size.unwrap_or((img.w as u32, img.h as u32));
    let mut img = capture::scale_to(img, to).map_err(failed)?;
    crate::draw::draw_marks(&mut crate::draw::Canvas { bgra: &mut img.bgra, w: img.w, h: img.h }, &marks);
    capture::write_jpeg(out, &img).map_err(failed)?;
    Ok(p::image_reply(out, to))
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
            for (i, mut m) in r.shown.into_iter().map(|h| h.item).enumerate() {
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
    let ocr = ocr_find(&wins, &elevated, q, &mut hits, &mut stop, budget, snap)?;
    let mut v = p::find_reply(rank::merge_windows(hits, q));
    p::mark_partial(&mut v, stop);
    if let Some((ms, lang)) = ocr {
        p::mark_ocr(&mut v, ms, &lang);
    }
    Ok(v)
}
