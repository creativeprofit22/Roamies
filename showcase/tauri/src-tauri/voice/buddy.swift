// The Roamie's cursor form while it just follows the cursor, drawn here instead of in the web overlay. The page
// hands over a picture of itself (eyes open and shut) and its follow rules; this moves it on the display's own clock,
// which costs a small fraction of repainting a web view at 120 Hz. The page
// takes it back for anything else (talking, cards, being clicked or dragged) and keeps the same follow maths, so the
// handover doesn't jump. Never takes the mouse.
// The window stays put (one click-through panel over the cursor's screen) and only the
// picture moves inside it, snapped to whole screen pixels: moving a window every frame goes through the window
// server, which lands it late and rounded, so it judders and blurs.
import AppKit
import QuartzCore

final class Buddy: NSObject {
    private let panel: NSPanel
    private let body = CALayer()
    private var open: CGImage?, shut: CGImage?
    private var on = false, paused = true, hidden = false
    // Body point (where the cursor-form arrow sits), in global top-left points like the page's own maths.
    private var x = 0.0, y = 0.0, vx = 0.0, vy = 0.0, ox = 0.0, oy = 0.0, side = 1.0, high = false
    // Follow rules from agent.js drive(): offset beside the cursor, edge room, and the visible screen bounds.
    private var gx = 40.0, room = 40.0, low = 14.0, highY = -29.0, bot = 39.0, pad = 19.0
    private var l = 0.0, t = 0.0, r = 1e5, b = 1e5
    private var ax = 0.0, ay = 0.0, w = 1.0, h = 1.0
    private var last = 0.0, settled = 0.0, lastMouse = CGPoint(x: -1, y: -1)
    private var link: AnyObject? // CADisplayLink (macOS 14+)
    private var timer: Timer?
    private var blinkID = 0

    override init() {
        panel = NSPanel(contentRect: NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1, height: 1), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.setAccessibilityLabel("Roamies sidekick")
        let view = NSView(frame: NSRect(origin: .zero, size: panel.frame.size))
        view.wantsLayer = true
        view.autoresizingMask = [.width, .height]
        body.contentsGravity = .resize
        body.magnificationFilter = .nearest
        body.anchorPoint = .zero
        body.actions = ["position": NSNull(), "bounds": NSNull(), "contents": NSNull()]
        view.layer!.addSublayer(body)
        panel.contentView = view
        super.init()
    }

    /// Takes over drawing: picture, follow rules and the page's current position and motion.
    func show(_ m: [String: Any]) {
        let num = { (k: String, d: Double) -> Double in (m[k] as? NSNumber)?.doubleValue ?? d }
        guard let img = m["img"] as? [String: Any], let o = Self.image(img["open"]) else { return }
        open = o
        shut = Self.image(img["shut"]) ?? o
        w = (img["w"] as? NSNumber)?.doubleValue ?? Double(o.width) / 2
        h = (img["h"] as? NSNumber)?.doubleValue ?? Double(o.height) / 2
        ax = (img["ax"] as? NSNumber)?.doubleValue ?? w / 2
        ay = (img["ay"] as? NSNumber)?.doubleValue ?? h / 2
        x = num("x", x); y = num("y", y); vx = num("vx", 0); vy = num("vy", 0)
        ox = num("ox", 0); oy = num("oy", 0); side = num("side", 1) < 0 ? -1 : 1; high = (m["high"] as? Bool) ?? false
        gx = num("gx", gx); room = num("room", room); low = num("low", low); highY = num("highY", highY)
        bot = num("bot", bot); pad = num("pad", pad)
        l = num("l", l); t = num("t", t); r = num("r", r); b = num("b", b)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body.contents = open
        body.contentsScale = CGFloat(Double(o.width) / w)
        body.bounds = CGRect(x: 0, y: 0, width: w, height: h)
        CATransaction.commit()
        screen = nil
        on = true
        lastMouse = Self.mouse()
        place()
        panel.alphaValue = hidden ? 0 : 1
        panel.orderFrontRegardless()
        run()
        blink()
        var ack: [String: Any] = ["type": "buddy", "state": "shown"]
        if let id = m["id"] { ack["id"] = id }
        emit(ack)
    }

    /// The page is drawing it again.
    func hide() {
        guard on else { return }
        on = false
        blinkID += 1
        stop()
        panel.orderOut(nil)
        emit(["type": "buddy", "state": "hidden"])
    }

    /// Out of the way while an interactive screenshot is on screen (the overlays fade then too).
    func setHidden(_ v: Bool) {
        hidden = v
        panel.alphaValue = v || !on ? 0 : 1
    }

    /// From the helper's 60 Hz tick: the display clock is stopped while settled, so restart it when the cursor moves.
    func tick() {
        if on && paused && Self.mouse() != lastMouse { run() }
    }

    private func run() {
        settled = 0
        last = CACurrentMediaTime()
        guard paused else { return }
        paused = false
        if #available(macOS 14.0, *) {
            if link == nil, let v = panel.contentView {
                let dl = v.displayLink(target: self, selector: #selector(frame(_:)))
                dl.add(to: .main, forMode: .common)
                link = dl
            }
            (link as? CADisplayLink)?.isPaused = false
        } else if timer == nil {
            let tm = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in self?.frame(nil) }
            RunLoop.main.add(tm, forMode: .common)
            timer = tm
        }
    }

    private func stop() {
        paused = true
        if #available(macOS 14.0, *) { (link as? CADisplayLink)?.isPaused = true }
        timer?.invalidate()
        timer = nil
    }

    /// One display frame: the same steps as agent.js drive().
    @objc private func frame(_ sender: Any?) {
        guard on else { return stop() }
        let now = CACurrentMediaTime(), dt = min(1.0 / 30.0, max(0, now - last))
        last = now
        let p = Self.mouse()
        // Side stays put until that side runs out of screen; below the cursor unless that's off the bottom.
        if side > 0 && p.x + gx > r - room { side = -1 } else if side < 0 && p.x - gx < l + room { side = 1 }
        if !high && p.y + low > b - bot { high = true } else if high && p.y + low < b - bot - 40 { high = false }
        let tx = side * gx, ty = high ? highY : low, k1 = 1 - exp(-dt / 0.07)
        ox += (tx - ox) * k1
        oy += (ty - oy) * k1
        let goalX = min(max(p.x + ox, l + pad), r - pad), goalY = min(max(p.y + oy, t + pad), b - pad)
        // Exact critically damped spring step (stiff: it trails a fast flick by a hair, never wobbles).
        let wv = 90.0, e = exp(-wv * dt)
        let sx = x - goalX, tvx = (vx + wv * sx) * dt
        vx = (vx - wv * tvx) * e; x = goalX + (sx + tvx) * e
        let sy = y - goalY, tvy = (vy + wv * sy) * dt
        vy = (vy - wv * tvy) * e; y = goalY + (sy + tvy) * e
        place()
        let still = p == lastMouse
        lastMouse = p
        let rest = abs(vx) + abs(vy) < 1 && abs(goalX - x) + abs(goalY - y) < 0.05 && abs(tx - ox) + abs(ty - oy) < 0.05
        settled = still && rest ? settled + dt : 0
        if settled > 0.25 { stop() }
    }

    private var screen: NSScreen?

    private func place() {
        // The picture's bottom-left in AppKit's global coordinates (bottom-left origin).
        let gx = x - ax, gy = Self.primaryHeight() - (y - ay) - h
        let at = NSPoint(x: x, y: Self.primaryHeight() - y)
        // Over a new screen: the panel moves there (rare); the picture moves within it every frame.
        if screen == nil || !(screen!.frame.contains(at)) {
            if let s = NSScreen.screens.first(where: { $0.frame.contains(at) }) ?? NSScreen.main, s !== screen || panel.frame != s.frame {
                screen = s
                panel.setFrame(s.frame, display: false)
            }
        }
        let f = panel.frame, k = Double(screen?.backingScaleFactor ?? 2)
        let px = ((gx - Double(f.minX)) * k).rounded() / k, py = ((gy - Double(f.minY)) * k).rounded() / k
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body.position = CGPoint(x: px, y: py)
        CATransaction.commit()
    }

    /// A blink every few seconds, like the page's face.
    private func blink() {
        blinkID += 1
        let id = blinkID
        DispatchQueue.main.asyncAfter(deadline: .now() + Double.random(in: 2 ... 5.5)) { [weak self] in
            guard let self, self.on, self.blinkID == id else { return }
            self.setFace(self.shut)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in
                guard let self, self.blinkID == id else { return }
                self.setFace(self.open)
                self.blink()
            }
        }
    }

    private func setFace(_ img: CGImage?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body.contents = img
        CATransaction.commit()
    }

    /// The cursor in global top-left points (the page's and Tauri's coordinates).
    private static func mouse() -> CGPoint {
        let m = NSEvent.mouseLocation
        return CGPoint(x: m.x, y: primaryHeight() - m.y)
    }

    private static func primaryHeight() -> Double { Double(NSScreen.screens.first?.frame.height ?? 0) }

    private static func image(_ v: Any?) -> CGImage? {
        guard let s = v as? String, let data = Data(base64Encoded: s), let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
    }
}
