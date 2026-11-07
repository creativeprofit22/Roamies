// Screenshots that leave Roamies out: ScreenCaptureKit with every Roamies process
// excluded (the app that owns the overlays and these helpers, all run from the same folder). Windows in `keep` still
// show (the pen strokes being asked about). macOS 14+; nil means the caller falls back to screencapture.
import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Shot {
    private static let ourDir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent().path

    /// A Roamies process: run from the same folder as this helper, or the app itself.
    static func isOurs(_ pid: pid_t) -> Bool {
        if pid == getpid() || pid == getppid() { return true }
        if NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.kenkai.roamies" { return true }
        var buf = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 else { return false }
        return URL(fileURLWithPath: String(cString: buf)).resolvingSymlinksInPath().deletingLastPathComponent().path == ourDir
    }

    /// rect: the area in global points (top-left origin); nil = the whole main display. maxPx: the longest side in
    /// pixels. Returns the saved image's pixel size, or nil if it couldn't (older macOS, no permission, timed out).
    static func capture(_ rect: CGRect?, to file: String, png: Bool, maxPx: Int? = nil, keep: [CGWindowID] = []) -> [Int]? {
        guard #available(macOS 14.0, *) else { return nil }
        let done = DispatchSemaphore(value: 0)
        let box = Box()
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, _ in
            guard let content else { _ = done.signal(); return }
            let display = rect.map { r in
                content.displays.first { $0.frame.contains(CGPoint(x: r.midX, y: r.midY)) } ?? content.displays.first { $0.frame.intersects(r) }
            } ?? content.displays.first { $0.displayID == CGMainDisplayID() }
            guard let display else { _ = done.signal(); return }
            let whole = CGRect(origin: .zero, size: display.frame.size)
            let area = rect.map { $0.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY).intersection(whole) } ?? whole
            guard area.width >= 1, area.height >= 1 else { _ = done.signal(); return }
            let filter = SCContentFilter(display: display,
                                         excludingApplications: content.applications.filter { isOurs($0.processID) },
                                         exceptingWindows: content.windows.filter { keep.contains($0.windowID) })
            let scale = Double(CGDisplayCopyDisplayMode(display.displayID)?.pixelWidth ?? display.width) / Double(max(1, display.width))
            var w = area.width * scale, h = area.height * scale
            if let maxPx, max(w, h) > CGFloat(maxPx) { let k = CGFloat(maxPx) / max(w, h); w *= k; h *= k }
            let cfg = SCStreamConfiguration()
            cfg.sourceRect = area
            cfg.width = max(1, Int(w.rounded()))
            cfg.height = max(1, Int(h.rounded()))
            cfg.showsCursor = false
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, _ in
                box.image = img
                _ = done.signal()
            }
        }
        guard done.wait(timeout: .now() + 4) == .success, let image = box.image,
              let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: file) as CFURL, (png ? UTType.png : UTType.jpeg).identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dst, image, png ? nil : [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        return CGImageDestinationFinalize(dst) ? [image.width, image.height] : nil
    }

    private final class Box: @unchecked Sendable { var image: CGImage? }
}
