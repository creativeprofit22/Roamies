// Window and screen capture to JPEG. Structure adapted from trycua/cua platform-windows/src/capture.rs and
// wgc.rs (MIT, Copyright (c) 2025 Cua AI, Inc.; see licenses/cua-LICENSE.txt): a minimized-window guard, a
// crop to the DWM extended frame, PrintWindow/BitBlt for classic windows and Windows.Graphics.Capture for
// XAML ones (PrintWindow paints those black). Everything is physical pixels; nothing is scaled by DPI/96,
// which would add a black margin (cua #1879). The image covers exactly the window's bounds; --fit then
// scales it to the size the model will see (fit.rs), so the reply's `sent` maps 1:1 onto those bounds.
use crate::budget::Budget;
use crate::geom::Rect;
use crate::protocol::{fail, WinInfo};
use serde_json::Value;
use std::time::{Duration, Instant};
use w32::core::{factory, Interface, HSTRING};
use w32::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use w32::Graphics::DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat};
use w32::Win32::Foundation::{GENERIC_WRITE, HMODULE, HWND, RECT};
use w32::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use w32::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use w32::Win32::Graphics::Dxgi::IDXGIDevice;
use w32::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, SRCCOPY,
};
use w32::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR, GUID_WICPixelFormat32bppBGRA, IWICImagingFactory,
    WICBitmapEncoderNoCache, WICBitmapInterpolationModeHighQualityCubic,
};
use w32::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use w32::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use w32::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use w32::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use w32::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, IsIconic};

const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);
const XAML_CLASSES: [&str; 3] = ["ApplicationFrameWindow", "Windows.UI.Core.CoreWindow", "WinUIDesktopWin32WindowClass"];

pub struct Image {
    pub bgra: Vec<u8>,
    pub w: i32,
    pub h: i32,
}

/// PrintWindow leaves DirectComposition surfaces all black; sample sparsely and call >99.5% black a failure.
pub fn mostly_black(bgra: &[u8]) -> bool {
    let px = bgra.len() / 4;
    if px == 0 {
        return true;
    }
    let step = (px / 1024).max(1);
    let (mut seen, mut black) = (0usize, 0usize);
    for i in (0..px).step_by(step) {
        let o = i * 4;
        if bgra[o] == 0 && bgra[o + 1] == 0 && bgra[o + 2] == 0 {
            black += 1;
        }
        seen += 1;
    }
    black * 200 >= seen * 199
}

/// Copies the `inner` part out of an image that covers `outer` (both screen rects).
fn crop(img: Image, outer: Rect, inner: Rect) -> Image {
    let Some(r) = inner.intersection(&outer) else { return img };
    if r == outer {
        return img;
    }
    let (ox, oy) = ((r.x - outer.x) as usize, (r.y - outer.y) as usize);
    let (cw, ch) = (r.w as usize, r.h as usize);
    let stride = img.w as usize * 4;
    let mut out = vec![0u8; cw * ch * 4];
    for row in 0..ch {
        let s = (oy + row) * stride + ox * 4;
        out[row * cw * 4..(row + 1) * cw * 4].copy_from_slice(&img.bgra[s..s + cw * 4]);
    }
    Image { bgra: out, w: r.w, h: r.h }
}

unsafe fn read_bitmap(src: HDC, from_x: i32, from_y: i32, w: i32, h: i32, print: Option<HWND>) -> Option<Image> {
    let mem = CreateCompatibleDC(Some(src));
    let bmp = CreateCompatibleBitmap(src, w, h);
    let old = SelectObject(mem, bmp.into());
    let drawn = match print {
        Some(hwnd) => PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT).as_bool(),
        None => BitBlt(mem, 0, 0, w, h, Some(src), from_x, from_y, SRCCOPY).is_ok(),
    };
    let mut bmi = BITMAPINFO {
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
    let mut px = vec![0u8; w as usize * h as usize * 4];
    let lines = GetDIBits(mem, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);
    SelectObject(mem, old);
    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(mem);
    (drawn && lines != 0).then_some(Image { bgra: px, w, h })
}

/// A screen area straight off the desktop (only right when nothing covers it).
fn screen_region(r: Rect) -> Option<Image> {
    unsafe {
        let dc = GetDC(None);
        let img = read_bitmap(dc, r.x, r.y, r.w, r.h, None);
        ReleaseDC(None, dc);
        img
    }
}

/// PrintWindow of the whole window rect, cropped to the drawn frame.
fn print_window(hwnd: HWND, frame: Rect) -> Option<Image> {
    unsafe {
        let mut wr = RECT::default();
        GetWindowRect(hwnd, &mut wr).ok()?;
        let outer = Rect::from_ltrb(wr.left, wr.top, wr.right, wr.bottom)?;
        let dc = GetWindowDC(Some(hwnd));
        let img = read_bitmap(dc, 0, 0, outer.w, outer.h, Some(hwnd));
        ReleaseDC(Some(hwnd), dc);
        Some(crop(img?, outer, frame))
    }
}

/// Windows.Graphics.Capture: the window's own composited pixels, even when covered (Windows 10 1903+).
fn wgc(hwnd: HWND, wait: Duration) -> Result<Image, String> {
    fn e(what: &str) -> impl Fn(w32::core::Error) -> String + '_ {
        move |err| format!("{what}: {err}")
    }
    unsafe {
        let mut dev: Option<ID3D11Device> = None;
        let mut ctx: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut dev),
            None,
            Some(&mut ctx),
        )
        .map_err(e("D3D11 device"))?;
        let (dev, ctx) = (dev.ok_or("no D3D11 device")?, ctx.ok_or("no D3D11 context")?);
        let dxgi: IDXGIDevice = dev.cast().map_err(e("DXGI device"))?;
        let d3d: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi).and_then(|i| i.cast()).map_err(e("WinRT device"))?;
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(e("capture interop"))?;
        let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd).map_err(e("capture item"))?;
        let size = item.Size().map_err(e("capture size"))?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err("the window has no size to capture".into());
        }
        // Free-threaded: frames arrive without a dispatcher on this thread; we poll for the first one.
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size).map_err(e("frame pool"))?;
        let session = pool.CreateCaptureSession(&item).map_err(e("capture session"))?;
        // Windows 11 only; older systems keep the yellow border.
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetIsCursorCaptureEnabled(false);
        session.StartCapture().map_err(e("start capture"))?;
        let until = Instant::now() + wait;
        let frame = loop {
            if let Ok(f) = pool.TryGetNextFrame() {
                break f;
            }
            if Instant::now() >= until {
                let _ = session.Close();
                let _ = pool.Close();
                return Err("no frame arrived in time".into());
            }
            std::thread::sleep(Duration::from_millis(30));
        };
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface().and_then(|s| s.cast()).map_err(e("frame surface"))?;
        let tex: ID3D11Texture2D = access.GetInterface().map_err(e("frame texture"))?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        tex.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging: Option<ID3D11Texture2D> = None;
        dev.CreateTexture2D(&desc, None, Some(&mut staging)).map_err(e("staging texture"))?;
        let staging = staging.ok_or("no staging texture")?;
        ctx.CopyResource(&staging, &tex);
        let mut map = D3D11_MAPPED_SUBRESOURCE::default();
        ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut map)).map_err(e("map texture"))?;
        let (w, h, pitch) = (desc.Width as usize, desc.Height as usize, map.RowPitch as usize);
        let mut px = vec![0u8; w * h * 4];
        for row in 0..h {
            std::ptr::copy_nonoverlapping((map.pData as *const u8).add(row * pitch), px.as_mut_ptr().add(row * w * 4), w * 4);
        }
        ctx.Unmap(&staging, 0);
        let _ = frame.Close();
        let _ = session.Close();
        let _ = pool.Close();
        Ok(Image { bgra: px, w: w as i32, h: h as i32 })
    }
}

/// WGC's frame starts at the window's top-left; keep it to the window's bounds so the image stays 1:1.
fn fit(img: Image, frame: Rect) -> Image {
    if img.w <= frame.w && img.h <= frame.h {
        return img;
    }
    let (w, h) = (img.w, img.h);
    crop(img, Rect::new(0, 0, w, h), Rect::new(0, 0, frame.w.min(w), frame.h.min(h)))
}

fn wic() -> Result<IWICImagingFactory, String> {
    unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(|e| format!("WIC factory: {e}")) }
}

/// The size to send for an area of `bounds`: --fit's limits, or the bounds' own size.
pub fn sent_size(bounds: Rect, fit: Option<(u32, u32)>) -> (u32, u32) {
    let (w, h) = (bounds.w.max(1) as u32, bounds.h.max(1) as u32);
    match fit {
        Some((e, t)) => crate::fit::resized_size(w, h, e, t),
        None => (w, h),
    }
}

/// Resizes to exactly `to` with WIC's high-quality cubic filter (a no-op when it's already that size).
fn scale_to(img: Image, to: (u32, u32)) -> Result<Image, String> {
    if (img.w as u32, img.h as u32) == to {
        return Ok(img);
    }
    fn e(what: &str) -> impl Fn(w32::core::Error) -> String + '_ {
        move |err| format!("resize {what}: {err}")
    }
    let (w, h) = (to.0 as usize, to.1 as usize);
    let mut out = vec![0u8; w * h * 4];
    unsafe {
        let f = wic()?;
        let src = f.CreateBitmapFromMemory(img.w as u32, img.h as u32, &GUID_WICPixelFormat32bppBGRA, img.w as u32 * 4, &img.bgra).map_err(e("source"))?;
        let scaler = f.CreateBitmapScaler().map_err(e("scaler"))?;
        scaler.Initialize(&src, to.0, to.1, WICBitmapInterpolationModeHighQualityCubic).map_err(e("init"))?;
        let (mut sw, mut sh) = (0u32, 0u32);
        scaler.GetSize(&mut sw, &mut sh).map_err(e("size"))?;
        if (sw, sh) != to {
            return Err(format!("resize came out {sw}×{sh}, wanted {}×{}", to.0, to.1));
        }
        scaler.CopyPixels(std::ptr::null(), w as u32 * 4, &mut out).map_err(e("pixels"))?;
    }
    Ok(Image { bgra: out, w: w as i32, h: h as i32 })
}

pub fn write_jpeg(file: &str, img: &Image) -> Result<(), String> {
    fn e(what: &str) -> impl Fn(w32::core::Error) -> String + '_ {
        move |err| format!("JPEG {what}: {err}")
    }
    let (w, h) = (img.w as usize, img.h as usize);
    let stride = (w * 3 + 3) & !3;
    let mut bgr = vec![0u8; stride * h];
    for y in 0..h {
        for x in 0..w {
            let s = (y * w + x) * 4;
            let d = y * stride + x * 3;
            bgr[d..d + 3].copy_from_slice(&img.bgra[s..s + 3]);
        }
    }
    unsafe {
        let f = wic()?;
        let stream = f.CreateStream().map_err(e("stream"))?;
        stream.InitializeFromFilename(&HSTRING::from(file), GENERIC_WRITE.0).map_err(e("open file"))?;
        let enc = f.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null()).map_err(e("encoder"))?;
        enc.Initialize(&stream, WICBitmapEncoderNoCache).map_err(e("encoder init"))?;
        let mut frame = None;
        let mut props = None;
        enc.CreateNewFrame(&mut frame, &mut props).map_err(e("frame"))?;
        let frame = frame.ok_or("JPEG frame missing")?;
        frame.Initialize(props.as_ref()).map_err(e("frame init"))?;
        frame.SetSize(w as u32, h as u32).map_err(e("size"))?;
        let mut fmt = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut fmt).map_err(e("pixel format"))?;
        if fmt != GUID_WICPixelFormat24bppBGR {
            return Err("JPEG encoder refused 24-bit BGR".into());
        }
        frame.WritePixels(h as u32, stride as u32, &bgr).map_err(e("pixels"))?;
        frame.Commit().map_err(e("frame commit"))?;
        enc.Commit().map_err(e("commit"))?;
    }
    Ok(())
}

pub fn minimized(w: &WinInfo) -> Value {
    fail("minimized", &format!("{} is minimized, so there's nothing on screen to read. Ask the user to restore it first.", w.app))
}

/// Captures one window into `file` as JPEG; returns the bounds it covers and the image's size.
pub fn window(w: &WinInfo, file: &str, limits: Option<(u32, u32)>, budget: &Budget) -> Result<(Rect, (u32, u32)), Value> {
    let hwnd = crate::windows::hwnd(w.id);
    if unsafe { IsIconic(hwnd).as_bool() } {
        return Err(minimized(w));
    }
    let frame = crate::windows::frame_bounds(hwnd).unwrap_or(w.bounds);
    let wait = budget.remaining().saturating_sub(Duration::from_millis(300));
    let mut why = Vec::new();
    let img = if XAML_CLASSES.contains(&w.class.as_str()) {
        wgc(hwnd, wait).map(|i| fit(i, frame)).map_err(|e| why.push(e)).ok()
    } else {
        let front = unsafe { GetForegroundWindow() } == hwnd;
        print_window(hwnd, frame)
            .filter(|i| !mostly_black(&i.bgra))
            .or_else(|| if front { screen_region(frame).filter(|i| !mostly_black(&i.bgra)) } else { None })
            .or_else(|| wgc(hwnd, wait).map(|i| fit(i, frame)).map_err(|e| why.push(e)).ok())
    };
    let img = img.filter(|i| !mostly_black(&i.bgra)).ok_or_else(|| {
        fail("capture_failed", &format!("Couldn't capture {} (it came out blank{}).", w.app, why.first().map(|e| format!("; {e}")).unwrap_or_default()))
    })?;
    if budget.expired() {
        return Err(fail("timeout", "Capturing took too long. Try again."));
    }
    let sent = sent_size(frame, limits);
    let img = scale_to(img, sent).map_err(|e| fail("capture_failed", &e))?;
    write_jpeg(file, &img).map_err(|e| fail("capture_failed", &e))?;
    Ok((frame, sent))
}

/// Captures one monitor (`which` is 1-based, None = the primary one); returns its bounds and the image's size.
pub fn screen(file: &str, mons: &[crate::protocol::Monitor], which: Option<usize>, fit: Option<(u32, u32)>) -> Result<(Rect, (u32, u32)), Value> {
    let r = match which {
        Some(n) => mons.get(n.wrapping_sub(1)).map(|m| m.bounds).ok_or_else(|| fail("not_found", &format!("There's no monitor {n}; there are {}.", mons.len())))?,
        None => mons.iter().find(|m| m.primary).or(mons.first()).map(|m| m.bounds).ok_or_else(|| fail("capture_failed", "No monitor found."))?,
    };
    let img = screen_region(r).ok_or_else(|| fail("capture_failed", "Screen capture failed (the PC may be locked)."))?;
    let sent = sent_size(r, fit);
    let img = scale_to(img, sent).map_err(|e| fail("capture_failed", &e))?;
    write_jpeg(file, &img).map_err(|e| fail("capture_failed", &e))?;
    Ok((r, sent))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn black_detection() {
        assert!(mostly_black(&[0u8; 4000]));
        let mut px = vec![0u8; 4000];
        for p in px.chunks_mut(4) {
            p[1] = 200;
        }
        assert!(!mostly_black(&px));
        assert!(mostly_black(&[]));
    }

    #[test]
    fn sent_size_follows_fit() {
        assert_eq!(sent_size(Rect::new(0, 0, 2560, 1440), Some((1568, 1568))), (1456, 819));
        assert_eq!(sent_size(Rect::new(-10, 5, 800, 600), None), (800, 600));
    }

    #[test]
    fn crops_to_the_inner_rect() {
        // 4×2 image, each pixel's blue byte is its index.
        let bgra: Vec<u8> = (0..8u8).flat_map(|i| [i, 0, 0, 255]).collect();
        let img = Image { bgra, w: 4, h: 2 };
        let out = crop(img, Rect::new(10, 10, 4, 2), Rect::new(11, 11, 2, 5));
        assert_eq!((out.w, out.h), (2, 1));
        assert_eq!(out.bgra.iter().step_by(4).copied().collect::<Vec<_>>(), [5, 6]);
    }
}
