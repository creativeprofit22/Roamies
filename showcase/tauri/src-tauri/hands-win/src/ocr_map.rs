// OCR results (lines of words with rects in the recognised image's pixels) mapped to physical screen pixels,
// and find-text matching on them. Pure, so it builds and tests on any system; ocr.rs feeds it on Windows.
use crate::geom::Rect;
use crate::rank;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct RectF {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, Default)]
pub struct RawWord {
    pub text: String,
    pub rect: RectF,
}

#[derive(Clone, Debug, Default)]
pub struct RawLine {
    pub text: String,
    pub words: Vec<RawWord>,
}

/// Where the recognised image sits on screen: it covers `frame`, shrunk by `scale` (OCR pixels per screen
/// pixel; 1 unless the image was downscaled to the engine's size limit).
#[derive(Clone, Copy, Debug)]
pub struct Mapping {
    pub frame: Rect,
    pub scale: f64,
}

impl Mapping {
    pub fn new(frame: Rect, scale: f64) -> Self {
        Mapping { frame, scale: if scale.is_finite() && scale > 0.0 { scale } else { 1.0 } }
    }

    /// An image rect on screen, rounded and kept inside the frame; None when it falls outside.
    pub fn to_screen(self, r: RectF) -> Option<Rect> {
        let (ox, oy, s) = (self.frame.x as f64, self.frame.y as f64, self.scale);
        let edge = |o: f64, v: f64| (o + v / s).round().clamp(i32::MIN as f64, i32::MAX as f64) as i32;
        let l = edge(ox, r.x);
        let t = edge(oy, r.y);
        let rr = edge(ox, r.x + r.w);
        let b = edge(oy, r.y + r.h);
        Rect::from_ltrb(l, t, rr, b)?.clamp_to(&self.frame)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub text: String,
    pub bounds: Rect,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub text: String,
    pub bounds: Rect,
    pub words: Vec<Word>,
}

pub fn union(rects: impl IntoIterator<Item = Rect>) -> Option<Rect> {
    let mut it = rects.into_iter();
    let first = it.next()?;
    let (mut l, mut t, mut r, mut b) = (first.x as i64, first.y as i64, first.right(), first.bottom());
    for x in it {
        l = l.min(x.x as i64);
        t = t.min(x.y as i64);
        r = r.max(x.right());
        b = b.max(x.bottom());
    }
    Some(Rect::new(l as i32, t as i32, (r - l) as i32, (b - t) as i32))
}

/// Lines with screen rects; words that land outside the frame are dropped, and so are empty lines.
pub fn map_lines(raw: &[RawLine], m: &Mapping) -> Vec<Line> {
    raw.iter()
        .filter_map(|l| {
            let words: Vec<Word> = l
                .words
                .iter()
                .filter_map(|w| {
                    let text = w.text.trim();
                    if text.is_empty() {
                        return None;
                    }
                    Some(Word { text: text.to_string(), bounds: m.to_screen(w.rect)? })
                })
                .collect();
            let bounds = union(words.iter().map(|w| w.bounds))?;
            let text = rank::clean_line(&l.text);
            let text = if text.is_empty() { words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ") } else { text };
            Some(Line { text, bounds, words })
        })
        .collect()
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

/// The part of a line that holds `q`: the union of the fewest consecutive words that contain it (spaces
/// ignored, so scripts without spaces between words work too); the whole line when no run does.
pub fn narrow(line: &Line, q: &str) -> Rect {
    let q = squash(q);
    if q.is_empty() {
        return line.bounds;
    }
    let mut best: Option<(usize, usize)> = None;
    for i in 0..line.words.len() {
        let mut run = String::new();
        for j in i..line.words.len() {
            if best.is_some_and(|(a, b)| j - i >= b - a) {
                break;
            }
            run.push_str(&squash(&line.words[j].text));
            if run.contains(&q) {
                best = Some((i, j));
                break;
            }
        }
    }
    best.and_then(|(i, j)| union(line.words[i..=j].iter().map(|w| w.bounds))).unwrap_or(line.bounds)
}

#[derive(Clone, Debug, PartialEq)]
pub struct OcrHit {
    pub text: String,
    pub score: u8,
    pub bounds: Rect,
}

/// Lines that contain `q`, scored like UI Automation text (exact, word, partial on the whole line), best
/// and then smallest first, each boxed around the matching words.
pub fn find(lines: &[Line], q: &str) -> Vec<OcrHit> {
    let mut hits: Vec<rank::Hit<OcrHit>> = Vec::new();
    for l in lines {
        let Some(score) = rank::score(&l.text, q) else { continue };
        let bounds = narrow(l, q);
        hits.push(rank::Hit { score, web: false, area: bounds.area(), item: Value::Null, el: OcrHit { text: l.text.clone(), score, bounds } });
    }
    rank::sort_hits(&mut hits);
    hits.into_iter().map(|h| h.el).collect()
}

pub fn line_json(l: &Line) -> Value {
    let words: Vec<Value> = l.words.iter().map(|w| json!({"text": w.text, "bounds": w.bounds.json()})).collect();
    json!({"text": l.text, "bounds": l.bounds.json(), "words": words})
}

/// Lines as (y, x, text) for rank::order_lines.
pub fn positioned(lines: &[Line]) -> Vec<(i32, i32, String)> {
    lines.iter().map(|l| (l.bounds.y, l.bounds.x, l.text.clone())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rf(x: f64, y: f64, w: f64, h: f64) -> RectF {
        RectF { x, y, w, h }
    }

    fn line(text: &str, words: &[(&str, RectF)]) -> RawLine {
        RawLine { text: text.into(), words: words.iter().map(|(t, r)| RawWord { text: t.to_string(), rect: *r }).collect() }
    }

    #[test]
    fn maps_with_the_frame_origin() {
        let m = Mapping::new(Rect::new(100, 50, 800, 600), 1.0);
        assert_eq!(m.to_screen(rf(10.0, 20.0, 30.0, 12.0)), Some(Rect::new(110, 70, 30, 12)));
        assert_eq!(m.to_screen(rf(10.4, 20.6, 29.2, 11.8)), Some(Rect::new(110, 71, 30, 11)));
    }

    #[test]
    fn maps_a_left_monitor_with_negative_origin() {
        let m = Mapping::new(Rect::new(-1920, -200, 1920, 1080), 1.0);
        assert_eq!(m.to_screen(rf(0.0, 0.0, 100.0, 40.0)), Some(Rect::new(-1920, -200, 100, 40)));
        assert_eq!(m.to_screen(rf(1820.0, 1000.0, 100.0, 80.0)), Some(Rect::new(-100, 800, 100, 80)));
    }

    #[test]
    fn undoes_a_downscale() {
        // A 4000 px wide frame recognised at 2000 px: every image pixel is two screen pixels.
        let m = Mapping::new(Rect::new(-4000, 0, 4000, 2000), 0.5);
        assert_eq!(m.to_screen(rf(100.0, 50.0, 25.0, 10.0)), Some(Rect::new(-3800, 100, 50, 20)));
        assert_eq!(Mapping::new(Rect::new(0, 0, 10, 10), 0.0).scale, 1.0, "a bad scale falls back to 1:1");
    }

    #[test]
    fn clamps_to_the_frame() {
        let m = Mapping::new(Rect::new(0, 0, 200, 100), 1.0);
        assert_eq!(m.to_screen(rf(180.0, 90.0, 50.0, 30.0)), Some(Rect::new(180, 90, 20, 10)));
        assert_eq!(m.to_screen(rf(300.0, 10.0, 5.0, 5.0)), None);
        assert_eq!(m.to_screen(rf(10.0, 10.0, 0.2, 5.0)), None, "rounds to nothing");
    }

    #[test]
    fn groups_lines_and_drops_what_falls_outside() {
        let m = Mapping::new(Rect::new(1000, 0, 500, 100), 1.0);
        let raw = vec![
            line("Hello  world", &[("Hello", rf(10.0, 10.0, 50.0, 20.0)), ("world", rf(70.0, 12.0, 55.0, 20.0)), ("x", rf(900.0, 0.0, 5.0, 5.0))]),
            line("", &[("  ", rf(1.0, 1.0, 5.0, 5.0))]),
            line("", &[("Only", rf(10.0, 60.0, 40.0, 20.0))]),
        ];
        let lines = map_lines(&raw, &m);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "Hello world");
        assert_eq!(lines[0].words.len(), 2);
        assert_eq!(lines[0].bounds, Rect::new(1010, 10, 115, 22));
        assert_eq!(lines[1].text, "Only", "an empty line text is rebuilt from its words");
        let v = line_json(&lines[0]);
        assert_eq!(v["bounds"], json!([1010, 10, 115, 22]));
        assert_eq!(v["words"][1], json!({"text": "world", "bounds": [1070, 12, 55, 20]}));
        assert_eq!(positioned(&lines)[1], (60, 1010, "Only".to_string()));
    }

    fn mapped(text: &str, words: &[(&str, RectF)]) -> Line {
        map_lines(&[line(text, words)], &Mapping::new(Rect::new(0, 0, 2000, 2000), 1.0)).remove(0)
    }

    #[test]
    fn narrows_to_the_matching_words() {
        let l = mapped(
            "Big Buck Bunny trailer",
            &[("Big", rf(0.0, 0.0, 30.0, 20.0)), ("Buck", rf(40.0, 0.0, 40.0, 20.0)), ("Bunny", rf(90.0, 2.0, 50.0, 20.0)), ("trailer", rf(150.0, 0.0, 60.0, 20.0))],
        );
        assert_eq!(narrow(&l, "buck bunny"), Rect::new(40, 0, 100, 22));
        assert_eq!(narrow(&l, "unn"), Rect::new(90, 2, 50, 20));
        assert_eq!(narrow(&l, "  "), l.bounds);
        assert_eq!(narrow(&l, "nope"), l.bounds);
        // No spaces between words (CJK): still narrows.
        let cjk = mapped("東京駅", &[("東京", rf(0.0, 0.0, 40.0, 20.0)), ("駅", rf(40.0, 0.0, 20.0, 20.0))]);
        assert_eq!(narrow(&cjk, "京駅"), Rect::new(0, 0, 60, 20));
    }

    #[test]
    fn finds_like_ui_automation_text() {
        let lines = vec![
            mapped("Save as draft", &[("Save", rf(0.0, 100.0, 40.0, 20.0)), ("as", rf(50.0, 100.0, 20.0, 20.0)), ("draft", rf(80.0, 100.0, 40.0, 20.0))]),
            mapped("Save", &[("Save", rf(0.0, 0.0, 40.0, 20.0))]),
            mapped("Unsaved", &[("Unsaved", rf(0.0, 50.0, 70.0, 20.0))]),
            mapped("Cancel", &[("Cancel", rf(0.0, 200.0, 60.0, 20.0))]),
        ];
        let hits = find(&lines, "save");
        let got: Vec<(&str, u8)> = hits.iter().map(|h| (h.text.as_str(), h.score)).collect();
        assert_eq!(got, [("Save", 0), ("Save as draft", 1), ("Unsaved", 2)]);
        assert_eq!(hits[1].bounds, Rect::new(0, 100, 40, 20), "boxed around the word, not the line");
        assert!(find(&lines, "zzz").is_empty());
    }

    #[test]
    fn unions_rects() {
        assert_eq!(union([Rect::new(0, 0, 10, 10), Rect::new(-5, 20, 5, 5)]), Some(Rect::new(-5, 0, 15, 25)));
        assert_eq!(union(Vec::<Rect>::new()), None);
    }
}
