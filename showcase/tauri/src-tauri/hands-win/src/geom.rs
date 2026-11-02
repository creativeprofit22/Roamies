// Rectangles in physical screen pixels. The clamping idea comes from Playa-Cyrene's geometry.rs (MIT),
// written fresh here.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Rect { x, y, w, h }
    }

    /// From left/top/right/bottom edges; None when empty.
    pub fn from_ltrb(l: i32, t: i32, r: i32, b: i32) -> Option<Rect> {
        let w = r.checked_sub(l)?;
        let h = b.checked_sub(t)?;
        (w > 0 && h > 0).then_some(Rect { x: l, y: t, w, h })
    }

    pub fn right(&self) -> i64 {
        self.x as i64 + self.w as i64
    }

    pub fn bottom(&self) -> i64 {
        self.y as i64 + self.h as i64
    }

    pub fn area(&self) -> i64 {
        self.w.max(0) as i64 * self.h.max(0) as i64
    }

    pub fn intersection(&self, o: &Rect) -> Option<Rect> {
        let l = (self.x as i64).max(o.x as i64);
        let t = (self.y as i64).max(o.y as i64);
        let r = self.right().min(o.right());
        let b = self.bottom().min(o.bottom());
        (r > l && b > t).then(|| Rect::new(l as i32, t as i32, (r - l) as i32, (b - t) as i32))
    }

    pub fn intersects(&self, o: &Rect) -> bool {
        self.intersection(o).is_some()
    }

    /// At least half of `self` lies inside `view` (a sliver at the edge doesn't count as visible).
    pub fn mostly_inside(&self, view: &Rect) -> bool {
        match self.intersection(view) {
            Some(seen) => seen.area() * 2 >= self.area(),
            None => false,
        }
    }

    /// The part of `self` inside `bounds` (a monitor), or None when it's entirely outside.
    pub fn clamp_to(&self, bounds: &Rect) -> Option<Rect> {
        self.intersection(bounds)
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::json!([self.x, self.y, self.w, self.h])
    }
}

#[cfg(test)]
mod tests {
    use super::Rect;

    #[test]
    fn intersection_and_edges() {
        let a = Rect::new(0, 0, 100, 100);
        assert_eq!(a.intersection(&Rect::new(50, 50, 100, 100)), Some(Rect::new(50, 50, 50, 50)));
        assert_eq!(a.intersection(&Rect::new(100, 0, 10, 10)), None, "touching edges don't overlap");
        assert_eq!(Rect::from_ltrb(-10, -10, 10, 10), Some(Rect::new(-10, -10, 20, 20)));
        assert_eq!(Rect::from_ltrb(0, 0, 0, 5), None);
        assert_eq!(Rect::from_ltrb(i32::MIN, 0, i32::MAX, 1), None);
    }

    #[test]
    fn mostly_inside_needs_half() {
        let view = Rect::new(0, 0, 100, 100);
        assert!(Rect::new(10, 10, 20, 20).mostly_inside(&view));
        assert!(Rect::new(90, 0, 20, 10).mostly_inside(&view), "exactly half");
        assert!(!Rect::new(95, 0, 20, 10).mostly_inside(&view));
        assert!(!Rect::new(200, 0, 20, 10).mostly_inside(&view));
    }

    #[test]
    fn clamps_to_a_monitor() {
        let mon = Rect::new(-1920, 0, 1920, 1080);
        assert_eq!(Rect::new(-100, 500, 300, 100).clamp_to(&mon), Some(Rect::new(-100, 500, 100, 100)));
        assert_eq!(Rect::new(10, 10, 5, 5).clamp_to(&mon), None);
    }
}
