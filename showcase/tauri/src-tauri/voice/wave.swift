// The listening indicator: a small pixel pill of voice bars that rides beside the cursor while ⌃⌥ is
// talking, so nothing else pops up. Bars follow the mic level; after letting go they shrink to dots that
// keep following and pulse until the sidekick starts answering (handoff), which then appears on that spot
// and stays put. Never takes the mouse, follows the cursor across screens.
import AppKit
import QuartzCore

final class Wave {
    private static let w: CGFloat = 50, h: CGFloat = 24, barW: CGFloat = 3, gap: CGFloat = 2.5, minH: CGFloat = 4, maxH: CGFloat = 16
    // Taller in the middle, and each bar wobbles at its own pace so it reads as a voice, not a meter.
    private static let shape: [CGFloat] = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45]
    private static let speed: [Double] = [7.1, 9.3, 6.2, 8.4, 10.1, 7.7, 6.8]
    private static let phase: [Double] = [0, 1.7, 0.6, 2.9, 1.1, 2.2, 0.3]

    private let panel: NSPanel
    private let bars: [CALayer]
    private var level: CGFloat = 0, target: CGFloat = 0
    private var shown = false, thinking = false, hidden = false
    private var waitID = 0
    private var lastOrigin = NSPoint(x: -1, y: -1)

    init() {
        let size = NSSize(width: Self.w, height: Self.h)
        panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        // Above the drawing layer (ink.swift), so it stays visible while marking the screen.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.alphaValue = 0
        panel.setAccessibilityLabel("Roamies is listening")

        let view = NSView(frame: NSRect(origin: .zero, size: size))
        view.wantsLayer = true
        let root = view.layer!
        let pill = CAShapeLayer()
        pill.path = Self.pixelPill(CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5))
        pill.fillColor = CGColor(srgbRed: 0x05 / 255, green: 0x12 / 255, blue: 0x14 / 255, alpha: 0.94)
        pill.strokeColor = CGColor(srgbRed: 0x4f / 255, green: 0xbf / 255, blue: 0xa9 / 255, alpha: 1)
        pill.lineWidth = 1
        root.addSublayer(pill)
        let host = CALayer()
        host.frame = root.bounds
        host.shadowColor = CGColor(srgbRed: 0x78 / 255, green: 1, blue: 0xe2 / 255, alpha: 1)
        host.shadowOpacity = 0.8
        host.shadowRadius = 3
        host.shadowOffset = .zero
        root.addSublayer(host)
        bars = (0 ..< Self.shape.count).map { _ in
            let b = CALayer()
            b.backgroundColor = CGColor(srgbRed: 0x78 / 255, green: 1, blue: 0xe2 / 255, alpha: 1)
            host.addSublayer(b)
            return b
        }
        panel.contentView = view
    }

    /// The Roamies pixel frame: corners cut in two 2-pt steps (same as the setup guide's .px boxes).
    private static func pixelPill(_ r: CGRect) -> CGPath {
        let s: CGFloat = 2, (x0, y0, x1, y1) = (r.minX, r.minY, r.maxX, r.maxY)
        let pts: [(CGFloat, CGFloat)] = [
            (x0 + 2 * s, y0), (x1 - 2 * s, y0), (x1 - 2 * s, y0 + s), (x1 - s, y0 + s), (x1 - s, y0 + 2 * s), (x1, y0 + 2 * s),
            (x1, y1 - 2 * s), (x1 - s, y1 - 2 * s), (x1 - s, y1 - s), (x1 - 2 * s, y1 - s), (x1 - 2 * s, y1), (x0 + 2 * s, y1),
            (x0 + 2 * s, y1 - s), (x0 + s, y1 - s), (x0 + s, y1 - 2 * s), (x0, y1 - 2 * s), (x0, y0 + 2 * s), (x0 + s, y0 + 2 * s),
            (x0 + s, y0 + s), (x0 + 2 * s, y0 + s),
        ]
        let p = CGMutablePath()
        p.addLines(between: pts.map { CGPoint(x: $0.0, y: $0.1) })
        p.closeSubpath()
        return p
    }

    func show() {
        thinking = false; level = 0; target = 0
        if !shown {
            shown = true
            lastOrigin = NSPoint(x: -1, y: -1)
            tick()
            panel.orderFrontRegardless()
        }
        fade(to: hidden ? 0 : 1)
    }

    /// Let go: the words are being worked out, then the answer is on its way.
    func think() { if shown { thinking = true } }

    /// The words went off: keep the dots until the sidekick's answer appears (handoff).
    func awaitAnswer() {
        guard shown else { return }
        waitID += 1
        let id = waitID
        // A search can take a while; the app hands off (or the turn ends) well before this.
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in if self?.waitID == id { self?.hide() } }
    }

    func hide() {
        guard shown else { return }
        shown = false
        waitID += 1
        fade(to: 0) { [weak self] in if let self, !self.shown { self.panel.orderOut(nil) } }
    }

    /// Out of the way while the marked area is captured, so it isn't in the picture.
    func setHidden(_ on: Bool) {
        hidden = on
        panel.alphaValue = on || !shown ? 0 : 1
    }

    func setLevel(_ v: Double) { target = max(target, CGFloat(v)) }

    private func fade(to a: CGFloat, then done: (() -> Void)? = nil) {
        NSAnimationContext.runAnimationGroup({ c in
            c.duration = 0.14
            panel.animator().alphaValue = a
        }, completionHandler: done)
    }

    /// Right of the arrow, centred on its middle; flips left or up near a screen edge.
    private func place() {
        let m = NSEvent.mouseLocation
        guard let f = (NSScreen.screens.first { NSMouseInRect(m, $0.frame, false) } ?? NSScreen.main)?.frame else { return }
        var x = m.x + 18, y = m.y - 12 - Self.h / 2
        if x + Self.w > f.maxX - 2 { x = m.x - 8 - Self.w }
        if y < f.minY + 2 { y = m.y + 8 }
        let o = NSPoint(x: x.rounded(), y: y.rounded())
        if o != lastOrigin { lastOrigin = o; panel.setFrameOrigin(o) }
    }

    /// Every frame (60 Hz, from the voice helper's tick).
    func tick() {
        guard shown else { return }
        place()
        level += (target - level) * (target > level ? 0.55 : 0.12)
        target *= 0.9
        let t = uptime(), still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let x0 = (Self.w - CGFloat(bars.count) * Self.barW - CGFloat(bars.count - 1) * Self.gap) / 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (i, b) in bars.enumerated() {
            var bh = Self.minH, alpha: Float = 1
            if thinking {
                // A soft highlight runs along the dots.
                alpha = still ? 0.75 : Float(0.35 + 0.65 * max(0, sin(t * 7 - Double(i) * 0.7)))
            } else {
                let wob: CGFloat = still ? 1 : 0.65 + 0.35 * CGFloat(sin(t * Self.speed[i] + Self.phase[i]))
                let idle: CGFloat = still ? 0 : CGFloat(1 + sin(t * 3 + Double(i) * 0.9)) // a gentle breath while quiet
                bh = Self.minH + idle + (Self.maxH - Self.minH) * min(1, level * 1.3) * Self.shape[i] * wob
            }
            bh = max(Self.minH, (bh / 2).rounded() * 2) // whole 2-pt steps, like the pixel art
            b.frame = CGRect(x: x0 + CGFloat(i) * (Self.barW + Self.gap), y: ((Self.h - bh) / 2).rounded(), width: Self.barW, height: bh)
            b.opacity = alpha
        }
        CATransaction.commit()
    }
}
