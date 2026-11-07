// The size a screenshot is sent at: a port of resizedSize/roundTiesToEven in sidecar/pointing.mjs (Anthropic's
// resize rule). Both are checked against tests/fixtures/resize.json so they can't drift apart.

/// JS Math.round, except exact halves go to the even neighbour.
pub fn round_ties_to_even(v: f64) -> i64 {
    let f = v.floor();
    if v - f != 0.5 {
        return (v + 0.5).floor() as i64;
    }
    let f = f as i64;
    if f % 2 == 0 {
        f
    } else {
        f + 1
    }
}

fn fits(w: i64, h: i64, max_edge: i64, max_tokens: i64) -> bool {
    let (pw, ph) = ((w + 27) / 28, (h + 27) / 28);
    pw * 28 <= max_edge && ph * 28 <= max_edge && (max_tokens == 0 || pw * ph <= max_tokens)
}

/// The largest aspect-preserving size within `max_edge` and `max_tokens` 28×28 patches (0 = no token limit).
pub fn resized_size(width: u32, height: u32, max_edge: u32, max_tokens: u32) -> (u32, u32) {
    let (w, h, e, t) = (width as i64, height as i64, max_edge as i64, max_tokens as i64);
    if fits(w, h, e, t) {
        return (width, height);
    }
    if h > w {
        let (rh, rw) = resized_size(height, width, max_edge, max_tokens);
        return (rw, rh);
    }
    let aspect = w as f64 / h as f64;
    let (mut lo, mut hi) = (1i64, w);
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if fits(mid, round_ties_to_even(mid as f64 / aspect).max(1), e, t) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo as u32, round_ties_to_even(lo as f64 / aspect).max(1) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn matches_the_shared_js_vectors() {
        let v: Value = serde_json::from_str(include_str!("../tests/fixtures/resize.json")).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            let n = |k: &str, i: usize| c[k][i].as_u64().unwrap() as u32;
            let got = resized_size(n("in", 0), n("in", 1), c["maxEdge"].as_u64().unwrap() as u32, c["maxTokens"].as_u64().unwrap() as u32);
            assert_eq!(got, (n("out", 0), n("out", 1)), "{c}");
        }
    }

    #[test]
    fn ties_go_to_even() {
        assert_eq!(round_ties_to_even(2.5), 2);
        assert_eq!(round_ties_to_even(3.5), 4);
        assert_eq!(round_ties_to_even(2.4), 2);
        assert_eq!(round_ties_to_even(2.6), 3);
    }
}
