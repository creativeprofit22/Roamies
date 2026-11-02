// Maps rects from the Windows screen helper (physical virtual-desktop pixels) onto overlay windows:
// which monitor holds a target, and where it sits in that overlay's CSS pixels.
use serde_json::Value;

/// One overlay's area: its physical top-left and size, and its scale (1.0 = 96 DPI).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

fn overlap(a: &Area, [x, y, w, h]: [f64; 4]) -> f64 {
    let ow = ((x + w).min(a.x + a.w) - x.max(a.x)).max(0.0);
    let oh = ((y + h).min(a.y + a.h) - y.max(a.y)).max(0.0);
    ow * oh
}

fn gap(a: &Area, cx: f64, cy: f64) -> f64 {
    let dx = (a.x - cx).max(0.0).max(cx - (a.x + a.w));
    let dy = (a.y - cy).max(0.0).max(cy - (a.y + a.h));
    dx.hypot(dy)
}

/// The area holding the rect's centre, else the one it overlaps most, else the nearest. Same rule as
/// `monitorFor` in sidecar/pointing.mjs.
pub fn pick(areas: &[Area], r: [f64; 4]) -> Option<usize> {
    let (cx, cy) = (r[0] + r[2] / 2.0, r[1] + r[3] / 2.0);
    if let Some(i) = areas.iter().position(|a| cx >= a.x && cx < a.x + a.w && cy >= a.y && cy < a.y + a.h) {
        return Some(i);
    }
    let mut best: Option<usize> = None;
    for (i, a) in areas.iter().enumerate() {
        best = match best {
            None => Some(i),
            Some(b) => {
                let (o, ob) = (overlap(a, r), overlap(&areas[b], r));
                if o > ob || (o == 0.0 && ob == 0.0 && gap(a, cx, cy) < gap(&areas[b], cx, cy)) { Some(i) } else { Some(b) }
            }
        };
    }
    best
}

/// A physical rect relative to the area, in its CSS pixels.
pub fn to_css(a: &Area, [x, y, w, h]: [f64; 4]) -> [f64; 4] {
    let s = if a.scale > 0.0 { a.scale } else { 1.0 };
    [(x - a.x) / s, (y - a.y) / s, w / s, h / s]
}

/// `[x, y, w, h]` from JSON, if it's four numbers.
pub fn rect(v: &Value) -> Option<[f64; 4]> {
    let a = v.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let mut out = [0.0; 4];
    for (o, n) in out.iter_mut().zip(a) {
        *o = n.as_f64()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A: 1920×1080 at 100%, main. B: 2880×1620 at 150%, to the left and a little higher (negative origin).
    const A: Area = Area { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0, scale: 1.0 };
    const B: Area = Area { x: -2880.0, y: -200.0, w: 2880.0, h: 1620.0, scale: 1.5 };

    fn close(a: [f64; 4], b: [f64; 4]) {
        for (x, y) in a.iter().zip(b) {
            assert!((x - y).abs() < 0.01, "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn target_on_each_monitor() {
        let areas = [A, B];
        let on_a = [960.0, 540.0, 100.0, 50.0];
        assert_eq!(pick(&areas, on_a), Some(0));
        close(to_css(&A, on_a), on_a);
        let on_b = [-1500.0, 300.0, 150.0, 75.0];
        assert_eq!(pick(&areas, on_b), Some(1));
        close(to_css(&B, on_b), [920.0, 333.33, 100.0, 50.0]);
    }

    #[test]
    fn straddling_box_goes_where_its_centre_is() {
        let areas = [A, B];
        assert_eq!(pick(&areas, [-300.0, 100.0, 400.0, 100.0]), Some(1)); // centre x = -100: B
        assert_eq!(pick(&areas, [-100.0, 100.0, 400.0, 100.0]), Some(0)); // centre x = 100: A
    }

    #[test]
    fn off_screen_box_goes_to_the_nearest() {
        let areas = [A, B];
        assert_eq!(pick(&areas, [500.0, 1500.0, 400.0, 100.0]), Some(0));
        assert_eq!(pick(&areas, [-2000.0, 1700.0, 100.0, 100.0]), Some(1));
        assert_eq!(pick(&areas, [5000.0, 0.0, 10.0, 10.0]), Some(0));
    }

    #[test]
    fn no_monitors() {
        assert_eq!(pick(&[], [0.0, 0.0, 1.0, 1.0]), None);
    }

    #[test]
    fn rect_parsing() {
        assert_eq!(rect(&json!([1, 2.5, 3, 4])), Some([1.0, 2.5, 3.0, 4.0]));
        assert_eq!(rect(&json!([1, 2, 3])), None);
        assert_eq!(rect(&json!([1, "2", 3, 4])), None);
        assert_eq!(rect(&json!({"x": 1})), None);
    }
}
