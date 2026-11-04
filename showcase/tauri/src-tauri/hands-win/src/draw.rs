// Numbered marks drawn onto a BGRA image (the `image` verb): an outline around each rect and a filled tag
// with its number. Pure, so it builds and tests on any system. Rects are in the image's own pixels.
use crate::geom::Rect;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mark {
    pub n: u32,
    pub rect: Rect,
}

/// 5×7 digits, one byte per row, low 5 bits, left pixel = bit 4.
const DIGITS: [[u8; 7]; 10] = [
    [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
    [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
    [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
    [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
    [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
    [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
    [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
    [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
    [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
    [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
];

/// Dark, saturated colours (B, G, R) so white digits stay readable; neighbours differ.
const PALETTE: [[u8; 3]; 6] = [[40, 40, 220], [220, 90, 30], [30, 140, 40], [170, 40, 150], [0, 100, 200], [140, 120, 0]];
pub const WHITE: [u8; 3] = [255, 255, 255];

pub fn colour(n: u32) -> [u8; 3] {
    PALETTE[n as usize % PALETTE.len()]
}

/// Reads a marks file: `[{"n": 1, "rect": [x, y, w, h]}, ...]` in output-image pixels.
pub fn parse_marks(v: &Value) -> Result<Vec<Mark>, String> {
    let list = v.as_array().ok_or("marks must be a JSON array")?;
    list.iter()
        .enumerate()
        .map(|(i, m)| {
            let n = m["n"].as_u64().filter(|n| (1..=9999).contains(n)).ok_or(format!("mark {i}: n must be 1–9999"))? as u32;
            let r: Vec<i64> = m["rect"].as_array().map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f.round() as i64)).collect()).unwrap_or_default();
            match r[..] {
                [x, y, w, h] if w > 0 && h > 0 => Ok(Mark { n, rect: Rect::new(x as i32, y as i32, w as i32, h as i32) }),
                _ => Err(format!("mark {i}: rect must be [x, y, w, h] with a positive size")),
            }
        })
        .collect()
}

pub struct Canvas<'a> {
    pub bgra: &'a mut [u8],
    pub w: i32,
    pub h: i32,
}

impl Canvas<'_> {
    fn fill(&mut self, x: i32, y: i32, w: i32, h: i32, c: [u8; 3]) {
        let (x0, y0) = (x.max(0), y.max(0));
        let (x1, y1) = ((x + w).min(self.w), (y + h).min(self.h));
        for py in y0..y1 {
            for px in x0..x1 {
                let o = (py as usize * self.w as usize + px as usize) * 4;
                self.bgra[o..o + 3].copy_from_slice(&c);
                self.bgra[o + 3] = 255;
            }
        }
    }

    fn outline(&mut self, r: Rect, t: i32, c: [u8; 3]) {
        self.fill(r.x, r.y, r.w, t, c);
        self.fill(r.x, r.y + r.h - t, r.w, t, c);
        self.fill(r.x, r.y, t, r.h, c);
        self.fill(r.x + r.w - t, r.y, t, r.h, c);
    }

    fn digits(&mut self, x: i32, y: i32, s: i32, text: &str, c: [u8; 3]) {
        for (i, d) in text.bytes().enumerate() {
            let glyph = DIGITS[(d - b'0') as usize];
            let gx = x + i as i32 * 6 * s;
            for (row, bits) in glyph.iter().enumerate() {
                for col in 0..5 {
                    if bits & (0b10000 >> col) != 0 {
                        self.fill(gx + col * s, y + row as i32 * s, s, s, c);
                    }
                }
            }
        }
    }
}

/// Pixel scale of the digits: 2× on normal shots, 1× on small ones.
pub fn scale_for(w: i32, h: i32) -> i32 {
    if w.min(h) >= 400 { 2 } else { 1 }
}

/// Where a mark's tag goes: just above the rect's top-left corner, or inside it when there's no room
/// above; always kept on the image. Returns (x, y, w, h).
pub fn tag_rect(m: &Mark, s: i32, img_w: i32, img_h: i32) -> (i32, i32, i32, i32) {
    let len = m.n.to_string().len() as i32;
    let (tw, th) = (len * 6 * s + s + 2 * s, 7 * s + 2 * s);
    let y = if m.rect.y >= th { m.rect.y - th } else { m.rect.y };
    let x = m.rect.x.clamp(0, (img_w - tw).max(0));
    (x, y.clamp(0, (img_h - th).max(0)), tw, th)
}

/// Draws every mark: all outlines first, then the tags, so a neighbour's outline never covers a number.
pub fn draw_marks(c: &mut Canvas, marks: &[Mark]) {
    let s = scale_for(c.w, c.h);
    for m in marks {
        c.outline(m.rect, s, colour(m.n));
    }
    for m in marks {
        let (x, y, w, h) = tag_rect(m, s, c.w, c.h);
        c.fill(x, y, w, h, colour(m.n));
        c.digits(x + 2 * s - s / 2, y + s, s, &m.n.to_string(), WHITE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn px(b: &[u8], w: i32, x: i32, y: i32) -> [u8; 3] {
        let o = (y * w + x) as usize * 4;
        [b[o], b[o + 1], b[o + 2]]
    }

    #[test]
    fn parses_marks_and_rejects_bad_ones() {
        let m = parse_marks(&json!([{"n": 3, "rect": [10, 20.4, 30, 40]}])).unwrap();
        assert_eq!(m, vec![Mark { n: 3, rect: Rect::new(10, 20, 30, 40) }]);
        for bad in [json!({}), json!([{"n": 0, "rect": [0, 0, 1, 1]}]), json!([{"n": 1, "rect": [0, 0, 0, 1]}]), json!([{"n": 1, "rect": [0, 0, 1]}]), json!([{"rect": [0, 0, 1, 1]}])] {
            assert!(parse_marks(&bad).is_err(), "{bad}");
        }
        assert_eq!(parse_marks(&json!([])).unwrap(), vec![]);
    }

    #[test]
    fn draws_outline_tag_and_digits() {
        let (w, h) = (500, 500);
        let mut b = vec![0u8; (w * h * 4) as usize];
        let m = Mark { n: 7, rect: Rect::new(100, 100, 80, 40) };
        draw_marks(&mut Canvas { bgra: &mut b, w, h }, std::slice::from_ref(&m));
        let c = colour(7);
        assert_eq!(px(&b, w, 140, 100), c, "top edge");
        assert_eq!(px(&b, w, 179, 120), c, "right edge");
        assert_eq!(px(&b, w, 140, 120), [0, 0, 0], "inside left clear");
        let (tx, ty, tw, th) = tag_rect(&m, 2, w, h);
        assert_eq!((tx, ty), (100, 100 - th), "tag sits above");
        assert!(tw > 0 && th == 18);
        // The digit 7's top bar is white; the tag's corner is the mark colour.
        let white = (tx..tx + tw).filter(|&x| px(&b, w, x, ty + 2) == WHITE).count();
        assert_eq!(white, 10, "five 2-px pixels of the 7's top row");
        assert_eq!(px(&b, w, tx, ty), c);
    }

    #[test]
    fn tags_stay_on_the_image() {
        let m = Mark { n: 12, rect: Rect::new(-5, 0, 30, 30) };
        let (x, y, w, _) = tag_rect(&m, 1, 100, 100);
        assert_eq!((x, y), (0, 0), "no room above: inside, clamped");
        let m = Mark { n: 12, rect: Rect::new(95, 50, 30, 30) };
        let (x, ..) = tag_rect(&m, 1, 100, 100);
        assert_eq!(x + w, 100, "clamped to the right edge");
        // A mark partly off the image doesn't panic.
        let mut b = vec![0u8; 100 * 100 * 4];
        draw_marks(&mut Canvas { bgra: &mut b, w: 100, h: 100 }, &[Mark { n: 1234, rect: Rect::new(90, 90, 50, 50) }, m]);
    }
}
