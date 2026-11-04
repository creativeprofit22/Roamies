// OCR against a known image: tests/fixtures/ocr.png, drawn here with GDI so it can be rebuilt.
use super::*;
use crate::com::ComGuard;
use serde_json::json;
use w32::core::w;
use w32::Win32::Foundation::{COLORREF, GENERIC_WRITE, SIZE};
use w32::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, GdiFlush, GetTextExtentPoint32W, SelectObject, SetBkMode,
    SetTextColor, TextOutW, ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH,
    DIB_RGB_COLORS, FF_DONTCARE, FW_NORMAL, OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use w32::Win32::Graphics::Imaging::{GUID_ContainerFormatPng, WICBitmapEncoderNoCache};

const FIXTURE: (i32, i32) = (1280, 400);
const FONT_PX: i32 = 40;
const FIXTURE_LINES: [(i32, i32, &str); 4] = [
    (40, 30, "Roamies reads text from pixels"),
    (60, 120, "Quick brown foxes jump over lazy dogs"),
    (40, 210, "Invoice 4821 total 37 euros"),
    (600, 300, "Settings Help Window Close"),
];
const TOLERANCE: i32 = 6;

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// Black Segoe UI text on white; each word with its ink box (the tight box OCR reports).
pub fn draw(size: (i32, i32), px: i32, lines: &[(i32, i32, &str)]) -> (Image, Vec<(String, Rect)>) {
    let (w, h) = size;
    let mut out = vec![0u8; (w * h * 4) as usize];
    let mut cells = Vec::new();
    unsafe {
        let dc = CreateCompatibleDC(None);
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bmp = CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0).expect("DIB section");
        let old = SelectObject(dc, bmp.into());
        std::ptr::write_bytes(bits as *mut u8, 255, out.len());
        let pitch = (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32;
        let font = CreateFontW(
            -px,
            0,
            0,
            0,
            FW_NORMAL.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY,
            pitch,
            w!("Segoe UI"),
        );
        let old_font = SelectObject(dc, font.into());
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, COLORREF(0));
        let extent = |s: &str| {
            let mut sz = SIZE::default();
            let u: Vec<u16> = s.encode_utf16().collect();
            let _ = GetTextExtentPoint32W(dc, &u, &mut sz);
            sz
        };
        for &(x, y, text) in lines {
            let u: Vec<u16> = text.encode_utf16().collect();
            let _ = TextOutW(dc, x, y, &u);
            let mut at = 0;
            for word in text.split(' ') {
                let x0 = x + extent(&text[..at]).cx;
                let sz = extent(word);
                cells.push((word.to_string(), Rect::new(x0, y, sz.cx, sz.cy)));
                at += word.len() + 1;
            }
        }
        let _ = GdiFlush();
        std::ptr::copy_nonoverlapping(bits as *const u8, out.as_mut_ptr(), out.len());
        SelectObject(dc, old_font);
        let _ = DeleteObject(font.into());
        SelectObject(dc, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(dc);
    }
    // GDI zeroes alpha where it draws; keep the image opaque.
    out.iter_mut().skip(3).step_by(4).for_each(|a| *a = 255);
    let words = cells.into_iter().map(|(word, cell)| (word, ink(&out, w, h, cell))).collect();
    (Image { bgra: out, w, h }, words)
}

fn ink(bgra: &[u8], w: i32, h: i32, cell: Rect) -> Rect {
    let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for y in cell.y.max(0)..(cell.y + cell.h).min(h) {
        for x in cell.x.max(0)..(cell.x + cell.w).min(w) {
            let i = ((y * w + x) * 4) as usize;
            if bgra[i..i + 3].iter().any(|&c| c < 160) {
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            }
        }
    }
    assert!(x0 <= x1, "no ink for cell {cell:?}");
    Rect::new(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
}

pub fn write_png(file: &str, img: &Image) -> Result<(), String> {
    fn e(what: &str) -> impl Fn(w32::core::Error) -> String + '_ {
        move |err| format!("PNG {what}: {err}")
    }
    unsafe {
        let f = wic()?;
        let stream = f.CreateStream().map_err(e("stream"))?;
        stream.InitializeFromFilename(&HSTRING::from(file), GENERIC_WRITE.0).map_err(e("open file"))?;
        let enc = f.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()).map_err(e("encoder"))?;
        enc.Initialize(&stream, WICBitmapEncoderNoCache).map_err(e("encoder init"))?;
        let (mut frame, mut props) = (None, None);
        enc.CreateNewFrame(&mut frame, &mut props).map_err(e("frame"))?;
        let frame = frame.ok_or("PNG frame missing")?;
        frame.Initialize(props.as_ref()).map_err(e("frame init"))?;
        frame.SetSize(img.w as u32, img.h as u32).map_err(e("size"))?;
        let mut fmt = GUID_WICPixelFormat32bppBGRA;
        frame.SetPixelFormat(&mut fmt).map_err(e("pixel format"))?;
        if fmt != GUID_WICPixelFormat32bppBGRA {
            return Err("PNG encoder refused 32-bit BGRA".into());
        }
        frame.WritePixels(img.h as u32, img.w as u32 * 4, &img.bgra).map_err(e("pixels"))?;
        frame.Commit().map_err(e("frame commit"))?;
        enc.Commit().map_err(e("commit"))?;
    }
    Ok(())
}

/// Rebuilds tests/fixtures/ocr.png and ocr.json: `cargo test --locked write_ocr_fixture -- --ignored`.
#[test]
#[ignore]
fn write_ocr_fixture() {
    let _com = ComGuard::mta().unwrap();
    let (img, words) = draw(FIXTURE, FONT_PX, &FIXTURE_LINES);
    write_png(&fixture("ocr.png"), &img).unwrap();
    let words: Vec<Value> = words.iter().map(|(t, r)| json!({"text": t, "bounds": r.json()})).collect();
    let doc = json!({
        "about": "Expected words in ocr.png (ink boxes, image pixels). Rebuilt by the ignored test ocr::tests::write_ocr_fixture.",
        "size": [FIXTURE.0, FIXTURE.1],
        "words": words,
    });
    std::fs::write(fixture("ocr.json"), serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
}

fn rect_of(v: &Value) -> Rect {
    let b: Vec<i32> = v.as_array().expect("bounds").iter().map(|n| n.as_i64().unwrap() as i32).collect();
    Rect::new(b[0], b[1], b[2], b[3])
}

fn close(a: Rect, b: Rect) -> bool {
    [(a.x, b.x), (a.y, b.y), (a.x + a.w, b.x + b.w), (a.y + a.h, b.y + b.h)].iter().all(|(p, q)| (p - q).abs() <= TOLERANCE)
}

#[test]
fn reads_the_fixture_words_at_their_screen_pixels() {
    let _com = ComGuard::mta().unwrap();
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(fixture("ocr.json")).unwrap()).unwrap();
    let engine = Engine::new().unwrap_or_else(|e| panic!("no OCR language installed: {e}"));
    // Negative x is a monitor left of the primary one; the origin must shift every rect.
    for origin in [(0, 0), (-1920, 240)] {
        let img = load_image(&fixture("ocr.png")).unwrap();
        let frame = Rect::new(origin.0, origin.1, img.w, img.h);
        let read = engine.read(img, frame, &Budget::new(15_000, usize::MAX)).unwrap().expect("time to read");
        let got: Vec<&crate::ocr_map::Word> = read.lines.iter().flat_map(|l| &l.words).collect();
        for want in expected["words"].as_array().unwrap() {
            let text = want["text"].as_str().unwrap();
            let r = rect_of(&want["bounds"]);
            let want_r = Rect::new(r.x + origin.0, r.y + origin.1, r.w, r.h);
            assert!(
                got.iter().any(|g| g.text == text && close(g.bounds, want_r)),
                "{text} at {want_r:?} (origin {origin:?}) not found in {:?}",
                got.iter().map(|g| (&g.text, g.bounds)).collect::<Vec<_>>()
            );
        }
    }
}

/// Full-HD timing, text on every row: `cargo test --release --locked ocr_p95_full_hd -- --ignored --nocapture`.
#[test]
#[ignore]
fn ocr_p95_full_hd() {
    let _com = ComGuard::mta().unwrap();
    let engine = Engine::new().unwrap_or_else(|e| panic!("no OCR language installed: {e}"));
    let rows: Vec<String> = (0..36).map(|i| format!("Row {i} the quick brown fox jumps over the lazy dog, settings, options, start game")).collect();
    let lines: Vec<(i32, i32, &str)> = rows.iter().enumerate().map(|(i, t)| (24, 12 + i as i32 * 29, t.as_str())).collect();
    let (img, _) = draw((1920, 1080), 20, &lines);
    let mut ms: Vec<u128> = (0..30)
        .map(|_| {
            let copy = Image { w: img.w, h: img.h, bgra: img.bgra.clone() };
            let t = std::time::Instant::now();
            let read = engine.read(copy, Rect::new(0, 0, 1920, 1080), &Budget::new(15_000, usize::MAX)).unwrap().expect("time to read");
            assert!(read.lines.len() >= 30, "only {} lines read", read.lines.len());
            t.elapsed().as_millis()
        })
        .collect();
    ms.sort();
    println!("ocr 1920x1080, {} lines: p50 {} ms, p95 {} ms, max {} ms", lines.len(), ms[14], ms[28], ms[29]);
}
