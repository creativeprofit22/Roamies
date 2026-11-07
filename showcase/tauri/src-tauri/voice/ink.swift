// Drawing on the screen while talking. While ⌃⌥ is held, a see-through panel over every screen takes the
// mouse, so dragging draws teal pen strokes (tapered, faster = thinner, with a soft glow). When the talk
// ends, the marked part of the screen is captured with the strokes on it and sent with what was said;
// then the strokes fade. Without ⌃⌥ held the panels let every click through (and are off screen when empty).
import AppKit
import QuartzCore

private let accent = CGColor(srgbRed: 0x78 / 255, green: 1, blue: 0xe2 / 255, alpha: 1)
private let rim = CGColor(srgbRed: 0x03 / 255, green: 0x27 / 255, blue: 0x22 / 255, alpha: 0.6)

/// One pen stroke: points in its view's coordinates (top-left origin), drawn as a filled, tapered outline.
final class InkStroke {
    var pts: [CGPoint] = []
    var radii: [CGFloat] = []
    var done = false
    let group = CALayer(), edge = CAShapeLayer(), fill = CAShapeLayer()

    init() {
        edge.fillColor = nil
        edge.strokeColor = rim
        edge.lineWidth = 2.5
        edge.lineJoin = .round
        fill.fillColor = accent
        fill.shadowColor = accent
        fill.shadowOpacity = 0.75
        fill.shadowRadius = 6
        fill.shadowOffset = .zero
        group.addSublayer(edge)
        group.addSublayer(fill)
        for l in [group, edge, fill] { l.actions = ["path": NSNull(), "position": NSNull(), "bounds": NSNull()] }
    }

    static let base: CGFloat = 2.8

    func add(_ p: CGPoint) {
        guard let last = pts.last else { pts = [p]; radii = [Self.base * 0.55]; redraw(); return }
        let d = hypot(p.x - last.x, p.y - last.y)
        if d < 2 { return }
        // A little smoothing takes the jitter out of a mouse or trackpad without lagging behind the pointer.
        let q = CGPoint(x: last.x + (p.x - last.x) * 0.65, y: last.y + (p.y - last.y) * 0.65)
        let speed = min(1, d / 40)
        let target = Self.base * (1.15 - 0.45 * speed) * min(1, 0.55 + CGFloat(pts.count) * 0.09)
        pts.append(q)
        radii.append(radii[radii.count - 1] * 0.7 + target * 0.3)
        redraw()
    }

    func finish() {
        done = true
        // Taper the tail, like a pen lifting off.
        let n = radii.count
        for k in 0 ..< min(6, n) { radii[n - 1 - k] *= 0.45 + 0.55 * CGFloat(k) / 6 }
        redraw()
    }

    func redraw() {
        let path = Self.outline(pts, radii)
        edge.path = path
        fill.path = path
    }

    /// The stroke's outline: offset both sides by the radius, join with curves, round caps at both ends.
    static func outline(_ p: [CGPoint], _ r: [CGFloat]) -> CGPath {
        let path = CGMutablePath()
        guard let first = p.first else { return path }
        if p.count == 1 {
            path.addEllipse(in: CGRect(x: first.x - r[0], y: first.y - r[0], width: r[0] * 2, height: r[0] * 2))
            return path
        }
        var left: [CGPoint] = [], right: [CGPoint] = []
        for i in 0 ..< p.count {
            let a = p[max(0, i - 1)], b = p[min(p.count - 1, i + 1)]
            let len = max(0.0001, hypot(b.x - a.x, b.y - a.y))
            let n = CGPoint(x: -(b.y - a.y) / len, y: (b.x - a.x) / len)
            left.append(CGPoint(x: p[i].x + n.x * r[i], y: p[i].y + n.y * r[i]))
            right.append(CGPoint(x: p[i].x - n.x * r[i], y: p[i].y - n.y * r[i]))
        }
        func curve(_ q: [CGPoint]) {
            for i in 1 ..< max(1, q.count - 1) {
                path.addQuadCurve(to: CGPoint(x: (q[i].x + q[i + 1].x) / 2, y: (q[i].y + q[i + 1].y) / 2), control: q[i])
            }
            path.addLine(to: q[q.count - 1])
        }
        path.move(to: left[0])
        curve(left)
        let e = p[p.count - 1], le = left[left.count - 1]
        let endAngle = atan2(le.y - e.y, le.x - e.x)
        path.addArc(center: e, radius: r[r.count - 1], startAngle: endAngle, endAngle: endAngle - .pi, clockwise: true)
        curve(Array(right.reversed()))
        let startAngle = atan2(right[0].y - first.y, right[0].x - first.x)
        path.addArc(center: first, radius: r[0], startAngle: startAngle, endAngle: startAngle - .pi, clockwise: true)
        path.closeSubpath()
        return path
    }
}

final class InkView: NSView {
    var strokes: [InkStroke] = []
    var current: InkStroke?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = .clear
    }
    required init?(coder: NSCoder) { nil }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func point(_ e: NSEvent) -> CGPoint { convert(e.locationInWindow, from: nil) }
    override func mouseDown(with e: NSEvent) {
        let s = InkStroke()
        s.group.frame = bounds
        for l in [s.edge, s.fill] { l.frame = bounds }
        layer?.addSublayer(s.group)
        strokes.append(s)
        current = s
        s.add(point(e))
    }
    override func mouseDragged(with e: NSEvent) { current?.add(point(e)) }
    override func mouseUp(with e: NSEvent) { end() }
    // ⌃ is held while talking, which can turn a click into a right click.
    override func rightMouseDown(with e: NSEvent) { mouseDown(with: e) }
    override func rightMouseDragged(with e: NSEvent) { mouseDragged(with: e) }
    override func rightMouseUp(with e: NSEvent) { end() }
    override func scrollWheel(with e: NSEvent) {}

    func end() {
        guard let s = current else { return }
        current = nil
        s.finish()
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let pulse = CABasicAnimation(keyPath: "shadowRadius")
            pulse.fromValue = 6; pulse.toValue = 11; pulse.duration = 0.18; pulse.autoreverses = true
            s.fill.add(pulse, forKey: "pulse")
        }
    }
}

final class InkPanel: NSPanel {
    let view: InkView
    init(screen: NSScreen) {
        view = InkView(frame: NSRect(origin: .zero, size: screen.frame.size))
        super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        setFrame(screen.frame, display: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .popUpMenu
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        contentView = view
    }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class Ink {
    private var panels: [InkPanel] = []
    private var armed = false
    // The capture of the last talk: under way, or done and waiting to be taken.
    private var pending = false, abandoned = false
    private var result: [String: Any]?
    private var waiter: (([String: Any]?) -> Void)?

    /// The mouse draws only while ⌃⌥ is down; otherwise clicks go to the apps underneath.
    func setArmed(_ on: Bool) {
        if on == armed { return }
        armed = on
        if on {
            syncScreens()
            for p in panels { p.ignoresMouseEvents = false; p.orderFrontRegardless() }
        } else {
            for p in panels {
                p.view.end()
                p.ignoresMouseEvents = true
                if p.view.strokes.isEmpty { p.orderOut(nil) }
            }
        }
    }

    private func syncScreens() {
        let frames = NSScreen.screens.map(\.frame)
        if panels.map(\.frame) == frames { return }
        // Screens changed: strokes on the old panels go with them.
        for p in panels { p.orderOut(nil) }
        panels = NSScreen.screens.map { InkPanel(screen: $0) }
    }

    /// Top-left of a screen in global points (CoreGraphics, origin at the main screen's top-left).
    private func origin(_ p: InkPanel) -> CGPoint {
        let mainH = NSScreen.screens.first?.frame.height ?? p.frame.height
        return CGPoint(x: p.frame.minX, y: mainH - p.frame.maxY)
    }

    /// The talk ended: shoot the marked part of the screen with the strokes still on it, then fade them.
    /// done: called on the main queue once the screen has been shot (straight away if nothing was drawn).
    func capture(then done: @escaping () -> Void = {}) {
        setArmed(false)
        guard let panel = panels.max(by: { $0.view.strokes.count < $1.view.strokes.count }), !panel.view.strokes.isEmpty else { return done() }
        let o = origin(panel)
        let strokes = panel.view.strokes
        var box = CGRect.null
        for s in strokes { for p in s.pts { box = box.union(CGRect(x: p.x, y: p.y, width: 0, height: 0)) } }
        box = box.insetBy(dx: -48, dy: -48)
        if box.width < 320 { box = box.insetBy(dx: -(320 - box.width) / 2, dy: 0) }
        if box.height < 220 { box = box.insetBy(dx: 0, dy: -(220 - box.height) / 2) }
        box = box.intersection(CGRect(origin: .zero, size: panel.frame.size)).integral
        let rect = box.offsetBy(dx: o.x, dy: o.y)
        // At most 48 points per stroke: plenty to tell a circle from a line.
        let marks: [[[Int]]] = strokes.map { s in
            let step = max(1, s.pts.count / 48)
            var picked = stride(from: 0, to: s.pts.count, by: step).map { s.pts[$0] }
            if let last = s.pts.last, picked.last != last { picked.append(last) }
            return picked.map { [Int(($0.x + o.x).rounded()), Int(($0.y + o.y).rounded())] }
        }
        let file = NSTemporaryDirectory() + "sidekick-marked-\(Int(Date().timeIntervalSince1970 * 1000)).png"
        pending = true; abandoned = false; result = nil
        let pen = CGWindowID(panel.windowNumber)
        // A beat first, so windows hidden for the shot (the listening pill) are off screen.
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.06) {
            // Without Roamies in it, but with the pen strokes (shared/shot.swift); older macOS: screencapture.
            var ok = Shot.capture(rect, to: file, png: true, keep: [pen]) != nil
            if !ok {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                p.arguments = ["-x", "-t", "png", "-R", "\(Int(rect.minX)),\(Int(rect.minY)),\(Int(rect.width)),\(Int(rect.height))", file]
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                if (try? p.run()) != nil { p.waitUntilExit(); ok = p.terminationStatus == 0 && FileManager.default.fileExists(atPath: file) }
            }
            DispatchQueue.main.async {
                let area: [String: Any]? = ok ? ["file": file, "rect": [Int(rect.minX), Int(rect.minY), Int(rect.width), Int(rect.height)], "strokes": marks] : nil
                if !ok { log("marked-area capture failed (Screen Recording off?)") }
                done()
                self.pending = false
                if self.abandoned {
                    try? FileManager.default.removeItem(atPath: file)
                } else if let w = self.waiter {
                    self.waiter = nil
                    w(area)
                } else {
                    self.result = area
                }
                self.fade(strokes, in: panel, after: 0.5)
            }
        }
    }

    /// What was captured, once it's ready (nil: nothing was drawn, or the capture failed).
    func take(_ done: @escaping ([String: Any]?) -> Void) {
        if !pending { let r = result; result = nil; done(r); return }
        waiter = done
        // A stuck capture never holds up what was said.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            guard self.pending, let w = self.waiter else { return }
            self.waiter = nil; self.abandoned = true
            w(nil)
        }
    }

    /// The talk was dropped (a shortcut, or nothing said): wipe the strokes and anything captured.
    func clear() {
        setArmed(false)
        if let f = result?["file"] as? String { try? FileManager.default.removeItem(atPath: f) }
        result = nil
        if pending { abandoned = true; waiter = nil }
        for p in panels { fade(p.view.strokes, in: p, after: 0) }
    }

    private func fade(_ strokes: [InkStroke], in panel: InkPanel, after delay: Double) {
        guard !strokes.isEmpty else { return }
        panel.view.strokes.removeAll { s in strokes.contains { $0 === s } }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            CATransaction.begin()
            CATransaction.setCompletionBlock {
                strokes.forEach { $0.group.removeFromSuperlayer() }
                if !self.armed && panel.view.strokes.isEmpty { panel.orderOut(nil) }
            }
            for s in strokes {
                let a = CABasicAnimation(keyPath: "opacity")
                a.fromValue = 1; a.toValue = 0; a.duration = 0.45
                a.timingFunction = CAMediaTimingFunction(name: .easeIn)
                s.group.opacity = 0
                s.group.add(a, forKey: "fade")
            }
            CATransaction.commit()
        }
    }
}
