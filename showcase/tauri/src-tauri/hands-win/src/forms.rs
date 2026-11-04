// Form logic of hands/main.swift that needs no app: folding labels, picking the field a label names
// (fieldFor, 305-331), the match nearest an anchor (nearestAfter, 439), read-back checks (1042, 1093) and
// where a click_at lands. Rects are physical pixels, like everything else in the helper.
use crate::geom::Rect;

/// Lowercased, without `*` and `:`, whitespace collapsed: "Email *:" and "email" are the same label.
pub fn fold(s: &str) -> String {
    let s = s.to_lowercase().replace(['*', ':'], "");
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A field the act verb could type into, as seen by the matcher.
pub struct Cand {
    /// Its label, the label without a " (…)" suffix, placeholder, name, help text: folded, non-empty.
    pub names: Vec<String>,
    pub rect: Option<Rect>,
    pub offscreen: bool,
}

/// The folded names of a control: `label` plus whatever else the app reports (placeholder, help text).
pub fn names_of(label: &str, extra: &[&str]) -> Vec<String> {
    let base = label.find(" (").map_or(label, |i| &label[..i]);
    let mut out: Vec<String> = Vec::new();
    for n in [label, base].into_iter().chain(extra.iter().copied()).map(fold) {
        if !n.is_empty() && !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// On-screen fields first, then those scrolled out of view, in control order.
fn order(cands: &[Cand]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..cands.len()).collect();
    idx.sort_by_key(|&i| cands[i].offscreen);
    idx
}

/// The field whose own name is `name`: an exact match, else one that starts with it (or that it starts with,
/// when that name has at least 4 characters).
pub fn by_name(cands: &[Cand], name: &str) -> Option<usize> {
    let q = fold(name);
    if q.is_empty() {
        return None;
    }
    let idx = order(cands);
    let exact = idx.iter().copied().find(|&i| cands[i].names.contains(&q));
    exact.or_else(|| {
        idx.into_iter().find(|&i| cands[i].names.iter().any(|n| n.starts_with(&q) || (q.starts_with(n.as_str()) && n.chars().count() >= 4)))
    })
}

/// The field next to a visible label that isn't linked to it: on the label's row to its right (within
/// 500 px), else stacked right under it (within 60 px, same left edge). A field on the row always wins.
pub fn by_label(cands: &[Cand], label: Rect) -> Option<usize> {
    let (mid_x, mid_y) = (label.x as f64 + label.w as f64 / 2.0, label.y as f64 + label.h as f64 / 2.0);
    let mut row: Option<(i64, usize)> = None;
    let mut under: Option<(i64, usize)> = None;
    for i in order(cands) {
        let Some(f) = cands[i].rect else { continue };
        let (fx, fy) = (f.x as f64, f.y as f64);
        if fx >= mid_x && fy <= mid_y && f.bottom() as f64 >= mid_y && (f.x as i64 - label.right()) < 500 {
            let d = f.x as i64 - label.right();
            if row.is_none_or(|(b, _)| d < b) {
                row = Some((d, i));
            }
        } else if f.y as i64 >= label.y as i64 + 2 && f.y as i64 - label.bottom() <= 60 && (f.x as i64 - label.x as i64).abs() <= 60 {
            let d = f.y as i64 - label.bottom();
            if under.is_none_or(|(b, _)| d < b) {
                under = Some((d, i));
            }
        }
    }
    row.or(under).map(|(_, i)| i)
}

/// Of many matches (every post's "Reply"), the one that belongs with the anchor: the first at or below the
/// anchor's top (a little sideways distance counts too), else the nearest one above.
pub fn nearest_after(anchor: Rect, rects: &[Option<Rect>]) -> Option<usize> {
    let placed: Vec<(usize, Rect)> = rects.iter().enumerate().filter_map(|(i, r)| r.map(|r| (i, r))).collect();
    let cost = |r: &Rect| (r.y - anchor.y) as f64 + ((r.x - anchor.x) as f64).abs() * 0.2;
    let below = placed.iter().filter(|(_, r)| r.y >= anchor.y - 4).min_by(|a, b| cost(&a.1).total_cmp(&cost(&b.1)));
    below.or_else(|| placed.iter().min_by_key(|(_, r)| anchor.y as i64 - r.bottom())).map(|(i, _)| *i)
}

/// The field shows what was put in (the start of it: fields may reformat or cut long text).
pub fn reads_back(shows: &str, text: &str) -> bool {
    let want: String = fold(text).chars().take(40).collect();
    // Clearing a field only worked when it now shows nothing.
    if want.is_empty() {
        return fold(shows).is_empty();
    }
    fold(shows).contains(&want)
}

/// Where a click_at lands on the virtual desktop: `global` points as given (the sidecar sends screenshot
/// pixels mapped to the desktop, like pointing does), else relative to the window's top-left. None when
/// the point is on no monitor.
pub fn click_point(x: f64, y: f64, global: bool, window: Rect, monitors: &[Rect]) -> Option<(i32, i32)> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let (gx, gy) = if global { (x, y) } else { (window.x as f64 + x, window.y as f64 + y) };
    let (px, py) = (gx.round(), gy.round());
    if px.abs() > i32::MAX as f64 || py.abs() > i32::MAX as f64 {
        return None;
    }
    let (px, py) = (px as i32, py as i32);
    monitors.iter().any(|m| m.contains(px, py)).then_some((px, py))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(label: &str, rect: Option<Rect>, offscreen: bool) -> Cand {
        Cand { names: names_of(label, &[]), rect, offscreen }
    }

    #[test]
    fn folds_labels() {
        assert_eq!(fold("  Email *:\n Address "), "email address");
        assert_eq!(names_of("Name (required)", &["", "Your name"]), vec!["name (required)", "name", "your name"]);
    }

    #[test]
    fn finds_fields_by_name_exact_then_prefix() {
        let c = vec![cand("Email address", None, false), cand("Email", None, true), cand("Phone", None, false)];
        assert_eq!(by_name(&c, "email:"), Some(1), "exact beats prefix, even off screen");
        assert_eq!(by_name(&c, "Pho"), Some(2));
        assert_eq!(by_name(&c, "Phone number"), Some(2), "a 4+ letter name the query starts with");
        let short = vec![cand("Ph", None, false)];
        assert_eq!(by_name(&short, "Phone"), None, "too short to count as a prefix");
        assert_eq!(by_name(&c, "  "), None);
    }

    #[test]
    fn on_screen_fields_come_first() {
        let c = vec![cand("Email address", None, true), cand("Email again", None, false)];
        assert_eq!(by_name(&c, "Email"), Some(1));
    }

    #[test]
    fn picks_the_field_on_the_label_row_before_the_one_below() {
        let label = Rect::new(100, 100, 80, 20);
        let c = vec![
            cand("", Some(Rect::new(100, 125, 200, 24)), false), // stacked under
            cand("", Some(Rect::new(400, 98, 200, 24)), false),  // same row, farther
            cand("", Some(Rect::new(200, 98, 200, 24)), false),  // same row, nearest
            cand("", Some(Rect::new(800, 98, 200, 24)), false),  // same row, too far
        ];
        assert_eq!(by_label(&c, label), Some(2));
        assert_eq!(by_label(&c[..1], label), Some(0));
        let next_column = vec![cand("", Some(Rect::new(400, 140, 200, 24)), false)];
        assert_eq!(by_label(&next_column, label), None, "lower but not under the label is another row's field");
        assert_eq!(by_label(&[cand("", Some(Rect::new(100, 200, 200, 24)), false)], label), None, "too far below");
    }

    #[test]
    fn nearest_after_prefers_below_then_above() {
        let anchor = Rect::new(0, 500, 100, 20);
        let r = vec![Some(Rect::new(0, 100, 50, 20)), Some(Rect::new(0, 700, 50, 20)), Some(Rect::new(0, 540, 50, 20)), None];
        assert_eq!(nearest_after(anchor, &r), Some(2));
        assert_eq!(nearest_after(anchor, &[Some(Rect::new(0, 100, 50, 20)), Some(Rect::new(0, 300, 50, 20))]), Some(1));
        assert_eq!(nearest_after(anchor, &[None]), None);
    }

    #[test]
    fn read_back_must_show_the_text() {
        assert!(reads_back("Ken  Tan", "ken tan"));
        assert!(reads_back("", ""));
        assert!(reads_back(&format!("{}...", "a".repeat(40)), &"a".repeat(80)), "only the first 40 characters count");
        assert!(!reads_back("", "hello"));
        assert!(!reads_back("hello", ""));
        assert!(!reads_back("old text", "new text"));
    }

    #[test]
    fn click_at_maps_window_or_global_points_onto_a_monitor() {
        let w = Rect::new(-1920, 100, 800, 600);
        let mons = [Rect::new(0, 0, 2560, 1440), Rect::new(-1920, 0, 1920, 1080)];
        assert_eq!(click_point(10.4, 20.6, false, w, &mons), Some((-1910, 121)));
        assert_eq!(click_point(300.0, 200.0, true, w, &mons), Some((300, 200)));
        assert_eq!(click_point(5000.0, 10.0, true, w, &mons), None, "off every monitor");
        assert_eq!(click_point(f64::NAN, 10.0, true, w, &mons), None);
    }
}
