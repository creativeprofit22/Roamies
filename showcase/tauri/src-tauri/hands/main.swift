// Hands helper for Roamies (macOS): lets the agent see one window or app, read its controls, and type,
// press keys or click into it. One command per run; prints one JSON object. Runs as a child of Roamies,
// so macOS attributes Screen Recording and Accessibility to Roamies.
//
//   roamies-hands windows                      visible windows, front to back
//   roamies-hands capture <out.jpg> front|app:<name>|window:<id>|screen
//   roamies-hands locate front|app:<name>|window:<id>   which window that is, without capturing (for the animation)
//   roamies-hands select <out.png>             drag to choose an area (built-in macOS selection UI)
//   roamies-hands ui front|app:<name>          the window's buttons, fields, etc. with ids
//   roamies-hands act <json>                   {"app":"Brave","steps":[{"do":"focus","id":3},{"do":"type","text":"hi"}]}
//   roamies-hands trusted [--prompt]           Accessibility permission status
//   roamies-hands locate-control <target> <id>  where one control (from `ui`) is on screen, for pointing
//   roamies-hands image <in> <out.jpg> [--crop x,y,w,h] [--size w,h] [--marks marks.json]
//                                              crop (source pixels), resize, draw numbered marks, write JPEG
//   roamies-hands screencheck                  takes (and deletes) one test screenshot: {"seen": true|false}
//   roamies-hands guide accessibility|screen [<Roamies.app>] [--preview]  drag-me-in panel under System Settings (until stdin closes)
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import Security
import UniformTypeIdentifiers

setvbuf(stdout, nil, _IOLBF, 0)
func out(_ o: [String: Any]) -> Never {
    let d = (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8)
    print(String(data: d, encoding: .utf8) ?? "{}")
    exit(0)
}
func fail(_ msg: String) -> Never { out(["ok": false, "error": msg]) }

let me = ProcessInfo.processInfo.processIdentifier
let myParent = getppid()
// Never point at Roamies itself (its overlay windows cover every screen).
func isRoamies(_ pid: pid_t) -> Bool {
    pid == me || pid == myParent || NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.kenkai.roamies"
}

// ---------- windows ----------

struct Win { let id: Int; let pid: pid_t; let app: String; let title: String; let x, y, w, h: Double }

func windows() -> [Win] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.compactMap { w in
        guard (w[kCGWindowLayer as String] as? Int) == 0,
              let id = w[kCGWindowNumber as String] as? Int,
              let pid = w[kCGWindowOwnerPID as String] as? Int32, !isRoamies(pid),
              let b = w[kCGWindowBounds as String] as? [String: Double],
              (b["Width"] ?? 0) > 80, (b["Height"] ?? 0) > 60 else { return nil }
        return Win(id: id, pid: pid, app: (w[kCGWindowOwnerName as String] as? String) ?? "?",
                   title: (w[kCGWindowName as String] as? String) ?? "", x: b["X"] ?? 0, y: b["Y"] ?? 0, w: b["Width"] ?? 0, h: b["Height"] ?? 0)
    }
}

/// Fuzzy app match: "browser" finds the frontmost known browser; otherwise a case-insensitive name match.
let BROWSERS = ["Brave Browser", "Google Chrome", "Safari", "Arc", "Firefox", "Microsoft Edge", "Opera", "Vivaldi", "Chromium", "Orion", "Zen"]
func appMatches(_ app: String, _ want: String) -> Bool {
    let w = want.lowercased().trimmingCharacters(in: .whitespaces)
    if ["browser", "web browser", "my browser"].contains(w) { return BROWSERS.contains(app) }
    let a = app.lowercased()
    return a == w || a.contains(w) || w.contains(a)
}

/// Resolves a target to a window. "front" = the frontmost app that isn't Roamies.
func resolve(_ target: String) -> Win? {
    let w = resolveWin(target)
    if BG, let w { bgPid = w.pid }
    return w
}
func resolveWin(_ target: String) -> Win? {
    let all = windows()
    if target == "front" {
        if let f = NSWorkspace.shared.frontmostApplication, !isRoamies(f.processIdentifier), let w = all.first(where: { $0.pid == f.processIdentifier }) { return w }
        return all.first
    }
    if target.hasPrefix("window:"), let id = Int(target.dropFirst(7)) { return all.first { $0.id == id } }
    if target.hasPrefix("app:") {
        let name = String(target.dropFirst(4))
        if let w = all.first(where: { appMatches($0.app, name) }) { return w }
        // Running but no visible window (hidden or minimised): bring it forward and look again.
        if let app = NSWorkspace.shared.runningApplications.first(where: { appMatches($0.localizedName ?? "", name) }) {
            app.unhide()
            app.activate(options: [.activateAllWindows])
            Thread.sleep(forTimeInterval: 0.6)
            return windows().first { $0.pid == app.processIdentifier }
        }
    }
    return nil
}

func winInfo(_ w: Win) -> [String: Any] { ["id": w.id, "app": w.app, "title": w.title, "bounds": [Int(w.x), Int(w.y), Int(w.w), Int(w.h)]] }

func run(_ path: String, _ args: [String]) -> Int32 {
    let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
}

// ---------- accessibility tree ----------

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = attr(el, name) else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}
/// Several attributes in one round trip to the app: each attr() call is its own message to the app, and walking a
/// web page makes thousands of them. Missing attributes come back nil. Falls back to one call each if the app refuses.
func attrs(_ el: AXUIElement, _ names: [String]) -> [AnyObject?] {
    var v: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &v) == .success,
          let arr = v as [AnyObject]?, arr.count == names.count else { return names.map { attr(el, $0) } }
    return arr.map { x in
        if x is NSNull { return nil }
        if CFGetTypeID(x) == AXValueGetTypeID(), AXValueGetType(x as! AXValue) == .axError { return nil }
        return x
    }
}
/// str() for a value already fetched.
func strOf(_ v: AnyObject?) -> String? {
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}
/// frame() from already-fetched position and size.
func frameOf(_ p: AnyObject?, _ s: AnyObject?) -> CGRect? {
    guard let p, let s, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
}
func frame(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
}

let INTERACTIVE: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField", "AXCheckBox", "AXRadioButton",
                                "AXPopUpButton", "AXComboBox", "AXMenuButton", "AXLink", "AXSlider", "AXTab", "AXDisclosureTriangle", "AXIncrementor",
                                "AXDateField", "AXTimeField", "AXDateTimeArea"]
let ROLE_NAME: [String: String] = ["AXButton": "button", "AXTextField": "text field", "AXTextArea": "text area", "AXSearchField": "search field",
                                   "AXSecureTextField": "password field", "AXCheckBox": "checkbox", "AXRadioButton": "radio", "AXPopUpButton": "dropdown",
                                   "AXComboBox": "combo box", "AXMenuButton": "menu button", "AXLink": "link", "AXSlider": "slider", "AXTab": "tab",
                                   "AXDisclosureTriangle": "disclosure", "AXIncrementor": "stepper",
                                   "AXDateField": "date field", "AXTimeField": "time field", "AXDateTimeArea": "date field"]

/// The app's accessibility window that is the same window as `w` (by position and size), so apps with
/// several windows are read from the one that was asked for, not whichever has focus.
func axWindow(_ app: AXUIElement, _ w: Win?) -> AXUIElement? {
    let all = attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    if let w {
        let want = CGRect(x: w.x, y: w.y, width: w.w, height: w.h)
        let same = all.filter { frame($0).map { abs($0.minX - want.minX) <= 2 && abs($0.minY - want.minY) <= 2 && abs($0.width - want.width) <= 2 && abs($0.height - want.height) <= 2 } ?? false }
        // Windows stacked at the same size (Safari's often are): the title tells them apart.
        if let m = same.first(where: { str($0, kAXTitleAttribute) == w.title }) ?? same.first { return m }
    }
    if let f = attr(app, kAXFocusedWindowAttribute) { return (f as! AXUIElement) }
    return all.first
}

/// Walks the window's tree and numbers every control. Ids are stable for the same walk, so
/// `act` re-walks and finds the same element by id (checking its label still matches).
func frontPid() -> pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

/// Brings the window's app forward and waits until macOS reports it frontmost (up to ~1.2 s).
func bringToFront(_ w: Win, _ app: AXUIElement) -> Bool {
    if BG, !fgActive { return true }
    if frontPid() == w.pid { return true }
    let run = NSRunningApplication(processIdentifier: w.pid)
    for attempt in 0..<3 {
        run?.unhide()
        run?.activate(options: [.activateAllWindows])
        AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        if let win = axWindow(app, w) { AXUIElementPerformAction(win, kAXRaiseAction as CFString) }
        if attempt == 2, let url = run?.bundleURL {
            // Last resort: open the app again, which macOS always honours.
            let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, _ in }
        }
        // Opening the app again is asynchronous, so give the last attempt longer.
        for _ in 0..<(attempt == 2 ? 40 : 8) {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            if frontPid() == w.pid { Thread.sleep(forTimeInterval: 0.1); return true }
        }
    }
    return frontPid() == w.pid
}

/// A field with no label of its own: the text just before it in its row (many forms put the label in a
/// plain element next to the field instead of a linked <label>).
func nearbyLabel(_ e: AXUIElement) -> String? {
    var cur = e
    for _ in 0..<3 {
        guard let parent = attr(cur, kAXParentAttribute).map({ $0 as! AXUIElement }),
              let kids = attr(parent, kAXChildrenAttribute) as? [AXUIElement],
              let at = kids.firstIndex(where: { CFEqual($0, cur) }) else { return nil }
        for sib in kids[..<at].reversed() {
            var stack: [(AXUIElement, Int)] = [(sib, 0)]
            while let (el, d) = stack.popLast() {
                let role = axRole(el)
                if FIELD_ROLES.contains(role) || INTERACTIVE.contains(role) { break }
                if role == "AXStaticText", let t = str(el, kAXValueAttribute), t.trimmingCharacters(in: .whitespaces).count >= 2 {
                    return String(t.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
                }
                if d < 3 { stack += ((attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []).reversed().map { ($0, d + 1) } }
            }
        }
        cur = parent
    }
    return nil
}

/// Controls scrolled out of view come after the visible ones (marked offscreen), so long pages and chat
/// histories can't push what's actually on screen off the list.
func walk(_ app: AXUIElement, _ w: Win? = nil, limit: Int = 260) -> [(AXUIElement, [String: Any])] {
    guard let root = axWindow(app, w) else { return [] }
    let view = w.map { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) } ?? frame(root) ?? .infinite
    var found: [(AXUIElement, [String: Any])] = [], hidden: [(AXUIElement, [String: Any])] = []
    var stack: [(AXUIElement, Int)] = [(root as! AXUIElement, 0)]
    var visited = 0
    while let (el, depth) = stack.popLast(), found.count < limit, visited < 8000 {
        visited += 1
        let rc = attrs(el, [kAXRoleAttribute, kAXChildrenAttribute])
        let role = strOf(rc[0]) ?? ""
        // Everything a control's line needs, in one round trip.
        let c = INTERACTIVE.contains(role) ? attrs(el, [kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                                        "AXPlaceholderValue", kAXHelpAttribute, kAXTitleUIElementAttribute, kAXValueAttribute, kAXFocusedAttribute]) : []
        if !c.isEmpty, let f = frameOf(c[0], c[1]), f.width > 1, f.height > 1 {
            if (c[2] as? Bool) != false {
                let title = strOf(c[3]), placeholder = strOf(c[5])
                var label = title ?? strOf(c[4]) ?? placeholder ?? strOf(c[6]) ?? ""
                if label.isEmpty, let t = c[7], CFGetTypeID(t) == AXUIElementGetTypeID() { label = str(t as! AXUIElement, kAXValueAttribute) ?? "" }
                if label.isEmpty, FIELD_ROLES.contains(role) { label = nearbyLabel(el) ?? "" }
                // A placeholder alone hides the real label ("e.g. Jane Doe" is the Full Name field): add the label too.
                if FIELD_ROLES.contains(role), title == nil, let ph = placeholder, label == ph, let near = nearbyLabel(el), near != ph { label = "\(near) (\(ph))" }
                var item: [String: Any] = ["role": ROLE_NAME[role] ?? role, "label": String(label.prefix(80)),
                                           "bounds": [Int(f.minX), Int(f.minY), Int(f.width), Int(f.height)]]
                if role != "AXSecureTextField", let v = strOf(c[8]), !v.isEmpty { item["value"] = String(v.prefix(80)) }
                if (c[9] as? Bool) == true { item["focused"] = true }
                // Mostly on screen counts as visible; a sliver at the edge doesn't.
                let seen = view.intersection(f)
                if !seen.isNull, seen.width * seen.height >= f.width * f.height * 0.5 { found.append((el, item)) }
                else if hidden.count < 40 { item["offscreen"] = true; hidden.append((el, item)) }
            }
        }
        if depth < 40, let kids = rc[1] as? [AXUIElement] {
            for k in kids.reversed() { stack.append((k, depth + 1)) }
        }
    }
    return (found + hidden.prefix(max(0, limit - found.count))).enumerated().map { i, c in
        var item = c.1; item["id"] = i + 1; return (c.0, item)
    }
}

/// Any visible element whose text matches `query` (labels, headings, version numbers, plain text), best first:
/// exact matches, then whole words, then contains; on screen in this window; smallest first (the text, not its container).
func findText(_ app: AXUIElement, _ w: Win, _ query: String) -> [[String: Any]] { findTextEls(app, w, query).map { $0.1 } }

func findTextEls(_ app: AXUIElement, _ w: Win, _ query: String, hidden: Bool = false, limit: Int = 8) -> [(AXUIElement, [String: Any])] {
    guard let root = axWindow(app, w) else { return [] }
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !q.isEmpty else { return [] }
    let win = CGRect(x: w.x, y: w.y, width: w.w, height: w.h)
    var hits: [(score: Int, web: Bool, area: CGFloat, el: AXUIElement, item: [String: Any])] = []
    var stack: [(AXUIElement, Int)] = [(root, 0)]
    var visited = 0
    while let (el, depth) = stack.popLast(), visited < 12000 {
        visited += 1
        let a = attrs(el, [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXChildrenAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXRoleAttribute])
        let texts = a[0..<4].compactMap { strOf($0) }
        if let t = texts.first(where: { $0.lowercased().contains(q) }), let f = frameOf(a[5], a[6]), f.width > 1, f.height > 1, hidden || win.intersects(f) {
            let low = t.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            // A whole word: no letter or digit right before or after. (\\b fails when the text starts or ends with a symbol, like "$1,250".)
            let score = low == q ? 0 : low.range(of: "(?<![\\p{L}\\p{N}])\(NSRegularExpression.escapedPattern(for: q))(?![\\p{L}\\p{N}])", options: .regularExpression) != nil ? 1 : 2
            let role = strOf(a[7]) ?? ""
            hits.append((score, inWebPage(el), f.width * f.height, el, ["text": String(t.prefix(80)), "match": ["exact", "word", "partial"][score], "role": ROLE_NAME[role] ?? role.replacingOccurrences(of: "AX", with: "").lowercased(),
                                                     "bounds": [Int(f.minX), Int(f.minY), Int(f.width), Int(f.height)]]))
        }
        if depth < 60, let kids = a[4] as? [AXUIElement] {
            for k in kids.reversed() { stack.append((k, depth + 1)) }
        }
    }
    // Words on the page beat the same words in the browser's own tabs and toolbar (a tab titled "Sign in").
    return hits.sorted { $0.score != $1.score ? $0.score < $1.score : $0.web != $1.web ? $0.web : $0.area < $1.area }.prefix(limit).map { ($0.el, $0.item) }
}

/// Activates what a piece of text belongs to: focuses a text field, else presses the element or the nearest
/// ancestor that can be pressed (a link around its text, a button around its label). Returns false if nothing could.
func pressText(_ e: AXUIElement) -> Bool {
    // Words inside a button or link (a web "Sign in" button holds a text "Sign in"): press the button itself. Safari
    // reports pressing the inner text as done but never submits the form, so the login silently didn't happen.
    if ["AXStaticText", "AXImage", "AXHeading", "AXGroup"].contains(str(e, kAXRoleAttribute) ?? "") {
        var up = attr(e, kAXParentAttribute).map { $0 as! AXUIElement }
        for _ in 0..<3 {
            guard let c = up else { break }
            if ["AXButton", "AXLink", "AXMenuItem", "AXMenuButton", "AXPopUpButton", "AXTab", "AXCheckBox", "AXRadioButton"].contains(str(c, kAXRoleAttribute) ?? ""),
               AXUIElementPerformAction(c, kAXPressAction as CFString) == .success { return true }
            up = attr(c, kAXParentAttribute).map { $0 as! AXUIElement }
        }
    }
    var cur: AXUIElement? = e
    for _ in 0..<6 {
        guard let c = cur else { break }
        let role = str(c, kAXRoleAttribute) ?? ""
        if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role) {
            AXUIElementSetAttributeValue(c, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            if let f = frame(c) { click(CGPoint(x: f.midX, y: f.midY)) }
            return true
        }
        var names: CFArray?
        if AXUIElementCopyActionNames(c, &names) == .success, let n = names as? [String], n.contains(kAXPressAction as String),
           AXUIElementPerformAction(c, kAXPressAction as CFString) == .success { return true }
        cur = attr(c, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return false
}

// Clicks that delete, pay, send or sign out (in English and other common languages) run only when the sidecar
// has asked the user ("confirmed").
// Kept in sync with RISKY_CLICK in sidecar/safety.mjs.
let RISKY = try! NSRegularExpression(pattern: #"(?:^|[^\p{L}])(delete|remove|erase|destroy|wipe|reset|deactivate|close (my |your )?account|cancel (my |your |the )?(subscription|plan|membership|account|order)|unsubscribe|pay|purchase|buy|place (the |your )?order|checkout|check out|confirm (payment|order|purchase|transfer)|send|transfer|withdraw|uninstall|empty trash|discard|sign out|log out|logout|format|revoke|publish|eliminar|borrar|pagar|comprar|enviar|cerrar sesi[oó]n|supprimer|effacer|payer|acheter|envoyer|se d[eé]connecter|d[eé]connexion|l[oö]schen|entfernen|bezahlen|kaufen|senden|abmelden|excluir|apagar|terminar sess[aã]o|elimina|cancella|paga|acquista|invia|esci|verwijderen|betalen|kopen|verzenden|uitloggen|afmelden|padam|hapus|bayar|beli|hantar|kirim|log keluar|nyahlanggan)(?![\p{L}])|删除|刪除|移除|清空|支付|付款|购买|購買|发送|發送|退出登录|登出|注销|削除|消去|支払|購入|送信|ログアウト|退会|삭제|결제|구매|전송|보내기|로그아웃"#, options: .caseInsensitive)
func risky(_ s: String) -> Bool { RISKY.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

/// Text fields inside web pages (browsers, Electron apps) ignore a value set through accessibility:
/// the page never hears about it and submits an empty field. Those need real keystrokes.
func inWebPage(_ e: AXUIElement) -> Bool {
    var cur = attr(e, kAXParentAttribute).map { $0 as! AXUIElement }
    for _ in 0..<40 {
        guard let c = cur else { return false }
        if str(c, kAXRoleAttribute) == "AXWebArea" { return true }
        cur = attr(c, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return false
}

// ---------- forms ----------

let FIELD_ROLES: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField", "AXDateField", "AXTimeField", "AXDateTimeArea"]
let DROP_ROLES: Set<String> = ["AXPopUpButton", "AXComboBox", "AXMenuButton", "AXTextField", "AXButton"]
func axRole(_ e: AXUIElement) -> String { str(e, kAXRoleAttribute) ?? "" }
func fold(_ s: String) -> String {
    s.lowercased().replacingOccurrences(of: "*", with: "").replacingOccurrences(of: ":", with: "")
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The field a form label names: one whose own label or placeholder matches, else the field nearest the
/// visible label text (to its right on the same row, or just below it). Labels on many sites aren't linked
/// to their field, so clicking the label puts the cursor nowhere.
func fieldFor(_ app: AXUIElement, _ w: Win, _ controls: [(AXUIElement, [String: Any])], _ name: String, roles: Set<String>) -> (AXUIElement, [String: Any])? {
    let q = fold(name)
    guard !q.isEmpty else { return nil }
    let cands = controls.filter { roles.contains(axRole($0.0)) && ($0.1["offscreen"] as? Bool) != true } + controls.filter { roles.contains(axRole($0.0)) && ($0.1["offscreen"] as? Bool) == true }
    let names: ((AXUIElement, [String: Any])) -> [String] = { c in
        let l = (c.1["label"] as? String) ?? ""
        let base = l.range(of: " (").map { String(l[..<$0.lowerBound]) } ?? l
        return [l, base, str(c.0, "AXPlaceholderValue") ?? "", str(c.0, kAXTitleAttribute) ?? "", str(c.0, kAXDescriptionAttribute) ?? ""].map(fold).filter { !$0.isEmpty }
    }
    if let m = cands.first(where: { names($0).contains(q) }) { return m }
    if let m = cands.first(where: { names($0).contains { $0.hasPrefix(q) || q.hasPrefix($0) && $0.count >= 4 } }) { return m }
    guard let (_, lab) = findTextEls(app, w, name, hidden: true).first(where: { wholeMatch($0.1, name) }), let lb = lab["bounds"] as? [Int] else { return nil }
    let L = CGRect(x: lb[0], y: lb[1], width: lb[2], height: lb[3])
    // A field on the label's own row always beats one below it; "below" means stacked under the label
    // (same left edge), not merely lower down, which is the next row's field in a two-column form.
    var row: (CGFloat, (AXUIElement, [String: Any]))?, under: (CGFloat, (AXUIElement, [String: Any]))?
    for c in cands {
        guard let f = frame(c.0) else { continue }
        if f.minX >= L.midX, f.minY <= L.midY, f.maxY >= L.midY, f.minX - L.maxX < 500 {
            let d = f.minX - L.maxX
            if row == nil || d < row!.0 { row = (d, c) }
        } else if f.minY >= L.minY + 2, f.minY - L.maxY <= 60, abs(f.minX - L.minX) <= 60 {
            let d = f.minY - L.maxY
            if under == nil || d < under!.0 { under = (d, c) }
        }
    }
    return row?.1 ?? under?.1
}

/// The element that has keyboard focus in this app, if any.
func focusedEl(_ app: AXUIElement) -> AXUIElement? { attr(app, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement } }

/// Somewhere typing goes into text: a field, or anything whose value can be edited.
func isEditable(_ e: AXUIElement?) -> Bool {
    guard let e else { return false }
    if FIELD_ROLES.contains(axRole(e)) { return true }
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
}

/// Puts the cursor in a field, replaces its text and reads back what it shows. Never types unless the field
/// really has focus, so text can't land in some other field or set off page shortcuts.
func typeInto(_ app: AXUIElement, _ e: AXUIElement, _ text: String) -> (ok: Bool, shows: String) {
    // A field further down the page: scroll it into view first, or the click lands on whatever is at its old spot.
    if let f = frame(e), let wf = axWindowFrame(e), !wf.contains(CGPoint(x: f.midX, y: min(f.midY, f.minY + 12))) {
        AXUIElementPerformAction(e, "AXScrollToVisible" as CFString); Thread.sleep(forTimeInterval: 0.3)
    }
    AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if let f = frame(e) { click(CGPoint(x: f.midX, y: min(f.midY, f.minY + 12))) }
    Thread.sleep(forTimeInterval: 0.08)
    let role = axRole(e)
    if !inWebPage(e), !["AXDateField", "AXTimeField", "AXDateTimeArea"].contains(role),
       AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, text as CFString) == .success, str(e, kAXValueAttribute) == text {
        return (true, text)
    }
    let focusedHere: Bool = {
        if (attr(e, kAXFocusedAttribute) as? Bool) == true { return true }
        guard let f = focusedEl(app) else { return false }
        return CFEqual(f, e) || (frame(f).map { fr in frame(e).map { $0.intersects(fr) } ?? false } ?? false)
    }()
    if !focusedHere, !["AXDateField", "AXTimeField", "AXDateTimeArea"].contains(role) { return (false, str(e, kAXValueAttribute) ?? "") }
    if ["AXDateField", "AXTimeField", "AXDateTimeArea"].contains(role) {
        // Date fields are a row of segments (month, day, year): start in the first and type digits; each
        // segment moves on by itself when full.
        // The segments (month, day, year steppers) can sit a few levels down inside the field.
        var segs: [(AXUIElement, CGRect)] = []
        var stack: [(AXUIElement, Int)] = ((attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []).map { ($0, 1) }
        while let (c, d) = stack.popLast() {
            if axRole(c) == "AXIncrementor", let f = frame(c) { segs.append((c, f)) }
            else if d < 5 { stack += ((attr(c, kAXChildrenAttribute) as? [AXUIElement]) ?? []).map { ($0, d + 1) } }
        }
        segs.sort { $0.1.minX < $1.1.minX }
        // Click each segment and type its part with real number keys (segments ignore keyless characters
        // and don't always move on by themselves). Parts go in the order the segments appear.
        let digitKey: [Character: CGKeyCode] = ["0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25]
        let parts = text.split { !$0.isNumber }.map(String.init)
        var pid: pid_t = 0
        AXUIElementGetPid(e, &pid)
        let before = Set(windows().filter { $0.pid == pid }.map { $0.id })
        let pairs: [((AXUIElement, CGRect)?, String)] = segs.count == parts.count ? zip(segs, parts).map { ($0, $1) } : [(segs.first, parts.joined())]
        for (seg, part) in pairs {
            if let seg { click(CGPoint(x: seg.1.midX, y: seg.1.midY)); Thread.sleep(forTimeInterval: 0.08) }
            for ch in part {
                guard let k = digitKey[ch] else { continue }
                let d = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: true)!, u = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false)!
                d.flags = []; u.flags = []
                send(d); send(u)
                Thread.sleep(forTimeInterval: 0.03)
            }
        }
        Thread.sleep(forTimeInterval: 0.15)
        // Safari opens a calendar in its own little window over the form; later clicks would land on its days.
        // Tab closes it and keeps the date (Return would submit the form).
        if windows().contains(where: { $0.pid == pid && !before.contains($0.id) && $0.title.isEmpty && $0.w < 500 && $0.h < 500 }) {
            _ = pressKey("tab"); Thread.sleep(forTimeInterval: 0.2)
        }
        return (true, segs.compactMap { str($0.0, kAXValueAttribute) }.joined(separator: "/"))
    } else {
        _ = pressKey("cmd+a"); typeText(text)
    }
    Thread.sleep(forTimeInterval: 0.12)
    return (true, str(e, kAXValueAttribute) ?? "")
}

/// A menu item or list option with this text anywhere in the app: open dropdown menus and pickers often
/// live outside the window. Exact text first, then text that starts with it.
func findOption(_ app: AXUIElement, _ w: Win, _ option: String, excluding: AXUIElement? = nil) -> AXUIElement? {
    let q = fold(option)
    var roots: [AXUIElement] = (attr(app, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    if let win = axWindow(app, w) { roots.insert(win, at: 0) }
    var exact: AXUIElement?, prefix: AXUIElement?, visited = 0
    var stack: [(AXUIElement, Int)] = roots.reversed().map { ($0, 0) }
    while let (el, depth) = stack.popLast(), visited < 20000, exact == nil {
        visited += 1
        let a = attrs(el, [kAXRoleAttribute, kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXChildrenAttribute])
        let role = strOf(a[0]) ?? ""
        if role == "AXMenuBar" { continue }
        // The dropdown's own text (a search box shows what was typed) isn't an option.
        if let x = excluding, CFEqual(el, x) { continue }
        if ["AXMenuItem", "AXStaticText", "AXCell", "AXRow", "AXButton", "AXRadioButton", "AXLink", "AXGroup", "AXListItem", "AXOption"].contains(role) {
            for t in [strOf(a[1]), strOf(a[2]), strOf(a[3])].compactMap({ $0 }).map(fold) where !t.isEmpty {
                if t == q { exact = el; break }
                if prefix == nil, t.hasPrefix(q), t.count <= q.count + 25 { prefix = el }
            }
        }
        if depth < 60, let kids = a[4] as? [AXUIElement] { for k in kids.reversed() { stack.append((k, depth + 1)) } }
    }
    return exact ?? prefix
}

/// The frame of the window an element is in.
func axWindowFrame(_ e: AXUIElement) -> CGRect? { attr(e, kAXWindowAttribute).flatMap { frame($0 as! AXUIElement) } }

/// Of many matches (every post's "Reply" button), the one that belongs with the anchor text: the first one at
/// or below the anchor's top, nearest first; if none is below, the nearest one above.
func nearestAfter(_ anchor: CGRect, _ cands: [(AXUIElement, [String: Any])]) -> (AXUIElement, [String: Any])? {
    let placed = cands.compactMap { c in frame(c.0).map { (c, $0) } }
    let below = placed.filter { $0.1.minY >= anchor.minY - 4 }.min { ($0.1.minY - anchor.minY) + abs($0.1.minX - anchor.minX) * 0.2 < ($1.1.minY - anchor.minY) + abs($1.1.minX - anchor.minX) * 0.2 }
    return below?.0 ?? placed.min { anchor.minY - $0.1.maxY < anchor.minY - $1.1.maxY }?.0
}
/// Where the `near` text is (on screen or scrolled out of view), for nearestAfter.
func anchorFrame(_ app: AXUIElement, _ w: Win, _ near: String) -> CGRect? {
    findTextEls(app, w, near, hidden: true).first.flatMap { frame($0.0) }
}

/// The text of an option-like element: title, value or description.
func optionText(_ el: AXUIElement) -> [String] { [str(el, kAXTitleAttribute), str(el, kAXValueAttribute), str(el, kAXDescriptionAttribute)].compactMap { $0 }.map(fold) }
func isInside(_ el: AXUIElement, _ ancestor: AXUIElement) -> Bool {
    var cur: AXUIElement? = el
    for _ in 0..<12 { guard let c = cur else { return false }; if CFEqual(c, ancestor) { return true }; cur = attr(c, kAXParentAttribute).map { $0 as! AXUIElement } }
    return false
}
/// The list a dropdown opened: the on-screen list, menu or table nearest below the dropdown (or above it).
func openList(_ app: AXUIElement, _ w: Win, near: CGRect) -> AXUIElement? {
    guard let root = axWindow(app, w) else { return nil }
    let win = CGRect(x: w.x, y: w.y, width: w.w, height: w.h)
    var best: (CGFloat, AXUIElement)?, stack: [(AXUIElement, Int)] = [(root, 0)], visited = 0
    while let (el, depth) = stack.popLast(), visited < 8000 {
        visited += 1
        let a = attrs(el, [kAXRoleAttribute, kAXChildrenAttribute])
        if ["AXList", "AXMenu", "AXTable", "AXOutline", "AXListBox"].contains(strOf(a[0]) ?? ""), let f = frame(el), f.intersects(win), f.height > 20 {
            let d = abs(f.minY - near.maxY) + abs(f.minX - near.minX) * 0.5
            if best == nil || d < best!.0 { best = (d, el) }
        }
        if depth < 60, let kids = a[1] as? [AXUIElement] { for k in kids.reversed() { stack.append((k, depth + 1)) } }
    }
    return best?.1
}
/// The rows of a list that are in view right now (a virtualized list only has these).
func visibleRows(_ list: AXUIElement, _ win: CGRect) -> [AXUIElement] {
    let kids = (attr(list, "AXVisibleChildren") as? [AXUIElement]) ?? (attr(list, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    return kids.filter { frame($0).map { win.intersects($0) } ?? false }
}
func optionIn(_ list: AXUIElement, _ q: String) -> AXUIElement? {
    var stack: [(AXUIElement, Int)] = [(list, 0)], prefix: AXUIElement?, visited = 0
    while let (el, d) = stack.popLast(), visited < 3000 {
        visited += 1
        let a = attrs(el, [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXChildrenAttribute])
        let t = [strOf(a[0]), strOf(a[1]), strOf(a[2])].compactMap { $0 }.map(fold)
        if t.contains(q) { return el }
        if prefix == nil, t.contains(where: { $0.hasPrefix(q) && $0.count <= q.count + 25 }) { prefix = el }
        if d < 8, let kids = a[3] as? [AXUIElement] { for k in kids.reversed() { stack.append((k, d + 1)) } }
    }
    return prefix
}
/// Scrolls an open list a screenful at a time, down to its end and then back up, until the option shows up.
/// Works for long lists and virtualized ones, where rows out of view don't exist until scrolled to.
func scrollListFor(_ app: AXUIElement, _ w: Win, _ list: AXUIElement, _ option: String) -> AXUIElement? {
    // In the background: an option already in view needs no scrolling; finding one further down needs the wheel,
    // which only the real cursor can turn.
    if inBackground { if let o = optionIn(list, fold(option)) { return o }; return withRealCursor { scrollListFor(app, w, list, option) } ?? nil }
    let q = fold(option), win = CGRect(x: w.x, y: w.y, width: w.w, height: w.h)
    let deadline = Date().addingTimeInterval(20)
    for dir: Int32 in [-1, 1] {
        var last = "", same = 0
        while Date() < deadline {
            if let o = optionIn(list, q) { return o }
            let rows = visibleRows(list, win)
            let box = rows.compactMap(frame).reduce(CGRect.null) { $0.union($1) }.intersection(win)
            guard !box.isNull, box.height > 4 else { return nil }
            let sig = rows.map { optionText($0).first ?? "" }.joined(separator: "|")
            if sig == last { same += 1; if same >= 2 { break } } else { same = 0 }
            last = sig
            // Most of a screenful, so a virtualized list never skips rows between looks.
            let px = Int32(max(40, box.height * 0.7))
            moveTo(CGPoint(x: box.midX, y: box.midY))
            if let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: dir * px, wheel2: 0, wheel3: 0) { e.flags = []; sendScroll(e) }
            Thread.sleep(forTimeInterval: 0.07)
        }
    }
    return optionIn(list, q)
}

/// Presses an element, or clicks its middle if it can't be pressed. Scrolls it into view first.
func activate(_ e: AXUIElement) {
    AXUIElementPerformAction(e, "AXScrollToVisible" as CFString)
    if axRole(e) == "AXMenuItem" || AXUIElementPerformAction(e, kAXPressAction as CFString) == .success {
        if axRole(e) == "AXMenuItem" { AXUIElementPerformAction(e, kAXPressAction as CFString) }
        return
    }
    if pressText(e) { return }
    if let f = frame(e) { click(CGPoint(x: f.midX, y: f.midY)) }
}

func scrollAt(_ p: CGPoint, dy: Int32, dx: Int32) {
    moveTo(p)
    Thread.sleep(forTimeInterval: 0.03)
    if let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) { e.flags = []; sendScroll(e) }
}

/// A whole label or heading, not the same words buried in a paragraph.
func wholeMatch(_ m: [String: Any], _ q: String) -> Bool {
    (m["match"] as? String) != "partial" || ((m["text"] as? String) ?? "").count <= max(40, q.count * 3)
}

/// Visible text isn't there, but it may be further down the page: scroll the best match into view.
/// Returns true if something was scrolled.
func scrollToText(_ app: AXUIElement, _ w: Win, _ q: String) -> Bool {
    let win = CGRect(x: w.x, y: w.y, width: w.w, height: w.h)
    guard let (e, _) = findTextEls(app, w, q, hidden: true).first(where: { wholeMatch($0.1, q) && !(frame($0.0).map { win.intersects($0) } ?? false) }) else { return false }
    var cur: AXUIElement? = e
    for _ in 0..<4 {
        guard let c = cur else { break }
        if AXUIElementPerformAction(c, "AXScrollToVisible" as CFString) == .success { Thread.sleep(forTimeInterval: 0.35); return true }
        cur = attr(c, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return false
}

/// Readable text in the window (headings, paragraphs, labels), top to bottom, so pages can be read without
/// a screenshot. Visible text only, capped so a long page can't flood the reply.
/// Text on the page that's scrolled out of view, top to bottom. When it's long, the start and the end are
/// kept (headings up top, contact details and footers at the bottom), with a note for what's in between.
/// Every text and heading in the window, in one pass (role, text, place and children in one round trip each):
/// on-screen texts as (y, x, text) for pageText, and scrolled-out-of-view ones for offscreenText.
struct TextScan { var on: [(CGFloat, CGFloat, String)] = []; var off: [(CGFloat, String)] = [] }
func scanText(_ app: AXUIElement, _ w: Win, wantOn: Bool = true, wantOff: Bool = true) -> TextScan {
    var scan = TextScan()
    guard let root = axWindow(app, w) else { return scan }
    let win = CGRect(x: w.x, y: w.y, width: w.w, height: w.h)
    var seenOn = Set<String>(), seenOff = Set<String>(), visited = 0
    var stack: [(AXUIElement, Int)] = [(root, 0)]
    // The in-view pass stopped at 8000 elements and the out-of-view one at 12000; keep both limits.
    let maxVisit = wantOff ? 12000 : 8000
    while let (el, depth) = stack.popLast(), visited < maxVisit {
        visited += 1
        let a = attrs(el, [kAXRoleAttribute, kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute])
        let role = strOf(a[0]) ?? ""
        if role == "AXStaticText" || role == "AXHeading", let f = frameOf(a[4], a[5]) {
            let norm = { (t: String) in t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces) }
            if win.intersects(f) {
                if wantOn, visited <= 8000, let t = strOf(a[1]) ?? strOf(a[2]) ?? strOf(a[3]) {
                    let line = norm(t)
                    if line.count >= 2, seenOn.insert(line).inserted { scan.on.append((f.minY, f.minX, String(line.prefix(160)))) }
                }
            } else if wantOff, f.height > 1, let t = strOf(a[1]) ?? strOf(a[2]) {
                let line = norm(t)
                if line.count >= 2, seenOff.insert(line).inserted { scan.off.append((f.minY, String(line.prefix(160)))) }
            }
        }
        if depth < 60, let kids = a[6] as? [AXUIElement] { for k in kids.reversed() { stack.append((k, depth + 1)) } }
    }
    return scan
}

func offscreenText(_ app: AXUIElement, _ w: Win, cap: Int, scan: TextScan? = nil) -> [String] {
    let found = (scan ?? scanText(app, w, wantOn: false)).off
    let lines = found.sorted { $0.0 < $1.0 }.map { $0.1 }
    if lines.reduce(0, { $0 + $1.count + 1 }) <= cap { return lines }
    var head: [String] = [], tail: [String] = [], h = 0, t = 0
    for l in lines { if h + l.count > cap / 2 { break }; head.append(l); h += l.count + 1 }
    for l in lines.reversed() { if t + l.count > cap / 2 { break }; tail.insert(l, at: 0); t += l.count + 1 }
    return head + ["…(\(lines.count - head.count - tail.count) more lines in between; point_at or click_text with their words scrolls there)"] + tail
}

func pageText(_ app: AXUIElement, _ w: Win, cap: Int = 1800, scan: TextScan? = nil) -> [String] {
    let found = (scan ?? scanText(app, w, wantOff: false)).on
    var out: [String] = [], total = 0
    let sorted = found.sorted(by: { abs($0.0 - $1.0) > 4 ? $0.0 < $1.0 : $0.1 < $1.1 })
    for (k, (_, _, t)) in sorted.enumerated() {
        if total + t.count > cap { out.append("…(\(sorted.count - k) more lines further down this screen; read_window shows them all)"); break }
        out.append(t); total += t.count + 1
    }
    return out
}

/// After a click or key press the page may be loading: re-read until the controls stop changing (max ~1.2 s).
func settle(_ app: AXUIElement, _ w: Win) -> [(AXUIElement, [String: Any])] {
    var prev: [String] = [], cur = walk(app, w)
    for _ in 0..<4 {
        Thread.sleep(forTimeInterval: 0.2)
        prev = cur.map { "\($0.1["role"] ?? "")|\($0.1["label"] ?? "")" }
        cur = walk(app, w)
        if cur.map({ "\($0.1["role"] ?? "")|\($0.1["label"] ?? "")" }) == prev { break }
    }
    return cur
}

func axApp(_ w: Win) -> AXUIElement {
    let app = AXUIElementCreateApplication(w.pid)
    // Chromium and Electron only build their accessibility tree when asked to.
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    return app
}

// ---------- input ----------

// A private source: events don't pick up modifier keys still held (or just "pressed" by a cmd+a step),
// which turned typed digits into Cmd+1… and switched browser tabs.
let src = CGEventSource(stateID: .privateState)

// Background mode (the default; ROAMIES_BG=0 turns it off). Roamies acts in an app without the user's cursor or
// keyboard focus, so they can keep working: keys and typing go straight to that app, shortcuts like Cmd+S press the
// app's own menu item, clicks are accessibility presses on what's at the spot, scrolls are sent to the app.
// A step that only works with the real cursor (date pickers, a field that didn't take the typing, a spot with nothing
// pressable) borrows it: the app comes forward, the step runs, then the cursor goes back where it was and the user's
// app comes back to the front.
let BG = ProcessInfo.processInfo.environment["ROAMIES_BG"] != "0"
var bgPid: pid_t? = nil
var bgPoint = CGPoint.zero
var fgActive = false
var bgWin: Win? = nil
var bgApp: AXUIElement? = nil
var usedRealCursor = false
var inBackground: Bool { BG && !fgActive && bgPid != nil }
func send(_ e: CGEvent) { if inBackground { e.postToPid(bgPid!) } else { e.post(tap: .cghidEventTap) } }
func moveTo(_ p: CGPoint) {
    if inBackground { bgPoint = p; return }
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}
func sendScroll(_ e: CGEvent) { if inBackground { e.location = bgPoint; e.postToPid(bgPid!) } else { e.post(tap: .cghidEventTap) } }
/// A click without the cursor: focuses the text field at that spot, or presses the nearest pressable thing there.
/// False when nothing there can be focused or pressed (then the real cursor is needed).
func bgClick(_ pid: pid_t, _ p: CGPoint) -> Bool {
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(p.x), Float(p.y), &el) == .success, var cur = el else { return false }
    for _ in 0..<6 {
        let role = str(cur, kAXRoleAttribute) ?? ""
        if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField"].contains(role) {
            return AXUIElementSetAttributeValue(cur, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
        }
        if ["AXWebArea", "AXWindow", "AXScrollArea", "AXApplication"].contains(role) { return false }
        var names: CFArray?
        if AXUIElementCopyActionNames(cur, &names) == .success, let n = names as? [String], n.contains(kAXPressAction as String),
           AXUIElementPerformAction(cur, kAXPressAction as CFString) == .success { return true }
        guard let up = attr(cur, kAXParentAttribute) else { return false }
        cur = up as! AXUIElement
    }
    return false
}
/// Live progress for the overlay while acting: one JSON line per event on stderr, prefixed with "@" (stdout keeps
/// the single result line). The sidecar turns these into the Sidekick's cursor, window peek and heads-up.
func progress(_ d: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: d), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(("@" + line + "\n").data(using: .utf8)!)
}
/// Before taking the real cursor: tell the user (the Sidekick says so), and if they're using the mouse or keyboard
/// right now give them a moment to let go. Returns what to restore afterwards.
func borrowBegin() -> (CGPoint?, NSRunningApplication?)? {
    progress(["ev": "borrow"])
    // A moment for the heads-up to show, then wait until they've stopped typing and moving the mouse for a second:
    // taking over mid-sentence sends their keystrokes into the target app. If they keep going, don't take over.
    Thread.sleep(forTimeInterval: 0.9)
    let anyInput = CGEventType(rawValue: ~0)!
    let until = Date().addingTimeInterval(8)
    while CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput) < 1.0 {
        if Date() > until { progress(["ev": "return"]); return nil }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return (CGEvent(source: nil)?.location, NSWorkspace.shared.frontmostApplication)
}
/// Set when a step needed the real cursor but the user was busy, so it was skipped instead.
var userBusy = false
/// Gives the cursor and the front app back.
func borrowEnd(_ saved: (CGPoint?, NSRunningApplication?), _ w: Win) {
    if let c = saved.0 { CGWarpMouseCursorPosition(c); CGAssociateMouseAndMouseCursorPosition(1) }
    if let prev = saved.1, prev.processIdentifier != w.pid, !isRoamies(prev.processIdentifier) { prev.activate(options: []) }
    progress(["ev": "return"])
}
/// Runs body with the real cursor and keyboard, then gives them back to the user.
@discardableResult
func withRealCursor<T>(_ body: () -> T) -> T? {
    guard BG, !fgActive, let w = bgWin, let app = bgApp else { return body() }
    usedRealCursor = true
    guard let saved = borrowBegin() else { userBusy = true; return nil }
    fgActive = true
    defer { fgActive = false; borrowEnd(saved, w) }
    _ = bringToFront(w, app)
    return body()
}
/// Saves the document in that window without bringing its app forward: AppleScript's save, which document-based
/// apps (TextEdit, Pages, Numbers, Preview…) support. Only documents that already have a file (no Save dialog).
func saveInBackground(_ w: Win) -> Bool {
    guard let bundle = NSRunningApplication(processIdentifier: w.pid)?.bundleIdentifier else { return false }
    // The window's own file, from its accessibility info: matches the right document even when several share a name.
    // TextEdit saves but often never answers the save event, so don't wait for a reply: watch the file change instead.
    if let axw = axWindow(axApp(w), w), let doc = str(axw, "AXDocument"), let url = URL(string: doc), url.isFileURL {
        let path = url.path
        let esc = path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let mtime = { (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date) ?? nil }
        let before = mtime()
        let script = """
        with timeout of 3 seconds
        tell application id "\(bundle)"
        repeat with x in documents
        set p to ""
        try
        set p to (path of x) as text
        end try
        if p is "\(esc)" or "/private" & p is "\(esc)" or p is "/private\(esc)" then
        ignoring application responses
        save x
        end ignoring
        return
        end if
        end repeat
        end tell
        end timeout
        error "not found"
        """
        if run("/usr/bin/osascript", ["-e", script]) == 0 {
            let until = Date().addingTimeInterval(3)
            while Date() < until {
                if let a = mtime(), a != before { return true }
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
    }
    let title = w.title.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    let script = """
    with timeout of 8 seconds
    tell application id "\(bundle)"
    set d to missing value
    repeat with x in documents
    if name of x is "\(title)" or "\(title)" starts with (name of x) then set d to x
    end repeat
    if d is missing value then set d to document 1
    if path of d is missing value then error "no file"
    save d
    end tell
    end timeout
    """
    return run("/usr/bin/osascript", ["-e", script]) == 0
}
/// Cmd shortcuts in the background: press the app's menu item that has that shortcut (keys sent to a background
/// app don't reach its menus, so Cmd+S typed the line but never saved). False if no menu item has it.
func pressMenuShortcut(_ app: AXUIElement, _ combo: String) -> Bool {
    let parts = combo.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+").map(String.init)
    guard let key = parts.last, key.count == 1, parts.contains(where: { ["cmd", "command", "meta", "super"].contains($0) }) else { return false }
    let shift = parts.contains("shift"), opt = parts.contains { ["opt", "option", "alt"].contains($0) }, ctrl = parts.contains { ["ctrl", "control"].contains($0) }
    let want = (shift ? 1 : 0) | (opt ? 2 : 0) | (ctrl ? 4 : 0)
    guard let bar = attr(app, kAXMenuBarAttribute) else { return false }
    var stack: [(AXUIElement, Int)] = [(bar as! AXUIElement, 0)]
    var visited = 0
    while let (el, d) = stack.popLast(), visited < 3000 {
        visited += 1
        let a = attrs(el, ["AXMenuItemCmdChar", "AXMenuItemCmdModifiers", kAXEnabledAttribute, kAXChildrenAttribute])
        if let ch = a[0] as? String, ch.lowercased() == key, let mods = (a[1] as? NSNumber)?.intValue, mods & 8 == 0, mods & 7 == want, (a[2] as? Bool) != false {
            return AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
        }
        if d < 4, let kids = a[3] as? [AXUIElement] { for k in kids { stack.append((k, d + 1)) } }
    }
    return false
}
func typeText(_ s: String) {
    for chunk in Array(s.utf16).chunked(16) {
        var u = chunk
        let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!, up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!
        d.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
        up.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
        d.flags = []; up.flags = []
        send(d); send(up)
        Thread.sleep(forTimeInterval: 0.012)
    }
}
extension Array { func chunked(_ n: Int) -> [[Element]] { stride(from: 0, to: count, by: n).map { Array(self[$0 ..< Swift.min($0 + n, count)]) } } }

let KEYS: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
    "j": 38, "k": 40, "n": 45, "m": 46, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
    "f10": 109, "f11": 103, "f12": 111, "=": 24, "-": 27, "/": 44, ".": 47, ",": 43, ";": 41, "'": 39, "[": 33, "]": 30, "\\": 42, "`": 50]
/// Keys people (and models) name by symbol or word: Calculator's "*" or "multiply" is shift+8. Unknown names
/// used to fail the whole step list.
let KEY_ALIASES: [String: String] = ["*": "shift+8", "multiply": "shift+8", "times": "shift+8", "+": "shift+=", "plus": "shift+=", "add": "shift+=",
    "minus": "-", "subtract": "-", "divide": "/", "slash": "/", "equals": "=", "equal": "=", "period": ".", "dot": ".", "decimal": ".", "comma": ",",
    "%": "shift+5", "percent": "shift+5", "(": "shift+9", ")": "shift+0", "!": "shift+1", "@": "shift+2", "#": "shift+3", "$": "shift+4",
    "^": "shift+6", "&": "shift+7", "_": "shift+-", "?": "shift+/", ":": "shift+;", "\"": "shift+'", "<": "shift+,", ">": "shift+.",
    "{": "shift+[", "}": "shift+]", "|": "shift+\\", "~": "shift+`", "page_up": "pageup", "page_down": "pagedown", "pgup": "pageup", "pgdn": "pagedown",
    "del": "forwarddelete", "arrowleft": "left", "arrowright": "right", "arrowup": "up", "arrowdown": "down", "spacebar": "space", "back": "backspace",
    // Mac text has no Cmd/Ctrl+End: the end and start of a document are Cmd+Down and Cmd+Up.
    "cmd+end": "cmd+down", "cmd+home": "cmd+up", "ctrl+end": "cmd+down", "ctrl+home": "cmd+up", "command+end": "cmd+down", "command+home": "cmd+up"]
/// "cmd+a", "shift+tab", "return", "*", "cmd+end".
func pressKey(_ combo: String) -> Bool {
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    var c = combo.lowercased().trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "")
    if let a = KEY_ALIASES[c] { c = a }
    // "+" alone, or "cmd++": the last + is the key itself.
    var parts = c.split(separator: "+", omittingEmptySubsequences: true).map(String.init)
    if c.hasSuffix("++") || c == "+" { parts += ["shift", "="] }
    parts = parts.flatMap { KEY_ALIASES[$0].map { $0.split(separator: "+").map(String.init) } ?? [$0] }
    for part in parts {
        switch part {
        case "cmd", "command": flags.insert(.maskCommand)
        case "ctrl", "control": flags.insert(.maskControl)
        case "opt", "option", "alt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: key = KEYS[part]
        }
    }
    guard let k = key else { return false }
    let d = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: true)!, u = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false)!
    d.flags = flags; u.flags = flags
    send(d); send(u)
    Thread.sleep(forTimeInterval: 0.05)
    return true
}
func click(_ p: CGPoint) {
    if inBackground {
        if bgClick(bgPid!, p) { return }
        withRealCursor { click(p) }
        return
    }
    for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!
        e.flags = []
        e.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.04)
    }
}

// Apps Sidekick may point at but never type or click in: typing into a terminal would run commands
// past every check, and these others hold passwords or security settings.
let HANDS_OFF: [String: String] = [
    "com.apple.Terminal": "Terminal", "com.googlecode.iterm2": "iTerm", "dev.warp.Warp-Stable": "Warp", "dev.warp.Warp": "Warp",
    "com.mitchellh.ghostty": "Ghostty", "net.kovidgoyal.kitty": "kitty", "org.alacritty": "Alacritty", "io.alacritty": "Alacritty",
    "com.github.wez.wezterm": "WezTerm", "co.zeit.hyper": "Hyper", "org.tabby": "Tabby", "com.raphaelamorim.rio": "Rio",
    "com.apple.keychainaccess": "Keychain Access", "com.apple.Passwords": "Passwords", "com.apple.ScriptEditor2": "Script Editor",
    "com.apple.Automator": "Automator", "com.apple.systempreferences": "System Settings", "com.apple.Settings": "System Settings",
    "com.1password.1password": "1Password", "com.agilebits.onepassword7": "1Password", "com.bitwarden.desktop": "Bitwarden",
    "com.apple.dt.Xcode": "Xcode", "com.apple.Console": "Console", "com.apple.ActivityMonitor": "Activity Monitor",
    "com.apple.DiskUtility": "Disk Utility", "com.apple.MigrateAssistant": "Migration Assistant", "com.apple.installer": "Installer",
]

func handsOff(_ pid: pid_t) -> String? {
    guard let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier else { return nil }
    return HANDS_OFF[id]
}

// ---------- image: crop, resize, numbered marks ----------
// Same 5×7 digits, colours and layout as hands-win/src/draw.rs, so marks look alike on both systems.

let DIGITS: [[UInt8]] = [
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
]
let MARK_RGB: [[CGFloat]] = [[220, 40, 40], [30, 90, 220], [40, 140, 30], [150, 40, 170], [200, 100, 0], [0, 120, 140]]

struct Mark { let n: Int; let x: Int; let y: Int; let w: Int; let h: Int }

func imageFail(_ code: String, _ msg: String) -> Never { out(["ok": false, "code": code, "error": msg]) }

// "x,y,w,h" or "w,h": whole numbers; the last two (the size) must be positive.
func numbers(_ s: String, _ count: Int, _ name: String) -> [Int] {
    let parts = s.split(separator: ",", omittingEmptySubsequences: false).map { Int($0.trimmingCharacters(in: .whitespaces)) }
    guard parts.count == count, parts.allSatisfy({ $0 != nil }) else { imageFail("usage", "\(name) needs \(count) whole numbers separated by commas.") }
    let v = parts.map { $0! }
    guard v[count - 2] > 0, v[count - 1] > 0, v[count - 2] <= 20000, v[count - 1] <= 20000 else { imageFail("usage", "\(name) needs a positive size.") }
    return v
}

func parseMarks(_ file: String) -> [Mark] {
    guard let data = FileManager.default.contents(atPath: file) else { imageFail("not_found", "Can't read marks \(file).") }
    guard let list = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else { imageFail("usage", "Marks \(file) must be a JSON array.") }
    var marks: [Mark] = []
    for (i, item) in list.enumerated() {
        let m = item as? [String: Any] ?? [:]
        guard let n = (m["n"] as? NSNumber)?.intValue, n >= 1, n <= 9999 else { imageFail("usage", "mark \(i): n must be 1–9999") }
        let r = ((m["rect"] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.doubleValue }.map { Int($0.rounded()) }
        guard r.count == 4, r[2] > 0, r[3] > 0 else { imageFail("usage", "mark \(i): rect must be [x, y, w, h] with a positive size") }
        marks.append(Mark(n: n, x: r[0], y: r[1], w: r[2], h: r[3]))
    }
    return marks
}

// The context is flipped so (x, y) is the top-left, like the image's own pixels.
func drawMarks(_ ctx: CGContext, _ marks: [Mark], _ w: Int, _ h: Int) {
    let s = min(w, h) >= 400 ? 2 : 1
    func fill(_ x: Int, _ y: Int, _ fw: Int, _ fh: Int, _ rgb: [CGFloat]) {
        ctx.setFillColor(red: rgb[0] / 255, green: rgb[1] / 255, blue: rgb[2] / 255, alpha: 1)
        ctx.fill(CGRect(x: x, y: y, width: fw, height: fh))
    }
    func colour(_ n: Int) -> [CGFloat] { MARK_RGB[n % MARK_RGB.count] }
    // All outlines first, then the tags, so a neighbour's outline never covers a number.
    for m in marks {
        let c = colour(m.n)
        fill(m.x, m.y, m.w, s, c); fill(m.x, m.y + m.h - s, m.w, s, c)
        fill(m.x, m.y, s, m.h, c); fill(m.x + m.w - s, m.y, s, m.h, c)
    }
    for m in marks {
        let text = String(m.n)
        let (tw, th) = (text.count * 6 * s + s + 2 * s, 7 * s + 2 * s)
        let tx = min(max(m.x, 0), max(w - tw, 0))
        let ty = min(max(m.y >= th ? m.y - th : m.y, 0), max(h - th, 0))
        fill(tx, ty, tw, th, colour(m.n))
        for (i, ch) in text.enumerated() {
            let glyph = DIGITS[Int(String(ch))!]
            let gx = tx + 2 * s - s / 2 + i * 6 * s
            for (row, bits) in glyph.enumerated() {
                for col in 0..<5 where bits & (0b10000 >> UInt8(col)) != 0 {
                    fill(gx + col * s, ty + s + row * s, s, s, [255, 255, 255])
                }
            }
        }
    }
}

func imageVerb(_ a: [String]) -> Never {
    guard a.count >= 3 else { imageFail("usage", "usage: image <in> <out.jpg> [--crop x,y,w,h] [--size w,h] [--marks marks.json]") }
    let input = a[1], output = a[2]
    var crop: [Int]? = nil, size: [Int]? = nil, marksFile: String? = nil
    var i = 3
    while i < a.count {
        guard i + 1 < a.count else { imageFail("usage", "\(a[i]) needs a value.") }
        switch a[i] {
        case "--crop": crop = numbers(a[i + 1], 4, "--crop")
        case "--size": size = numbers(a[i + 1], 2, "--size")
        case "--marks": marksFile = a[i + 1]
        default: imageFail("usage", "Unknown option \(a[i]).")
        }
        i += 2
    }
    guard FileManager.default.fileExists(atPath: input) else { imageFail("not_found", "No image at \(input).") }
    // Read the marks before any pixel work so a bad file fails fast.
    let marks = marksFile.map(parseMarks) ?? []
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
          var img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { imageFail("image_failed", "Can't decode \(input).") }
    if let c = crop {
        let whole = CGRect(x: 0, y: 0, width: img.width, height: img.height)
        let inner = CGRect(x: c[0], y: c[1], width: c[2], height: c[3]).intersection(whole)
        guard !inner.isNull, !inner.isEmpty else { imageFail("usage", "--crop \(c[0]),\(c[1]),\(c[2]),\(c[3]) is outside the \(img.width)×\(img.height) image.") }
        guard let cut = img.cropping(to: inner) else { imageFail("image_failed", "Crop failed.") }
        img = cut
    }
    let (w, h) = (size?[0] ?? img.width, size?[1] ?? img.height)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { imageFail("image_failed", "Can't make a \(w)×\(h) image.") }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: 1, y: -1)
    drawMarks(ctx, marks, w, h)
    guard let done = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, "public.jpeg" as CFString, 1, nil)
    else { imageFail("image_failed", "Can't write \(output).") }
    CGImageDestinationAddImage(dest, done, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { imageFail("image_failed", "Can't write \(output).") }
    out(["ok": true, "unit": "px", "file": output, "sent": [w, h]])
}

// ---------- permission guide ----------
// A small panel that sits under System Settings while a Privacy pane is open, holding Roamies' icon
// so it can be dragged straight into the list (macOS sometimes leaves the app out). Lives until
// stdin closes (Roamies quit or stopped it), Settings closes, or Accessibility is granted.

enum Pal {
    static func c(_ hex: Int) -> NSColor {
        NSColor(srgbRed: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
    }
    static let bg = c(0x051214), panel = c(0x071a1c), ink = c(0xe8fffa), ink2 = c(0xb4d8d1)
    static let line = c(0x1d4a48), lineHi = c(0x2f7c74), lineHot = c(0x4fbfa9), accent = c(0x78ffe2)
}

/// The onboarding's pixel frame: corners cut in two steps of `s` points (same polygon as .px in onboarding.css).
func pixelPath(_ r: NSRect, _ s: CGFloat = 2) -> NSBezierPath {
    let (x0, y0, x1, y1) = (r.minX, r.minY, r.maxX, r.maxY)
    let pts: [(CGFloat, CGFloat)] = [
        (x0 + 2 * s, y0), (x1 - 2 * s, y0), (x1 - 2 * s, y0 + s), (x1 - s, y0 + s), (x1 - s, y0 + 2 * s), (x1, y0 + 2 * s),
        (x1, y1 - 2 * s), (x1 - s, y1 - 2 * s), (x1 - s, y1 - s), (x1 - 2 * s, y1 - s), (x1 - 2 * s, y1), (x0 + 2 * s, y1),
        (x0 + 2 * s, y1 - s), (x0 + s, y1 - s), (x0 + s, y1 - 2 * s), (x0, y1 - 2 * s), (x0, y0 + 2 * s), (x0 + s, y0 + 2 * s),
        (x0 + s, y0 + s), (x0 + 2 * s, y0 + s),
    ]
    let p = NSBezierPath()
    p.move(to: NSPoint(x: pts[0].0, y: pts[0].1))
    for q in pts.dropFirst() { p.line(to: NSPoint(x: q.0, y: q.1)) }
    p.close()
    return p
}

func drawFrame(_ r: NSRect, frame: NSColor, fill: NSColor, width: CGFloat = 2) {
    frame.setFill(); pixelPath(r).fill()
    fill.setFill(); pixelPath(r.insetBy(dx: width, dy: width)).fill()
}

func guideEvent(_ o: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: o), let t = String(data: d, encoding: .utf8) { print(t) }
}

final class GuideBack: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) { drawFrame(bounds, frame: Pal.lineHi, fill: Pal.panel) }
}

/// Roamies' icon and name. Dragging it hands System Settings the app bundle, like dragging it from Finder.
final class DragPill: NSView, NSDraggingSource {
    let url: URL
    let icon: NSImage
    var hot = false { didSet { needsDisplay = true } }
    var dragging = false { didSet { needsDisplay = true } }
    init(frame: NSRect, url: URL) {
        self.url = url
        icon = NSWorkspace.shared.icon(forFile: url.path)
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Roamies app. Drag into the list above.")
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    required init?(coder: NSCoder) { nil }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: dragging ? .closedHand : .openHand) }
    override func mouseEntered(with event: NSEvent) { hot = true }
    override func mouseExited(with event: NSEvent) { hot = false }
    override func draw(_ dirtyRect: NSRect) {
        drawFrame(bounds, frame: hot || dragging ? Pal.accent : Pal.lineHot, fill: Pal.bg)
        let side = bounds.height - 16
        icon.draw(in: NSRect(x: 10, y: 8, width: side, height: side), from: .zero, operation: .sourceOver, fraction: dragging ? 0.35 : 1, respectFlipped: true, hints: nil)
        let label = NSAttributedString(string: "Roamies", attributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold), .foregroundColor: Pal.ink])
        let sz = label.size()
        label.draw(at: NSPoint(x: 10 + side + 8, y: (bounds.height - sz.height) / 2))
    }
    override func mouseDown(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        let img = NSImage(size: NSSize(width: 64, height: 64))
        img.lockFocus(); icon.draw(in: NSRect(x: 0, y: 0, width: 64, height: 64)); img.unlockFocus()
        let p = convert(event.locationInWindow, from: nil)
        item.setDraggingFrame(NSRect(x: p.x - 32, y: p.y - 32, width: 64, height: 64), contents: img)
        dragging = true
        window?.invalidateCursorRects(for: self)
        guideEvent(["event": "drag_started"])
        beginDraggingSession(with: [item], event: event, source: self)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? [.copy, .link, .generic] : []
    }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        dragging = false
        window?.invalidateCursorRects(for: self)
        guideEvent(["event": "drag_ended", "dropped": !operation.isEmpty])
    }
}

final class Guide: NSObject {
    static let settingsID = "com.apple.systempreferences"
    let kind: String
    let preview: Bool
    let panel: NSPanel
    let title = NSTextField(labelWithString: ""), body = NSTextField(wrappingLabelWithString: "")
    var pill: DragPill?
    var seen = false, missing = 0, done = false
    var dragging: Bool { pill?.dragging ?? false }

    init(kind: String, app: URL?, preview: Bool) {
        self.kind = kind
        self.preview = preview
        let hasPill = app != nil
        let size = NSSize(width: hasPill ? 452 : 320, height: 80)
        panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.alphaValue = 0
        let back = GuideBack(frame: NSRect(origin: .zero, size: size))
        panel.contentView = back
        var textX: CGFloat = 16
        if let app {
            let p = DragPill(frame: NSRect(x: 12, y: 12, width: 132, height: 56), url: app)
            back.addSubview(p)
            pill = p
            textX = 12 + 132 + 14
        }
        title.font = .monospacedSystemFont(ofSize: 12, weight: .semibold)
        title.textColor = Pal.ink
        body.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        body.textColor = Pal.ink2
        body.maximumNumberOfLines = 2
        let w = size.width - textX - 14
        title.frame = NSRect(x: textX, y: 14, width: w, height: 18)
        body.frame = NSRect(x: textX, y: 34, width: w, height: 34)
        for t in [title, body] { t.lineBreakMode = .byWordWrapping; back.addSubview(t) }
        // The guide opens Settings directly (no macOS dialog), so Roamies usually isn't in the list yet.
        title.stringValue = hasPill ? "Drag me into the list above." : "Add me to the list above."
        body.stringValue = kind == "screen"
            ? "Use Screen & System Audio Recording, not the audio-only list."
            : hasPill ? "Already there? Just switch me on." : "Press + under the list and pick Roamies."
        panel.setAccessibilityLabel("Roamies permission guide")
    }

    /// The biggest System Settings window, in AppKit coordinates (origin bottom-left of the main screen).
    func settingsFrame() -> NSRect? {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: Guide.settingsID).map { $0.processIdentifier })
        guard !pids.isEmpty, let main = NSScreen.screens.first else { return nil }
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let rects: [NSRect] = list.compactMap { w in
            guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? Int32, pids.contains(pid),
                  let b = w[kCGWindowBounds as String] as? [String: Double], (b["Width"] ?? 0) > 300, (b["Height"] ?? 0) > 200 else { return nil }
            let (x, y, ww, hh) = (b["X"] ?? 0, b["Y"] ?? 0, b["Width"] ?? 0, b["Height"] ?? 0)
            return NSRect(x: x, y: main.frame.maxY - y - hh, width: ww, height: hh)
        }
        return rects.max { $0.width * $0.height < $1.width * $1.height }
    }

    /// Under the window, centred on its content side (right of the sidebar); inside its bottom edge if there's no room below.
    func place(_ win: NSRect) {
        let size = panel.frame.size
        let screen = NSScreen.screens.first { $0.frame.intersects(win) }?.visibleFrame ?? win
        let sidebar: CGFloat = win.width > 640 ? 220 : 0
        var x = win.minX + sidebar + (win.width - sidebar - size.width) / 2
        var y = win.minY - size.height - 10
        if y < screen.minY { y = win.minY + 14 }
        x = min(max(x, screen.minX + 8), screen.maxX - size.width - 8)
        y = min(max(y, screen.minY + 8), screen.maxY - size.height - 8)
        let to = NSRect(origin: NSPoint(x: x.rounded(), y: y.rounded()), size: size)
        if to != panel.frame { panel.setFrame(to, display: true) }
    }

    func show(_ on: Bool) {
        let target: CGFloat = on ? 1 : 0
        if panel.alphaValue == target { return }
        if on { panel.orderFrontRegardless() }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            panel.animator().alphaValue = target
        }
    }

    func tick() {
        if done { return }
        if kind == "accessibility" && !preview && AXIsProcessTrusted() {
            done = true
            title.stringValue = "All set!"
            body.stringValue = "You can close System Settings."
            pill?.isHidden = true
            guideEvent(["event": "granted"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { self.show(false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { exit(0) }
            return
        }
        guard let win = settingsFrame() else {
            missing += 1
            // Settings closed after it was up (or never opened within a minute): nothing left to guide.
            if !dragging && ((seen && missing > 8) || missing > 240) { guideEvent(["event": "closed"]); exit(0) }
            if !dragging { show(false) }
            return
        }
        missing = 0
        if !seen { seen = true; guideEvent(["event": "attached"]) }
        place(win)
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        show(dragging || front == Guide.settingsID || front == nil)
    }
}

func runGuide(_ rest: [String]) -> Never {
    // --preview: stay up even when already allowed, to look at the panel.
    let preview = rest.contains("--preview")
    let pos = rest.filter { $0 != "--preview" }
    let kind = pos.first ?? "accessibility"
    let app = pos.count > 1 && pos[1].hasSuffix(".app") ? URL(fileURLWithPath: pos[1]) : nil
    let nsApp = NSApplication.shared
    nsApp.setActivationPolicy(.accessory)
    let guide = Guide(kind: kind, app: app, preview: preview)
    // Roamies holds our stdin open; when it closes (stopped, or Roamies quit), go.
    Thread { while FileHandle.standardInput.availableData.count > 0 {}; exit(0) }.start()
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in guide.tick() }
    guide.tick()
    nsApp.run()
    exit(0)
}

// ---------- secrets ----------
// The user's own API keys (Fish Audio) live in their login keychain: encrypted at rest, locked with their Mac
// login, and readable without a prompt only by this signed helper. A secret comes in on stdin and goes out on
// stdout, never in arguments (other processes can read those).
let secretService = "com.kenkai.roamies"
func secretName(_ i: Int) -> String {
    guard args.count > i, args[i].range(of: "^[a-z0-9-]{1,40}$", options: .regularExpression) != nil else { fail("bad secret name") }
    return args[i]
}
func secretQuery(_ name: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: secretService, kSecAttrAccount as String: name]
}

// ---------- commands ----------

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("no command") }

switch cmd {
case "trusted":
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: args.contains("--prompt")] as CFDictionary
    out(["ok": true, "trusted": AXIsProcessTrustedWithOptions(opts)])

case "windows":
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    out(["ok": true, "windows": windows().prefix(30).map { var i = winInfo($0); if $0.pid == front { i["frontApp"] = true }; return i }])

// Where the user is right now, for each message's live state: the app in front (never Roamies), its focused
// window's title, and for a browser the page's address. Accessibility for the title and address; the window list
// (title only with Screen Recording) as a fallback. Fast, read-only, never focuses anything.
case "front":
    var o: [String: Any] = ["ok": true]
    let wins = windows()
    let frontPid = NSWorkspace.shared.frontmostApplication.flatMap { isRoamies($0.processIdentifier) ? nil : $0.processIdentifier }
    guard let pid = frontPid ?? wins.first?.pid, let app = NSRunningApplication(processIdentifier: pid) else { out(o) }
    o["app"] = app.localizedName ?? "?"
    if let b = app.bundleIdentifier { o["bundle"] = b }
    let ax = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(ax, 0.25)
    var title = wins.first { $0.pid == pid }?.title ?? ""
    if let w = attr(ax, kAXFocusedWindowAttribute) {
        let win = w as! AXUIElement
        if let t = str(win, kAXTitleAttribute) { title = t }
        // Browsers put the address on the window (Safari) or on the web area inside it (Chromium browsers).
        if BROWSERS.contains(app.localizedName ?? "") {
            var url = str(win, "AXURL") ?? (attr(win, "AXURL") as? URL)?.absoluteString
            if url == nil {
                var queue: [AXUIElement] = [win], seen = 0
                while url == nil, !queue.isEmpty, seen < 400 {
                    let el = queue.removeFirst(); seen += 1
                    if str(el, kAXRoleAttribute) == "AXWebArea" { url = (attr(el, "AXURL") as? URL)?.absoluteString ?? str(el, "AXURL"); if url != nil { break } }
                    if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids.prefix(40)) }
                }
            }
            if let u = url { o["url"] = u }
        }
    }
    if !title.isEmpty { o["title"] = title }
    out(o)

case "locate":
    guard args.count >= 2 else { fail("usage: locate <target>") }
    if args[1] == "screen" { out(["ok": true, "what": "screen"]) }
    guard let w = resolve(args[1]) else { fail("No matching window is open\(args[1].hasPrefix("app:") ? " for \(args[1].dropFirst(4))" : "").") }
    out(["ok": true, "window": winInfo(w)])

case "capture":
    // capture <out> <target> [max]: with max, the image is shrunk here to at most max px on its long side
    // (in-process, no extra sips runs) and its final pixel size is returned as "pixels".
    // capture <out> <target> [max] [thumb thumbMax]: thumb is a second, smaller copy for the Sidekick to show.
    guard args.count >= 3 else { fail("usage: capture <out> <target> [max] [thumb thumbMax]") }
    let file = args[1], target = args[2], maxPx = args.count >= 4 ? Int(args[3]) : nil
    let thumb = args.count >= 5 ? args[4] : nil, thumbMax = args.count >= 6 ? Int(args[5]) ?? 900 : 900
    func makeThumb() {
        guard let thumb, let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil) else { return }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: thumbMax, kCGImageSourceCreateThumbnailWithTransform: true]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary),
              let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: thumb) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
        _ = CGImageDestinationFinalize(dst)
    }
    func shrink() -> [Int]? {
        guard let maxPx, let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let pw = props[kCGImagePropertyPixelWidth] as? Int, let ph = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        if max(pw, ph) <= maxPx { return [pw, ph] }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxPx, kCGImageSourceCreateThumbnailWithTransform: true]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary),
              let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: file) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        return CGImageDestinationFinalize(dst) ? [img.width, img.height] : nil
    }
    if target == "screen" {
        // The main display without Roamies on it (shared/shot.swift); older macOS: screencapture, Roamies and all.
        let px = Shot.capture(nil, to: file, png: false, maxPx: maxPx)
        if px == nil { guard run("/usr/sbin/screencapture", ["-x", "-t", "jpg", file]) == 0 else { fail("Screen capture failed. Roamies may need Screen Recording permission.") } }
        // Its bounds (points) let the caller map pixels back.
        let d = CGDisplayBounds(CGMainDisplayID())
        var o: [String: Any] = ["ok": true, "file": file, "what": "screen", "bounds": [Int(d.minX), Int(d.minY), Int(d.width), Int(d.height)]]
        if let px = px ?? shrink() { o["pixels"] = px }
        makeThumb()
        out(o)
    }
    guard let w = resolve(target) else { fail("No matching window is open\(target.hasPrefix("app:") ? " for \(target.dropFirst(4))" : "").") }
    guard run("/usr/sbin/screencapture", ["-x", "-o", "-t", "jpg", "-l", String(w.id), file]) == 0 else { fail("Window capture failed. Roamies may need Screen Recording permission.") }
    var o: [String: Any] = ["ok": true, "file": file, "window": winInfo(w)]
    if let px = shrink() { o["pixels"] = px }
    makeThumb()
    out(o)

case "select":
    guard args.count >= 2 else { fail("usage: select <out>") }
    // macOS's own crosshair: drag an area, or press Space to pick a window. Esc cancels (no file).
    _ = run("/usr/sbin/screencapture", ["-i", "-s", "-x", "-t", "png", args[1]])
    let ok = FileManager.default.fileExists(atPath: args[1])
    out(ok ? ["ok": true, "file": args[1]] : ["ok": false, "cancelled": true])

case "ui":
    guard AXIsProcessTrusted() else { fail("Roamies needs Accessibility permission to read other apps.") }
    guard args.count >= 2, let w = resolve(args[1]) else { fail("No matching window is open.") }
    let uiApp = axApp(w)
    let items = walk(uiApp, w).map { $0.1 }
    // ui <target> controls: just the controls (to re-find ids before acting), without the page's text.
    if args.count >= 3, args[2] == "controls" { out(["ok": true, "window": winInfo(w), "controls": items]) }
    let scan = scanText(uiApp, w)
    out(["ok": true, "window": winInfo(w), "controls": items, "texts": pageText(uiApp, w, cap: 5000, scan: scan), "elsewhere": offscreenText(uiApp, w, cap: 4000, scan: scan), "note": items.isEmpty ? "This app shares no controls. Use a screenshot plus click at coordinates instead." : ""])

case "locate-control":
    guard AXIsProcessTrusted() else { fail("Roamies needs Accessibility permission to read other apps.") }
    guard args.count >= 3, let w = resolve(args[1]), let id = Int(args[2]) else { fail("usage: locate-control <target> <id>") }
    let items = walk(axApp(w), w)
    guard id >= 1, id <= items.count else { fail("No control \(id) in \(w.app). Read the window again.") }
    out(["ok": true, "window": winInfo(w), "control": items[id - 1].1])

case "find-text":
    // Looks through every window of the app ("app:X"), or every window on screen ("screen"), front to back,
    // because the text is often in a window that isn't the frontmost one.
    guard AXIsProcessTrusted() else { fail("Roamies needs Accessibility permission to read other apps.") }
    guard args.count >= 3 else { fail("usage: find-text <target> <text>") }
    let t = args[1]
    var wins: [Win]
    if t == "screen" { wins = windows().filter { !isRoamies($0.pid) } }
    else if t == "front", let f = resolve("front") { wins = windows().filter { $0.pid == f.pid } }
    else if t.hasPrefix("app:") { let name = String(t.dropFirst(4)); wins = windows().filter { appMatches($0.app, name) } }
    else if let w = resolve(t) { wins = [w] } else { wins = [] }
    if wins.isEmpty { fail("No matching window is open.") }
    var all: [[String: Any]] = []
    func search() {
        all = []
        for (z, w) in wins.prefix(12).enumerated() {
            for (i, m) in findText(axApp(w), w, args[2]).enumerated() {
                var m = m; m["window"] = winInfo(w); m["rank"] = z * 100 + i; all.append(m)
            }
        }
    }
    search()
    // "scroll": nothing whole on screen, so bring it into view in the frontmost window that has it, then look again.
    if args.count >= 4, args[3] == "scroll", !all.contains(where: { wholeMatch($0, args[2]) }),
       wins.prefix(12).contains(where: { scrollToText(axApp($0), $0, args[2]) }) { search() }
    // Exact text in any window beats a partial match in the front one.
    let exact = all.filter { (($0["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == args[2].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    let ordered = (exact + all.filter { m in !exact.contains { ($0["rank"] as? Int) == (m["rank"] as? Int) } }).prefix(8)
    out(["ok": true, "matches": Array(ordered)])

case "act":
    guard AXIsProcessTrusted() else { fail("Roamies needs Accessibility permission to control other apps.") }
    guard args.count >= 2, let data = args[1].data(using: .utf8),
          let plan = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let steps = plan["steps"] as? [[String: Any]] else { fail("bad plan") }
    let target = (plan["window"] as? Int).map { "window:\($0)" } ?? (plan["app"] as? String).map { "app:\($0)" } ?? "front"
    guard let w = resolve(target) else { fail("No matching window is open.") }
    if let name = handsOff(w.pid) {
        fail("Blocked for safety: I can point at things in \(name), but I never type or click in it. Show the user where to click instead.")
    }
    // Bring the target app forward so keystrokes land there, not in Roamies (in background mode it stays behind).
    let app = axApp(w)
    bgWin = w; bgApp = app; bgPid = w.pid
    // Keys and clicks go to whichever app is in front, so the target must really be there first.
    // activate() alone is only a request since macOS 14 and is often ignored for a background helper.
    if !bringToFront(w, app) {
        out(["ok": false, "error": "Couldn't bring \(w.app) to the front, so nothing was typed or clicked. Ask the user to click its window once, then try again.", "done": []])
    }
    // With several windows of one app, keystrokes go to its main window: make that the one we read.
    if let axw = axWindow(app, w), (attr(axw, kAXMainAttribute) as? Bool) != true {
        if !BG { AXUIElementPerformAction(axw, kAXRaiseAction as CFString) }
        AXUIElementSetAttributeValue(axw, kAXMainAttribute as CFString, kCFBooleanTrue)
        Thread.sleep(forTimeInterval: 0.15)
    }
    var controls = walk(app, w)
    var done: [String] = []
    progress(["ev": "start", "window": winInfo(w), "steps": steps.count])
    // What a step is about to touch (global points) and what it types. Password fields only send dots.
    func emitStep(_ i: Int, _ what: String, _ e: AXUIElement?, at: CGPoint? = nil, label: String = "", text: String? = nil) {
        var d: [String: Any] = ["ev": "step", "i": i, "do": what, "label": String(label.prefix(60))]
        if let e, let f = frame(e) { d["bounds"] = [Int(f.minX), Int(f.minY), Int(f.width), Int(f.height)] }
        else if let p = at { d["bounds"] = [Int(p.x) - 6, Int(p.y) - 6, 12, 12] }
        if let t = text {
            let secure = e.map { axRole($0) == "AXSecureTextField" || str($0, kAXSubroleAttribute) == "AXSecureTextField" } ?? false
            d["text"] = secure ? String(repeating: "•", count: min(t.count, 24)) : String(t.prefix(80))
            if secure { d["secure"] = true }
        }
        progress(d)
    }
    func el(_ s: [String: Any]) -> (AXUIElement, [String: Any])? {
        guard let id = s["id"] as? Int, id >= 1, id <= controls.count else { return nil }
        return controls[id - 1]
    }
    // A wait at the very end, after a click or key ("click Sign in, wait 2"), is there for the page to react. It ends
    // as soon as the page has changed from how it was before that action and has held still; if nothing changes it
    // waits the full time, as before.
    func pageSig() -> String {
        let cur = resolve(target) ?? w
        return "\(cur.id)|\(cur.title)#" + walk(cur.pid == w.pid ? app : axApp(cur), cur).map { "\($0.1["role"] ?? "")|\($0.1["label"] ?? "")" }.joined(separator: ";")
    }
    let reacts: Set<String> = ["click", "click_text", "press_button", "key", "click_at", "choose"]
    let tailWait = steps.count >= 2 && (steps.last?["do"] as? String) == "wait" && reacts.contains(steps[steps.count - 2]["do"] as? String ?? "")
    var sigBefore: String?
    for (i, s) in steps.enumerated() {
        let what = s["do"] as? String ?? ""
        usedRealCursor = false
        userBusy = false
        defer { if usedRealCursor, !done.isEmpty { done[done.count - 1] += " (needed the real cursor)" } }
        defer {
            if userBusy {
                out(["ok": false, "error": "Step \(i + 1) needs the real mouse, but the user was typing or using the mouse, so I didn't take over (their keys would have gone into \(w.app)). Nothing after it ran. Tell them, and offer to finish when they're free.", "done": done])
            }
        }
        if tailWait, i == steps.count - 2 { sigBefore = pageSig() }
        // An earlier step may have switched apps (a click, cmd+tab, Spotlight); check before every action.
        if what != "wait", let front = NSWorkspace.shared.frontmostApplication, let name = handsOff(front.processIdentifier) {
            out(["ok": false, "error": "Blocked for safety: \(name) came to the front, and I never type or click in it.", "done": done])
        }
        // Raw keys and typing land in the front app: if another app took over, stop instead of typing into it.
        if ["key", "type", "click_at"].contains(what), frontPid() != w.pid, !bringToFront(w, app) {
            let other = NSWorkspace.shared.frontmostApplication?.localizedName ?? "another app"
            out(["ok": false, "error": "Step \(i + 1): \(other) is in front instead of \(w.app), so I stopped before typing into the wrong app.", "done": done])
        }
        if what == "click_at", let x = s["x"] as? Double, let y = s["y"] as? Double {
            let gx = (s["global"] as? Bool ?? false) ? x : w.x + x, gy = (s["global"] as? Bool ?? false) ? y : w.y + y
            if let under = windows().first(where: { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h).contains(CGPoint(x: gx, y: gy)) }), let name = handsOff(under.pid) {
                out(["ok": false, "error": "Blocked for safety: that spot is on \(name), and I never click in it.", "done": done])
            }
        }
        switch what {
        case "focus", "click", "set", "press_button":
            guard let (e, info) = el(s) else { out(["ok": false, "error": "Step \(i + 1): no control with id \(s["id"] ?? "?"). Call read_window again.", "done": done]) }
            emitStep(i, what, e, label: (info["label"] as? String) ?? "", text: what == "set" ? s["text"] as? String : nil)
            if (what == "click" || what == "press_button"), risky((info["label"] as? String) ?? ""), (s["confirmed"] as? Bool) != true {
                out(["ok": false, "error": "Stopped before clicking \"\(info["label"] ?? "")\": it could delete, pay, send or sign out, and the user hasn't said yes to that. Tell them, and let them click it themselves.", "done": done])
            }
            if what == "set", let text = s["text"] as? String {
                // Native fields take the value directly; web page fields need real keystrokes or the page never sees it.
                if !typeInto(app, e, text).ok {
                    out(["ok": false, "error": "Step \(i + 1): couldn't put the cursor in \"\(info["label"] ?? "that field")\", so nothing was typed.", "done": done])
                }
                done.append("set \(info["label"] ?? "field \(info["id"]!)")")
            } else if what == "focus" {
                AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                if let f = frame(e) { click(CGPoint(x: f.midX, y: f.midY)) }
                done.append("focused \(info["label"] ?? "field")")
            } else if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(str(e, kAXRoleAttribute) ?? "") {
                // "Pressing" a text box doesn't put the cursor in it; focus and click so typing lands there.
                AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                if let f = frame(e) { click(CGPoint(x: f.midX, y: f.midY)) }
                done.append("clicked \(info["label"] ?? "field")")
            } else {
                if AXUIElementPerformAction(e, kAXPressAction as CFString) != .success, let f = frame(e) { click(CGPoint(x: f.midX, y: f.midY)) }
                done.append("clicked \(info["label"] ?? "control")")
            }
            Thread.sleep(forTimeInterval: 0.15)
            if what == "click" || what == "press_button" { controls = walk(app, w) }
        case "click_text":
            // Click by the words on screen: no read_window needed first. Exact text wins over partial.
            // A whole label or heading, not words buried in a paragraph.
            let q = s["text"] as? String ?? ""
            var hit: (AXUIElement, [String: Any])?
            // A checkbox or radio by its label: press the control itself; clicking the words doesn't always tick it.
            // Browser tabs are radio buttons too (a tab titled "Sign in"), so a box inside the web page comes first, and
            // one outside it only when the words aren't found in the page.
            let boxes = controls.filter { ["AXCheckBox", "AXRadioButton"].contains(axRole($0.0)) && fold(($0.1["label"] as? String) ?? "") == fold(q) && ($0.1["offscreen"] as? Bool) != true }
            if let box = boxes.first(where: { inWebPage($0.0) }) {
                hit = (box.0, ["text": box.1["label"] ?? q])
            } else if let near = s["near"] as? String, !near.isEmpty {
                // Many matches (a "Reply" under every post): the one that goes with the near text.
                guard let a = anchorFrame(app, w, near) else {
                    out(["ok": false, "error": "Step \(i + 1): no text \"\(near)\" on this page to find \"\(q)\" near.", "done": done])
                }
                let all = findTextEls(app, w, q, hidden: true, limit: 200).filter { wholeMatch($0.1, q) }
                let best = all.first?.1["match"] as? String
                hit = nearestAfter(a, all.filter { ($0.1["match"] as? String) == best })
                if let (e, _) = hit, let f = frame(e), !CGRect(x: w.x, y: w.y, width: w.w, height: w.h).contains(CGPoint(x: f.midX, y: f.midY)) {
                    AXUIElementPerformAction(e, "AXScrollToVisible" as CFString); Thread.sleep(forTimeInterval: 0.3)
                }
            } else {
                hit = findTextEls(app, w, q).first(where: { wholeMatch($0.1, q) })
                if let box = boxes.first, hit == nil || !inWebPage(hit!.0) { hit = (box.0, ["text": box.1["label"] ?? q]) }
                if hit == nil, !q.isEmpty, scrollToText(app, w, q) { hit = findTextEls(app, w, q).first(where: { wholeMatch($0.1, q) }) }
            }
            guard !q.isEmpty, let (e, info) = hit else {
                out(["ok": false, "error": "Step \(i + 1): no visible text \"\(s["text"] ?? "")\" in \(w.app). Check the exact words with a screenshot or read_window.", "done": done])
            }
            if risky((info["text"] as? String) ?? q), (s["confirmed"] as? Bool) != true {
                out(["ok": false, "error": "Stopped before clicking \"\(info["text"] ?? q)\": it could delete, pay, send or sign out, and the user hasn't said yes to that. Tell them, and let them click it themselves.", "done": done])
            }
            emitStep(i, "click_text", e, label: (info["text"] as? String) ?? q)
            if !pressText(e) {
                guard let f = frame(e) else { out(["ok": false, "error": "Step \(i + 1): couldn't click \"\(q)\".", "done": done]) }
                let p = CGPoint(x: f.midX, y: f.midY)
                if let under = windows().first(where: { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h).contains(p) }), let name = handsOff(under.pid) {
                    out(["ok": false, "error": "Blocked for safety: that spot is on \(name), and I never click in it.", "done": done])
                }
                click(p)
            }
            done.append("clicked \"\(info["text"] ?? q)\"")
            Thread.sleep(forTimeInterval: 0.15)
            controls = walk(app, w)
        case "type":
            // Typing outside a text field fires page shortcuts (YouTube's k pauses, Cmd-less digits switch views).
            guard isEditable(focusedEl(app)) else {
                out(["ok": false, "error": "Step \(i + 1): the cursor isn't in a text field, so typing would go nowhere. Use {do:'fill', field, text} to fill a field by its label.", "done": done])
            }
            emitStep(i, "type", focusedEl(app), text: s["text"] as? String ?? "")
            typeText(s["text"] as? String ?? ""); done.append("typed text")
        case "fill":
            // A form field by its label, placeholder or id: put the cursor in it, replace its text, check it took.
            let text = s["text"] as? String ?? ""
            var s = s
            if s["id"] == nil, let n = Int((s["field"] as? String ?? "").trimmingCharacters(in: .whitespaces)) { s["id"] = n }
            let name = (s["field"] as? String) ?? ""
            if el(s) == nil, fieldFor(app, w, controls, name, roles: FIELD_ROLES) == nil { Thread.sleep(forTimeInterval: 0.3); controls = walk(app, w) }
            // Same field under every post ("Write a reply…"): the one that goes with the near text.
            var nearField: (AXUIElement, [String: Any])?
            if let near = s["near"] as? String, !near.isEmpty {
                guard let a = anchorFrame(app, w, near) else {
                    out(["ok": false, "error": "Step \(i + 1): no text \"\(near)\" on this page to find the field near.", "done": done])
                }
                let q = fold(name)
                let fields = walk(app, w, limit: 400).filter { c in FIELD_ROLES.contains(axRole(c.0)) && (q.isEmpty || [(c.1["label"] as? String) ?? "", str(c.0, "AXPlaceholderValue") ?? ""].map(fold).contains { $0.contains(q) }) }
                nearField = nearestAfter(a, fields)
            }
            guard let (e, info) = nearField ?? el(s) ?? fieldFor(app, w, controls, name, roles: FIELD_ROLES) else {
                out(["ok": false, "error": "Step \(i + 1): no text field called \"\(name)\" here. Check its label with read_window.", "done": done])
            }
            let label = (info["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name
            emitStep(i, "fill", e, label: label, text: text)
            let isDate = ["AXDateField", "AXTimeField", "AXDateTimeArea"].contains(axRole(e))
            func took(_ r: (ok: Bool, shows: String)) -> Bool {
                guard r.ok else { return false }
                let sh = r.shows.trimmingCharacters(in: .whitespacesAndNewlines)
                if axRole(e) == "AXSecureTextField" || str(e, kAXSubroleAttribute) == "AXSecureTextField" { return sh.isEmpty || sh.count == text.count }
                if ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(axRole(e)) { return (sh.isEmpty && text.isEmpty) || fold(sh).contains(fold(text).prefix(40)) }
                return true
            }
            let busy = (ok: false, shows: "")
            var r = inBackground && isDate ? withRealCursor { typeInto(app, e, text) } ?? busy : typeInto(app, e, text)
            if inBackground, !userBusy, !took(r) { r = withRealCursor { typeInto(app, e, text) } ?? busy }
            if userBusy { break }
            if !r.ok { out(["ok": false, "error": "Step \(i + 1): couldn't put the cursor in \"\(label)\", so nothing was typed.", "done": done]) }
            let shows = r.shows.trimmingCharacters(in: .whitespacesAndNewlines)
            // Password fields show dots: the right number of them is a match. (They're secure fields, so the check
            // below never runs on them; this note is why.)
            let secure = axRole(e) == "AXSecureTextField" || str(e, kAXSubroleAttribute) == "AXSecureTextField"
            if secure, shows.count != text.count, !shows.isEmpty {
                out(["ok": false, "error": "Step \(i + 1): the password field shows \(shows.count) characters, not \(text.count). Fill it again.", "done": done])
            }
            let plain = !secure && ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(axRole(e))
            if plain, !shows.isEmpty || !text.isEmpty, !fold(shows).contains(fold(text).prefix(40)) {
                var settable: DarwinBoolean = true
                AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable)
                if shows.isEmpty, !settable.boolValue || ((attr(e, "AXReadOnly") as? Bool) == true) {
                    out(["ok": false, "error": "Step \(i + 1): \"\(label)\" can't be typed in; it opens a picker. Use click_text on it, then on the month arrows (e.g. 'Next Month') and the day (its label reads like 'Choose Monday, November 16th, 2026').", "done": done])
                }
                out(["ok": false, "error": "Step \(i + 1): typed into \"\(label)\" but it shows \"\(shows.prefix(80))\". If a cookie banner or pop-up covers the page, close it first (click_text its button), then fill again; otherwise check the field with read_window.", "done": done])
            }
            done.append("\(label) = \"\(axRole(e) == "AXSecureTextField" ? "••••" : String(shows.prefix(60)))\"")
            controls = walk(app, w)
        case "choose":
            // A dropdown (native, custom or a picker) by label or id: open it, find the option (scrolling the
            // list if needed) and pick it. Falls back to typing the option and Return, which most dropdowns accept.
            let option = s["option"] as? String ?? s["text"] as? String ?? ""
            var s = s
            if s["id"] == nil, let n = Int((s["field"] as? String ?? "").trimmingCharacters(in: .whitespaces)) { s["id"] = n }
            let name = (s["field"] as? String) ?? ""
            // No usable name and the page has exactly one dropdown in view: that's the one.
            let pageDrops = controls.filter { ["AXPopUpButton", "AXComboBox"].contains(axRole($0.0)) && ($0.1["offscreen"] as? Bool) != true && inWebPage($0.0) }
            let only = pageDrops.count == 1 ? pageDrops.first : nil
            guard !option.isEmpty, let (e, info) = el(s) ?? fieldFor(app, w, controls, name, roles: DROP_ROLES) ?? only else {
                out(["ok": false, "error": "Step \(i + 1): no dropdown called \"\(name)\" here, or no option given. Check with read_window.", "done": done])
            }
            let label = (info["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name
            emitStep(i, "choose", e, label: label, text: option)
            if risky(option), (s["confirmed"] as? Bool) != true {
                out(["ok": false, "error": "Stopped before choosing \"\(option)\": it could delete, pay, send or sign out, and the user hasn't said yes to that.", "done": done])
            }
            activate(e)
            Thread.sleep(forTimeInterval: 0.35)
            let typeable = ["AXComboBox", "AXTextField", "AXSearchField"].contains(axRole(e))
            if let o = findOption(app, w, option, excluding: e) {
                activate(o)
            } else if typeable, typeInto(app, e, option).ok, { Thread.sleep(forTimeInterval: 0.5); return true }(),
                      let o = findOption(app, w, option, excluding: e) {
                // Type-to-search: the suggestions appear once there's text in the box.
                activate(o)
            } else if !typeable, let f = frame(e), let list = openList(app, w, near: f), let o = scrollListFor(app, w, list, option) {
                activate(o)
            } else if typeable {
                _ = pressKey("return")
            } else {
                // Typing only goes where focus is a field or the dropdown itself.
                if isEditable(focusedEl(app)) || (focusedEl(app).map { CFEqual($0, e) } ?? false) || axRole(e) == "AXPopUpButton" {
                    typeText(option); Thread.sleep(forTimeInterval: 0.35); _ = pressKey("return")
                } else {
                    _ = pressKey("escape")
                    out(["ok": false, "error": "Step \(i + 1): opened \"\(label)\" but no option \"\(option)\" showed up. Take a screenshot to see the choices.", "done": done])
                }
            }
            Thread.sleep(forTimeInterval: 0.45)
            let shows = [str(e, kAXValueAttribute), str(e, kAXTitleAttribute)].compactMap { $0 }.first { !$0.isEmpty } ?? ""
            let took = shows.isEmpty || fold(shows).contains(fold(option).prefix(40))
            done.append(took ? "chose \"\(option)\" in \(label)\(shows.isEmpty ? "" : " (shows \"\(shows.prefix(60))\")")" : "tried to choose \"\(option)\" in \(label), but it still shows \"\(shows.prefix(60))\"")
            controls = walk(app, w)
        case "scroll":
            // Scroll the page, or a list/dropdown/panel under a control or text: direction up/down/left/right, amount in steps.
            let dir = (s["direction"] as? String ?? "down").lowercased()
            let n = max(1, min(30, (s["amount"] as? Int) ?? 5))
            var p = CGPoint(x: w.x + w.w / 2, y: w.y + w.h / 2)
            let winRect = CGRect(x: w.x, y: w.y, width: w.w, height: w.h).insetBy(dx: 4, dy: 4)
            let inWin = { (f: CGRect) -> CGPoint? in let c = CGPoint(x: f.midX, y: f.midY); return winRect.contains(c) ? c : nil }
            if let (e, _) = el(s), let f = frame(e), let c = inWin(f) { p = c }
            else if let q = s["text"] as? String, let c = findTextEls(app, w, q).compactMap({ frame($0.0).flatMap(inWin) }).first { p = c }
            let (dy, dx): (Int32, Int32) = dir == "up" ? (3, 0) : dir == "left" ? (0, 3) : dir == "right" ? (0, -3) : (-3, 0)
            emitStep(i, "scroll", nil, at: p, label: (s["to_end"] as? Bool) == true ? "\(dir) to the end" : dir)
            if (s["to_end"] as? Bool) == true, dir == "up" || dir == "down" {
                // To the very end (or top): keep scrolling, giving a feed time to load more, until nothing changes.
                let sign: Int32 = dir == "up" ? 1 : -1, deadline = Date().addingTimeInterval(25)
                var last = "", same = 0, rounds = 0
                // In the background, one quiet try first; if the page didn't move, the rest uses the real cursor.
                if inBackground {
                    let before = pageText(app, w, cap: 4000).joined(separator: "|")
                    for _ in 0..<4 { moveTo(p); if let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: sign * 1500, wheel2: 0, wheel3: 0) { e.flags = []; sendScroll(e) }; Thread.sleep(forTimeInterval: 0.05) }
                    Thread.sleep(forTimeInterval: 0.5)
                    last = pageText(app, w, cap: 4000).joined(separator: "|")
                    if last == before { usedRealCursor = true; fgActive = false }
                }
                var borrow = BG && usedRealCursor && !fgActive
                var saved: (CGPoint?, NSRunningApplication?) = (nil, nil)
                if borrow { if let sv = borrowBegin() { saved = sv; fgActive = true; _ = bringToFront(w, app) } else { borrow = false; userBusy = true; usedRealCursor = false } }
                defer { if borrow { fgActive = false; borrowEnd(saved, w) } }
                while Date() < deadline, same < 2 {
                    for _ in 0..<4 {
                        moveTo(p)
                        if let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: sign * 1500, wheel2: 0, wheel3: 0) { e.flags = []; sendScroll(e) }
                        Thread.sleep(forTimeInterval: 0.05)
                    }
                    Thread.sleep(forTimeInterval: 0.9)
                    let sig = pageText(app, w, cap: 4000).joined(separator: "|")
                    if sig == last { same += 1 } else { same = 0; rounds += 1 }
                    last = sig
                }
                done.append("scrolled to the \(dir == "up" ? "top" : "end")\(rounds > 2 ? " (more loaded \(rounds - 1) times)" : "")")
                controls = walk(app, w)
                continue
            }
            let before = inBackground ? pageText(app, w, cap: 4000).joined(separator: "|") : ""
            for _ in 0..<n { scrollAt(p, dy: dy, dx: dx); Thread.sleep(forTimeInterval: 0.04) }
            Thread.sleep(forTimeInterval: 0.25)
            // Nothing moved in the background: scroll again with the real cursor.
            if inBackground, pageText(app, w, cap: 4000).joined(separator: "|") == before {
                withRealCursor { for _ in 0..<n { scrollAt(p, dy: dy, dx: dx); Thread.sleep(forTimeInterval: 0.04) }; Thread.sleep(forTimeInterval: 0.25) }
            }
            done.append("scrolled \(dir)")
            controls = walk(app, w)
        case "key":
            emitStep(i, "key", nil, label: s["key"] as? String ?? "")
            let combo = (s["key"] as? String ?? "").lowercased().replacingOccurrences(of: " ", with: "")
            // Cmd+S in the background: its menu item is greyed out while the app is behind, so ask the app to save
            // its front document directly (no dialog for one that already has a file; a new one still needs the cursor).
            if inBackground, ["cmd+s", "command+s"].contains(combo), saveInBackground(w) { done.append("pressed \(s["key"]!) (saved)"); break }
            if inBackground, ["cmd+s", "command+s"].contains(combo) { _ = withRealCursor { pressKey(combo) }; done.append("pressed \(s["key"]!)"); break }
            if inBackground, pressMenuShortcut(app, s["key"] as? String ?? "") { done.append("pressed \(s["key"]!)"); break }
            guard pressKey(s["key"] as? String ?? "") else { out(["ok": false, "error": "Step \(i + 1): unknown key \(s["key"] ?? "")", "done": done]) }
            done.append("pressed \(s["key"]!)")
        case "click_at":
            // Points relative to the window's top-left, or global screen points when "global" is set.
            guard let x = s["x"] as? Double, let y = s["y"] as? Double else { out(["ok": false, "error": "Step \(i + 1): click_at needs x and y", "done": done]) }
            let global = s["global"] as? Bool ?? false
            emitStep(i, "click_at", nil, at: global ? CGPoint(x: x, y: y) : CGPoint(x: w.x + x, y: w.y + y))
            click(global ? CGPoint(x: x, y: y) : CGPoint(x: w.x + x, y: w.y + y)); done.append("clicked at \(Int(x)),\(Int(y))")
        case "wait":
            let secs = min(5, (s["seconds"] as? Double) ?? 0.5)
            if let before = sigBefore, i == steps.count - 1 {
                let end = Date().addingTimeInterval(secs)
                var last = "", same = 0
                while Date() < end {
                    let now = pageSig()
                    if now != before { same = now == last ? same + 1 : 0; if same >= 2 { break } }
                    last = now
                    Thread.sleep(forTimeInterval: 0.15)
                }
            } else {
                Thread.sleep(forTimeInterval: secs)
            }
            done.append("waited")
        default:
            out(["ok": false, "error": "Step \(i + 1): unknown action \(what)", "done": done])
        }
    }
    // A click or key may have changed the page: hand back what's there now, so no read_window round trip is needed.
    let changing = steps.contains { ["click", "click_text", "press_button", "key", "click_at", "fill", "choose", "scroll", "set"].contains($0["do"] as? String ?? "") }
    if changing {
        let w2 = resolve(target) ?? w
        let app2 = w2.pid == w.pid ? app : axApp(w2)
        let now = settle(app2, w2).map { $0.1 }
        out(["ok": true, "done": done, "window": winInfo(w2), "controls": now, "texts": pageText(app2, w2, cap: 2000)])
    }
    out(["ok": true, "done": done, "window": winInfo(w)])

case "image":
    imageVerb(args)

case "guide":
    runGuide(Array(args.dropFirst()))

case "secret-get":
    var q = secretQuery(secretName(1))
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &item)
    if st == errSecItemNotFound { out(["ok": true, "found": false]) }
    guard st == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else { fail("keychain read failed (\(st))") }
    out(["ok": true, "found": true, "value": value])

case "secret-set":
    let name = secretName(1)
    let raw = FileHandle.standardInput.readDataToEndOfFile()
    guard let text = String(data: raw, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty, text.utf8.count <= 4096 else { fail("no secret on stdin") }
    let data = Data(text.utf8)
    var st = SecItemUpdate(secretQuery(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if st == errSecItemNotFound {
        var add = secretQuery(name)
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "Roamies (\(name))"
        st = SecItemAdd(add as CFDictionary, nil)
    }
    guard st == errSecSuccess else { fail("keychain save failed (\(st))") }
    out(["ok": true])

case "secret-delete":
    let st = SecItemDelete(secretQuery(secretName(1)) as CFDictionary)
    guard st == errSecSuccess || st == errSecItemNotFound else { fail("keychain delete failed (\(st))") }
    out(["ok": true])

case "screencheck":
    // Screen Recording can read as allowed and still not work (say, before a relaunch), so take one real screenshot.
    guard CGPreflightScreenCaptureAccess() else { out(["ok": true, "seen": false]) }
    let file = NSTemporaryDirectory() + "roamies-screencheck-\(me).jpg"
    let code = run("/usr/sbin/screencapture", ["-x", "-t", "jpg", file])
    let size = ((try? FileManager.default.attributesOfItem(atPath: file))?[.size] as? Int) ?? 0
    try? FileManager.default.removeItem(atPath: file)
    out(["ok": true, "seen": code == 0 && size > 0])

default:
    fail("unknown command \(cmd)")
}
