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
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

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
        let role = str(el, kAXRoleAttribute) ?? ""
        if INTERACTIVE.contains(role), let f = frame(el), f.width > 1, f.height > 1 {
            if (attr(el, kAXEnabledAttribute) as? Bool) != false {
                var label = str(el, kAXTitleAttribute) ?? str(el, kAXDescriptionAttribute) ?? str(el, "AXPlaceholderValue") ?? str(el, kAXHelpAttribute) ?? ""
                if label.isEmpty, let t = attr(el, kAXTitleUIElementAttribute) { label = str(t as! AXUIElement, kAXValueAttribute) ?? "" }
                if label.isEmpty, FIELD_ROLES.contains(role) { label = nearbyLabel(el) ?? "" }
                // A placeholder alone hides the real label ("e.g. Jane Doe" is the Full Name field): add the label too.
                if FIELD_ROLES.contains(role), str(el, kAXTitleAttribute) == nil, let ph = str(el, "AXPlaceholderValue"), label == ph, let near = nearbyLabel(el), near != ph { label = "\(near) (\(ph))" }
                var item: [String: Any] = ["role": ROLE_NAME[role] ?? role, "label": String(label.prefix(80)),
                                           "bounds": [Int(f.minX), Int(f.minY), Int(f.width), Int(f.height)]]
                if role != "AXSecureTextField", let v = str(el, kAXValueAttribute), !v.isEmpty { item["value"] = String(v.prefix(80)) }
                if (attr(el, kAXFocusedAttribute) as? Bool) == true { item["focused"] = true }
                // Mostly on screen counts as visible; a sliver at the edge doesn't.
                let seen = view.intersection(f)
                if !seen.isNull, seen.width * seen.height >= f.width * f.height * 0.5 { found.append((el, item)) }
                else if hidden.count < 40 { item["offscreen"] = true; hidden.append((el, item)) }
            }
        }
        if depth < 40, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
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
        let texts = [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue"].compactMap { str(el, $0) }
        if let t = texts.first(where: { $0.lowercased().contains(q) }), let f = frame(el), f.width > 1, f.height > 1, hidden || win.intersects(f) {
            let low = t.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let score = low == q ? 0 : low.range(of: "\\b\(NSRegularExpression.escapedPattern(for: q))\\b", options: .regularExpression) != nil ? 1 : 2
            let role = str(el, kAXRoleAttribute) ?? ""
            hits.append((score, inWebPage(el), f.width * f.height, el, ["text": String(t.prefix(80)), "match": ["exact", "word", "partial"][score], "role": ROLE_NAME[role] ?? role.replacingOccurrences(of: "AX", with: "").lowercased(),
                                                     "bounds": [Int(f.minX), Int(f.minY), Int(f.width), Int(f.height)]]))
        }
        if depth < 60, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
            for k in kids.reversed() { stack.append((k, depth + 1)) }
        }
    }
    // Words on the page beat the same words in the browser's own tabs and toolbar (a tab titled "Sign in").
    return hits.sorted { $0.score != $1.score ? $0.score < $1.score : $0.web != $1.web ? $0.web : $0.area < $1.area }.prefix(limit).map { ($0.el, $0.item) }
}

/// Activates what a piece of text belongs to: focuses a text field, else presses the element or the nearest
/// ancestor that can be pressed (a link around its text, a button around its label). Returns false if nothing could.
func pressText(_ e: AXUIElement) -> Bool {
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
                d.post(tap: .cghidEventTap); u.post(tap: .cghidEventTap)
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
        let role = axRole(el)
        if role == "AXMenuBar" { continue }
        // The dropdown's own text (a search box shows what was typed) isn't an option.
        if let x = excluding, CFEqual(el, x) { continue }
        if ["AXMenuItem", "AXStaticText", "AXCell", "AXRow", "AXButton", "AXRadioButton", "AXLink", "AXGroup", "AXListItem", "AXOption"].contains(role) {
            for t in [str(el, kAXTitleAttribute), str(el, kAXValueAttribute), str(el, kAXDescriptionAttribute)].compactMap({ $0 }).map(fold) where !t.isEmpty {
                if t == q { exact = el; break }
                if prefix == nil, t.hasPrefix(q), t.count <= q.count + 25 { prefix = el }
            }
        }
        if depth < 60, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { for k in kids.reversed() { stack.append((k, depth + 1)) } }
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
        if ["AXList", "AXMenu", "AXTable", "AXOutline", "AXListBox"].contains(axRole(el)), let f = frame(el), f.intersects(win), f.height > 20 {
            let d = abs(f.minY - near.maxY) + abs(f.minX - near.minX) * 0.5
            if best == nil || d < best!.0 { best = (d, el) }
        }
        if depth < 60, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { for k in kids.reversed() { stack.append((k, depth + 1)) } }
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
        let t = optionText(el)
        if t.contains(q) { return el }
        if prefix == nil, t.contains(where: { $0.hasPrefix(q) && $0.count <= q.count + 25 }) { prefix = el }
        if d < 8, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { for k in kids.reversed() { stack.append((k, d + 1)) } }
    }
    return prefix
}
/// Scrolls an open list a screenful at a time, down to its end and then back up, until the option shows up.
/// Works for long lists and virtualized ones, where rows out of view don't exist until scrolled to.
func scrollListFor(_ app: AXUIElement, _ w: Win, _ list: AXUIElement, _ option: String) -> AXUIElement? {
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
            CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: box.midX, y: box.midY), mouseButton: .left)?.post(tap: .cghidEventTap)
            if let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: dir * px, wheel2: 0, wheel3: 0) { e.flags = []; e.post(tap: .cghidEventTap) }
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
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.03)
    if let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) { e.flags = []; e.post(tap: .cghidEventTap) }
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
func offscreenText(_ app: AXUIElement, _ w: Win, cap: Int) -> [String] {
    guard let root = axWindow(app, w) else { return [] }
    let win = CGRect(x: w.x, y: w.y, width: w.w, height: w.h)
    var found: [(CGFloat, String)] = [], seen = Set<String>(), visited = 0
    var stack: [(AXUIElement, Int)] = [(root, 0)]
    while let (el, depth) = stack.popLast(), visited < 12000 {
        visited += 1
        let role = str(el, kAXRoleAttribute) ?? ""
        if role == "AXStaticText" || role == "AXHeading", let t = str(el, kAXValueAttribute) ?? str(el, kAXTitleAttribute), let f = frame(el), f.height > 1, !win.intersects(f) {
            let line = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            if line.count >= 2, seen.insert(line).inserted { found.append((f.minY, String(line.prefix(160)))) }
        }
        if depth < 60, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { for k in kids.reversed() { stack.append((k, depth + 1)) } }
    }
    let lines = found.sorted { $0.0 < $1.0 }.map { $0.1 }
    if lines.reduce(0, { $0 + $1.count + 1 }) <= cap { return lines }
    var head: [String] = [], tail: [String] = [], h = 0, t = 0
    for l in lines { if h + l.count > cap / 2 { break }; head.append(l); h += l.count + 1 }
    for l in lines.reversed() { if t + l.count > cap / 2 { break }; tail.insert(l, at: 0); t += l.count + 1 }
    return head + ["…(\(lines.count - head.count - tail.count) more lines in between; point_at or click_text with their words scrolls there)"] + tail
}

func pageText(_ app: AXUIElement, _ w: Win, cap: Int = 1800) -> [String] {
    guard let root = axWindow(app, w) else { return [] }
    let win = CGRect(x: w.x, y: w.y, width: w.w, height: w.h)
    var found: [(CGFloat, CGFloat, String)] = [], seen = Set<String>(), visited = 0
    var stack: [(AXUIElement, Int)] = [(root, 0)]
    while let (el, depth) = stack.popLast(), visited < 8000 {
        visited += 1
        let role = str(el, kAXRoleAttribute) ?? ""
        if role == "AXStaticText" || role == "AXHeading", let t = str(el, kAXValueAttribute) ?? str(el, kAXTitleAttribute) ?? str(el, kAXDescriptionAttribute),
           let f = frame(el), win.intersects(f) {
            let line = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            if line.count >= 2, seen.insert(line).inserted { found.append((f.minY, f.minX, String(line.prefix(160)))) }
        }
        if depth < 60, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { for k in kids.reversed() { stack.append((k, depth + 1)) } }
    }
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
func typeText(_ s: String) {
    for chunk in Array(s.utf16).chunked(16) {
        var u = chunk
        let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)!, up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)!
        d.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
        up.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
        d.flags = []; up.flags = []
        d.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.012)
    }
}
extension Array { func chunked(_ n: Int) -> [[Element]] { stride(from: 0, to: count, by: n).map { Array(self[$0 ..< Swift.min($0 + n, count)]) } } }

let KEYS: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
    "j": 38, "k": 40, "n": 45, "m": 46, "f5": 96]
/// "cmd+a", "shift+tab", "return".
func pressKey(_ combo: String) -> Bool {
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    for part in combo.lowercased().split(separator: "+").map(String.init) {
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
    d.post(tap: .cghidEventTap); u.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.05)
    return true
}
func click(_ p: CGPoint) {
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

case "locate":
    guard args.count >= 2 else { fail("usage: locate <target>") }
    if args[1] == "screen" { out(["ok": true, "what": "screen"]) }
    guard let w = resolve(args[1]) else { fail("No matching window is open\(args[1].hasPrefix("app:") ? " for \(args[1].dropFirst(4))" : "").") }
    out(["ok": true, "window": winInfo(w)])

case "capture":
    guard args.count >= 3 else { fail("usage: capture <out> <target>") }
    let file = args[1], target = args[2]
    if target == "screen" {
        guard run("/usr/sbin/screencapture", ["-x", "-t", "jpg", file]) == 0 else { fail("Screen capture failed. Roamies may need Screen Recording permission.") }
        // screencapture with one file shoots the main display; its bounds (points) let the caller map pixels back.
        let d = CGDisplayBounds(CGMainDisplayID())
        out(["ok": true, "file": file, "what": "screen", "bounds": [Int(d.minX), Int(d.minY), Int(d.width), Int(d.height)]])
    }
    guard let w = resolve(target) else { fail("No matching window is open\(target.hasPrefix("app:") ? " for \(target.dropFirst(4))" : "").") }
    guard run("/usr/sbin/screencapture", ["-x", "-o", "-t", "jpg", "-l", String(w.id), file]) == 0 else { fail("Window capture failed. Roamies may need Screen Recording permission.") }
    out(["ok": true, "file": file, "window": winInfo(w)])

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
    out(["ok": true, "window": winInfo(w), "controls": items, "texts": pageText(uiApp, w, cap: 5000), "elsewhere": offscreenText(uiApp, w, cap: 4000), "note": items.isEmpty ? "This app shares no controls. Use a screenshot plus click at coordinates instead." : ""])

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
    // Bring the target app forward so keystrokes land there, not in Roamies.
    let app = axApp(w)
    // Keys and clicks go to whichever app is in front, so the target must really be there first.
    // activate() alone is only a request since macOS 14 and is often ignored for a background helper.
    if !bringToFront(w, app) {
        out(["ok": false, "error": "Couldn't bring \(w.app) to the front, so nothing was typed or clicked. Ask the user to click its window once, then try again.", "done": []])
    }
    // With several windows of one app, keystrokes go to its main window: make that the one we read.
    if let axw = axWindow(app, w), (attr(axw, kAXMainAttribute) as? Bool) != true {
        AXUIElementPerformAction(axw, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(axw, kAXMainAttribute as CFString, kCFBooleanTrue)
        Thread.sleep(forTimeInterval: 0.15)
    }
    var controls = walk(app, w)
    var done: [String] = []
    func el(_ s: [String: Any]) -> (AXUIElement, [String: Any])? {
        guard let id = s["id"] as? Int, id >= 1, id <= controls.count else { return nil }
        return controls[id - 1]
    }
    for (i, s) in steps.enumerated() {
        let what = s["do"] as? String ?? ""
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
            if let box = controls.first(where: { ["AXCheckBox", "AXRadioButton"].contains(axRole($0.0)) && fold(($0.1["label"] as? String) ?? "") == fold(q) && ($0.1["offscreen"] as? Bool) != true }) {
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
                if hit == nil, !q.isEmpty, scrollToText(app, w, q) { hit = findTextEls(app, w, q).first(where: { wholeMatch($0.1, q) }) }
            }
            guard !q.isEmpty, let (e, info) = hit else {
                out(["ok": false, "error": "Step \(i + 1): no visible text \"\(s["text"] ?? "")\" in \(w.app). Check the exact words with a screenshot or read_window.", "done": done])
            }
            if risky((info["text"] as? String) ?? q), (s["confirmed"] as? Bool) != true {
                out(["ok": false, "error": "Stopped before clicking \"\(info["text"] ?? q)\": it could delete, pay, send or sign out, and the user hasn't said yes to that. Tell them, and let them click it themselves.", "done": done])
            }
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
            let r = typeInto(app, e, text)
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
            if (s["to_end"] as? Bool) == true, dir == "up" || dir == "down" {
                // To the very end (or top): keep scrolling, giving a feed time to load more, until nothing changes.
                let sign: Int32 = dir == "up" ? 1 : -1, deadline = Date().addingTimeInterval(25)
                var last = "", same = 0, rounds = 0
                while Date() < deadline, same < 2 {
                    for _ in 0..<4 {
                        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
                        if let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: sign * 1500, wheel2: 0, wheel3: 0) { e.flags = []; e.post(tap: .cghidEventTap) }
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
            for _ in 0..<n { scrollAt(p, dy: dy, dx: dx); Thread.sleep(forTimeInterval: 0.04) }
            Thread.sleep(forTimeInterval: 0.25)
            done.append("scrolled \(dir)")
            controls = walk(app, w)
        case "key":
            guard pressKey(s["key"] as? String ?? "") else { out(["ok": false, "error": "Step \(i + 1): unknown key \(s["key"] ?? "")", "done": done]) }
            done.append("pressed \(s["key"]!)")
        case "click_at":
            // Points relative to the window's top-left, or global screen points when "global" is set.
            guard let x = s["x"] as? Double, let y = s["y"] as? Double else { out(["ok": false, "error": "Step \(i + 1): click_at needs x and y", "done": done]) }
            let global = s["global"] as? Bool ?? false
            click(global ? CGPoint(x: x, y: y) : CGPoint(x: w.x + x, y: w.y + y)); done.append("clicked at \(Int(x)),\(Int(y))")
        case "wait":
            Thread.sleep(forTimeInterval: min(5, (s["seconds"] as? Double) ?? 0.5)); done.append("waited")
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

default:
    fail("unknown command \(cmd)")
}
