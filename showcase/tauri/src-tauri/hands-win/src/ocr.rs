// Text recognition on a window's pixels with Windows.Media.Ocr, for apps that share no controls (games,
// video, images, canvas apps). Feeds ocr_map, which turns the image rects into physical screen pixels.
use crate::budget::Budget;
use crate::capture::{scale_to, wic, Image};
use crate::geom::Rect;
use crate::ocr_map::{map_lines, Line, Mapping, RawLine, RawWord, RectF};
use crate::protocol::fail;
use serde_json::Value;
use std::time::{Duration, Instant};
use w32::core::HSTRING;
use w32::Globalization::Language;
use w32::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use w32::Media::Ocr::OcrEngine;
use w32::Storage::Streams::DataWriter;
use w32::Win32::Foundation::GENERIC_READ;
use w32::Win32::Graphics::Imaging::{GUID_WICPixelFormat32bppBGRA, IWICBitmapSource, WICConvertBitmapSource, WICDecodeMetadataCacheOnDemand};
use w32::core::Interface;

/// Below this much time left, a window isn't OCR'd (recognition alone can take a few hundred ms).
pub const MIN_LEFT: Duration = Duration::from_millis(800);

pub struct Engine {
    engine: OcrEngine,
    pub lang: String,
}

pub struct Ocr {
    pub lines: Vec<Line>,
    pub ms: u64,
}

pub fn unavailable() -> Value {
    fail(
        "ocr_unavailable",
        "This window shares no readable controls and Windows has no text recognition language installed. Install one in Settings ▸ Time & language ▸ Language & region (language options ▸ Optical character recognition).",
    )
}

impl Engine {
    /// The user's own languages first, else English if it's installed; ocr_unavailable when neither is.
    pub fn new() -> Result<Engine, Value> {
        let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok().or_else(|| {
            let en = Language::CreateLanguage(&HSTRING::from("en-US")).ok()?;
            OcrEngine::IsLanguageSupported(&en).ok()?.then(|| OcrEngine::TryCreateFromLanguage(&en).ok()).flatten()
        });
        let engine = engine.ok_or_else(unavailable)?;
        let lang = engine.RecognizerLanguage().and_then(|l| l.LanguageTag()).map(|t| t.to_string()).unwrap_or_default();
        Ok(Engine { engine, lang })
    }

    /// Reads `img`, which shows `frame` at 1:1; None when there isn't enough time left to try.
    pub fn read(&self, img: Image, frame: Rect, budget: &Budget) -> Result<Option<Ocr>, Value> {
        if budget.remaining() < MIN_LEFT {
            return Ok(None);
        }
        let t0 = Instant::now();
        let (img, scale) = fit_engine(img).map_err(|e| fail("ocr_failed", &e))?;
        let raw = self.recognize(&img).map_err(|e| fail("ocr_failed", &format!("Text recognition failed: {e}")))?;
        let lines = map_lines(&raw, &Mapping::new(frame, scale));
        Ok(Some(Ocr { lines, ms: t0.elapsed().as_millis() as u64 }))
    }

    fn recognize(&self, img: &Image) -> w32::core::Result<Vec<RawLine>> {
        let mut px = img.bgra.clone();
        // PrintWindow often leaves alpha at 0; opaque pixels keep the bitmap from reading as transparent.
        px.iter_mut().skip(3).step_by(4).for_each(|a| *a = 255);
        let writer = DataWriter::new()?;
        writer.WriteBytes(&px)?;
        let buf = writer.DetachBuffer()?;
        let bmp = SoftwareBitmap::CreateCopyFromBuffer(&buf, BitmapPixelFormat::Bgra8, img.w, img.h)?;
        let result = self.engine.RecognizeAsync(&bmp)?.join()?;
        let lines = result.Lines()?;
        let mut out = Vec::with_capacity(lines.Size()? as usize);
        for i in 0..lines.Size()? {
            let line = lines.GetAt(i)?;
            let words = line.Words()?;
            let mut raw = RawLine { text: line.Text()?.to_string(), words: Vec::with_capacity(words.Size()? as usize) };
            for j in 0..words.Size()? {
                let w = words.GetAt(j)?;
                let r = w.BoundingRect()?;
                raw.words.push(RawWord { text: w.Text()?.to_string(), rect: RectF { x: r.X as f64, y: r.Y as f64, w: r.Width as f64, h: r.Height as f64 } });
            }
            out.push(raw);
        }
        Ok(out)
    }
}

/// Shrinks an image past the engine's size limit; returns it with its scale (image px per screen px).
fn fit_engine(img: Image) -> Result<(Image, f64), String> {
    let max = OcrEngine::MaxImageDimension().unwrap_or(2600).max(1) as f64;
    let big = img.w.max(img.h).max(1) as f64;
    if big <= max {
        return Ok((img, 1.0));
    }
    let s = max / big;
    let to = (((img.w as f64) * s).floor().max(1.0) as u32, ((img.h as f64) * s).floor().max(1.0) as u32);
    let w0 = img.w as f64;
    let out = scale_to(img, to)?;
    Ok((out, to.0 as f64 / w0))
}

/// An image file (PNG, JPEG, …) as BGRA pixels, for the ocr-file verb.
pub fn load_image(file: &str) -> Result<Image, String> {
    fn e(what: &str) -> impl Fn(w32::core::Error) -> String + '_ {
        move |err| format!("image {what}: {err}")
    }
    unsafe {
        let f = wic()?;
        let dec = f.CreateDecoderFromFilename(&HSTRING::from(file), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand).map_err(e("open"))?;
        let frame: IWICBitmapSource = dec.GetFrame(0).map_err(e("frame"))?.cast().map_err(e("source"))?;
        let src = WICConvertBitmapSource(&GUID_WICPixelFormat32bppBGRA, &frame).map_err(e("convert"))?;
        let (mut w, mut h) = (0u32, 0u32);
        src.GetSize(&mut w, &mut h).map_err(e("size"))?;
        let mut bgra = vec![0u8; w as usize * h as usize * 4];
        src.CopyPixels(std::ptr::null(), w * 4, &mut bgra).map_err(e("pixels"))?;
        Ok(Image { bgra, w: w as i32, h: h as i32 })
    }
}

#[cfg(test)]
#[path = "ocr_tests.rs"]
pub mod tests;
