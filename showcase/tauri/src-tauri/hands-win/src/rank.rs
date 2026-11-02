// Text matching and ordering, ported from findTextEls/pageText/offscreenText in hands/main.swift:
// exact text first, then a whole word, then any part; words on a web page before the browser's own;
// the smallest element (the text itself, not its container) first.
use serde_json::Value;

pub const MATCH_NAMES: [&str; 3] = ["exact", "word", "partial"];

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// 0 exact, 1 whole word, 2 partial, None when `text` doesn't contain `q` at all.
pub fn score(text: &str, q: &str) -> Option<u8> {
    let t = norm(text);
    let q = norm(q);
    if q.is_empty() || !t.contains(&q) {
        return None;
    }
    if t == q {
        return Some(0);
    }
    let whole = t.match_indices(&q).any(|(i, m)| {
        let before = t[..i].chars().next_back();
        let after = t[i + m.len()..].chars().next();
        before.is_none_or(|c| !is_word(c)) && after.is_none_or(|c| !is_word(c))
    });
    Some(if whole { 1 } else { 2 })
}

/// The element text that matches best (earlier texts win ties), or None when none contains `q`.
pub fn best_text<'a>(texts: &[&'a str], q: &str) -> Option<&'a str> {
    texts.iter().filter_map(|t| score(t, q).map(|s| (s, *t))).min_by_key(|(s, _)| *s).map(|(_, t)| t)
}

#[derive(Clone, Debug)]
pub struct Hit<E> {
    pub score: u8,
    pub web: bool,
    pub area: i64,
    pub item: Value,
    pub el: E,
}

/// Best first within one window: score, then web page before browser chrome, then smallest.
pub fn sort_hits<E>(hits: &mut [Hit<E>]) {
    hits.sort_by(|a, b| a.score.cmp(&b.score).then(b.web.cmp(&a.web)).then(a.area.cmp(&b.area)));
}

/// A whole label or heading, not the same words buried in a paragraph.
pub fn whole_match(m: &Value, q: &str) -> bool {
    m["match"].as_str() != Some("partial") || m["text"].as_str().unwrap_or("").chars().count() <= 40.max(q.trim().chars().count() * 3)
}

/// Across windows (already in front-to-back rank order): exact text anywhere beats a partial match in the
/// front window; 8 at most.
pub fn merge_windows(all: Vec<Value>, q: &str) -> Vec<Value> {
    let q = norm(q);
    let (exact, rest): (Vec<Value>, Vec<Value>) = all.into_iter().partition(|m| norm(m["text"].as_str().unwrap_or("")) == q);
    exact.into_iter().chain(rest).take(8).collect()
}

/// Collapses runs of whitespace; the line as shown in `texts`/`elsewhere`.
pub fn clean_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Visible text top to bottom, left to right, capped, with a note for what didn't fit.
pub fn order_lines(mut found: Vec<(i32, i32, String)>, cap: usize) -> Vec<String> {
    // Rows within 4 px count as one line.
    found.sort_by_key(|(y, x, _)| (y / 4, *x));
    let mut out = Vec::new();
    let mut total = 0;
    let n = found.len();
    for (k, (_, _, t)) in found.into_iter().enumerate() {
        let len = t.chars().count();
        if total + len > cap {
            out.push(format!("…({} more lines further down this screen; read_window shows them all)", n - k));
            break;
        }
        total += len + 1;
        out.push(t);
    }
    out
}

/// Off-screen text top to bottom; when it's long, the start and the end are kept with a note in between.
pub fn head_tail(mut found: Vec<(i32, String)>, cap: usize) -> Vec<String> {
    found.sort_by_key(|(y, _)| *y);
    let lines: Vec<String> = found.into_iter().map(|(_, t)| t).collect();
    let size = |l: &String| l.chars().count();
    if lines.iter().map(|l| size(l) + 1).sum::<usize>() <= cap {
        return lines;
    }
    let (mut head, mut h) = (Vec::new(), 0);
    for l in &lines {
        if h + size(l) > cap / 2 {
            break;
        }
        h += size(l) + 1;
        head.push(l.clone());
    }
    let (mut tail, mut t) = (Vec::new(), 0);
    for l in lines.iter().rev() {
        if t + size(l) > cap / 2 {
            break;
        }
        t += size(l) + 1;
        tail.insert(0, l.clone());
    }
    let between = lines.len().saturating_sub(head.len() + tail.len());
    let mut out = head;
    out.push(format!("…({between} more lines in between; point_at or click_text with their words scrolls there)"));
    out.extend(tail);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scores_exact_word_partial() {
        assert_eq!(score("  Sign in ", "sign in"), Some(0));
        assert_eq!(score("Please sign in now", "Sign in"), Some(1));
        assert_eq!(score("Signing in", "sign in"), None);
        assert_eq!(score("Designer", "sign"), Some(2));
        assert_eq!(score("sign-in page", "sign"), Some(1), "a hyphen is a word boundary");
        assert_eq!(score("v2.0.1 released", "2.0"), Some(2));
        assert_eq!(score("Café menu", "café"), Some(1));
        assert_eq!(score("anything", "  "), None);
        assert_eq!(score("x", "xyz"), None);
    }

    #[test]
    fn best_text_prefers_the_closest_then_the_first() {
        assert_eq!(best_text(&["Home", "https://x.com/home"], "home"), Some("Home"));
        assert_eq!(best_text(&["https://x.com/home", "Home"], "home"), Some("Home"));
        assert_eq!(best_text(&["go home", "home page"], "home"), Some("go home"));
        assert_eq!(best_text(&["a", "b"], "home"), None);
    }

    #[test]
    fn word_check_tries_every_occurrence() {
        assert_eq!(score("signs and sign", "sign"), Some(1));
    }

    fn h(score: u8, web: bool, area: i64, name: &str) -> Hit<()> {
        Hit { score, web, area, item: json!(name), el: () }
    }

    #[test]
    fn sorts_like_find_text_els() {
        let mut hits = vec![h(2, true, 10, "partial"), h(1, false, 50, "word-chrome"), h(1, true, 900, "word-web-big"), h(1, true, 40, "word-web-small"), h(0, false, 5000, "exact")];
        sort_hits(&mut hits);
        let order: Vec<&str> = hits.iter().map(|x| x.item.as_str().unwrap()).collect();
        assert_eq!(order, ["exact", "word-web-small", "word-web-big", "word-chrome", "partial"]);
    }

    #[test]
    fn merges_exact_from_any_window_first() {
        let all = vec![
            json!({"text": "Example Domain is here", "rank": 0}),
            json!({"text": "Example", "rank": 1}),
            json!({"text": " example domain ", "rank": 100}),
        ];
        let m = merge_windows(all, "Example Domain");
        let ranks: Vec<i64> = m.iter().map(|x| x["rank"].as_i64().unwrap()).collect();
        assert_eq!(ranks, [100, 0, 1]);
        let many: Vec<Value> = (0..20).map(|i| json!({"text": "x", "rank": i})).collect();
        assert_eq!(merge_windows(many, "y").len(), 8);
    }

    #[test]
    fn whole_match_rejects_buried_partials() {
        assert!(whole_match(&json!({"match": "word", "text": "a".repeat(300)}), "a"));
        assert!(whole_match(&json!({"match": "partial", "text": "Designer"}), "sign"));
        assert!(!whole_match(&json!({"match": "partial", "text": "z".repeat(41)}), "sign"));
    }

    #[test]
    fn orders_visible_lines_and_caps() {
        let lines = order_lines(vec![(100, 0, "second".into()), (8, 50, "first-b".into()), (10, 0, "first-a".into())], 100);
        assert_eq!(lines, ["first-a", "first-b", "second"]);
        let capped = order_lines(vec![(0, 0, "aaaa".into()), (10, 0, "bbbb".into())], 6);
        assert_eq!(capped[0], "aaaa");
        assert!(capped[1].starts_with("…(1 more"));
    }

    #[test]
    fn keeps_head_and_tail_of_long_offscreen_text() {
        let found: Vec<(i32, String)> = (0..10).map(|i| (i * 10, format!("line{i}"))).collect();
        let out = head_tail(found.clone(), 1000);
        assert_eq!(out.len(), 10);
        let out = head_tail(found, 24);
        assert_eq!(out.first().unwrap(), "line0");
        assert_eq!(out.last().unwrap(), "line9");
        assert!(out.iter().any(|l| l.contains("more lines in between")));
    }

    #[test]
    fn cleans_whitespace() {
        assert_eq!(clean_line("  a \n\t b  "), "a b");
    }
}
