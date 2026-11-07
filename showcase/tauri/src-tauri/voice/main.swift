// Voice helper for Roamies (macOS). Watches ⌃⌥, captures the mic and transcribes on-device with
// Apple's SpeechAnalyzer (macOS 26+, works with Siri and Dictation off; SFSpeechRecognizer before that).
// A session never ends while ⌃⌥ is held: it ends on release (push-to-talk), or for hands-free
// (quick tap) on a pause or the next press-and-release. Hold ⌃⌥ = push-to-talk (release sends). Quick tap = hands-free
// (ends on a pause or another tap). JSON lines on stdout; exits when stdin closes.
// Modifier state is read with CGEventSource, which needs no Input Monitoring permission.
// While ⌃⌥ is held the mouse draws on the screen (ink.swift); the marked area goes out with what was said.
// While listening, a small voice-bar pill rides beside the cursor (wave.swift) instead of a transcript bubble.
import AVFoundation
import AppKit
import CoreAudio
import CoreGraphics
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

func log(_ s: String) {
    FileHandle.standardError.write(Data("[voice] \(s)\n".utf8))
}

let dryRun = ProcessInfo.processInfo.environment["ROAMIES_VOICE_DRYRUN"] == "1"
func uptime() -> Double { ProcessInfo.processInfo.systemUptime }

// One recognition session. Callbacks always arrive on the main queue.
protocol Recognizer: AnyObject {
    func append(_ buffer: AVAudioPCMBuffer)
    func end()
    func cancel()
}
struct RecognizerCallbacks {
    let onText: (String) -> Void
    let onDone: () -> Void
    let onError: (Error) -> Void
}

// macOS 26+: SpeechAnalyzer + SpeechTranscriber. Model assets are shared system-wide and
// downloaded on first use; the locale and audio format are resolved once and reused.
@available(macOS 26, *)
final class AnalyzerRecognizer: Recognizer {
    private static var prepared: Task<(Locale, AVAudioFormat?), Error>?
    static func prepare() -> Task<(Locale, AVAudioFormat?), Error> {
        if let p = prepared { return p }
        let t = Task { () throws -> (Locale, AVAudioFormat?) in
            let want = Locale.current
            var locale = await SpeechTranscriber.supportedLocale(equivalentTo: want)
            if locale == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) }
            let resolved = locale ?? Locale(identifier: "en-US")
            let probe = SpeechTranscriber(locale: resolved, preset: .progressiveTranscription)
            if let req = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
                log("downloading speech model for \(resolved.identifier)")
                try await req.downloadAndInstall()
            }
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe])
            log("speech analyzer ready: \(resolved.identifier) \(format.map { "\($0.sampleRate)Hz" } ?? "native")")
            return (resolved, format)
        }
        prepared = t
        return t
    }

    private let raw: AsyncStream<AVAudioPCMBuffer>.Continuation
    private var work: Task<Void, Never>?
    private var finalized = "", volatile = ""

    init(_ cb: RecognizerCallbacks) {
        let (stream, cont) = AsyncStream<AVAudioPCMBuffer>.makeStream()
        raw = cont
        work = Task { [weak self] in
            do {
                let (locale, format) = try await Self.prepare().value
                let tr = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
                let analyzer = SpeechAnalyzer(modules: [tr])
                var converter: AVAudioConverter?
                let inputs = AsyncStream<AnalyzerInput> { out in
                    Task {
                        for await buf in stream {
                            if let format, buf.format != format {
                                if converter == nil || converter?.inputFormat != buf.format { converter = AVAudioConverter(from: buf.format, to: format) }
                                if let c = converter, let conv = Self.convert(buf, with: c, to: format) { out.yield(AnalyzerInput(buffer: conv)) }
                            } else {
                                out.yield(AnalyzerInput(buffer: buf))
                            }
                        }
                        out.finish()
                    }
                }
                try await analyzer.start(inputSequence: inputs)
                let reader = Task {
                    for try await r in tr.results {
                        let text = String(r.text.characters)
                        guard let self else { return }
                        if r.isFinal { self.finalized = Self.join(self.finalized, text); self.volatile = "" } else { self.volatile = text }
                        let shown = Self.join(self.finalized, self.volatile).trimmingCharacters(in: .whitespaces)
                        DispatchQueue.main.async { cb.onText(shown) }
                    }
                }
                // Hold until the user stops talking (end()), then flush what's left.
                await self?.waitForEnd()
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                try await reader.value
                DispatchQueue.main.async { cb.onDone() }
            } catch is CancellationError {
            } catch {
                DispatchQueue.main.async { cb.onError(error) }
            }
        }
    }

    private var ended = false, endWaiters: [CheckedContinuation<Void, Never>] = []
    private func waitForEnd() async {
        await withCheckedContinuation { c in
            DispatchQueue.main.async { if self.ended { c.resume() } else { self.endWaiters.append(c) } }
        }
    }

    private static func join(_ a: String, _ b: String) -> String {
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return a.hasSuffix(" ") || b.hasPrefix(" ") ? a + b : a + " " + b
    }

    private static func convert(_ buf: AVAudioPCMBuffer, with c: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let cap = AVAudioFrameCount(Double(buf.frameLength) * format.sampleRate / buf.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        c.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buf
        }
        return err == nil && out.frameLength > 0 ? out : nil
    }

    func append(_ buffer: AVAudioPCMBuffer) { raw.yield(buffer) }
    func end() {
        raw.finish()
        DispatchQueue.main.async { self.ended = true; self.endWaiters.forEach { $0.resume() }; self.endWaiters = [] }
    }
    func cancel() {
        raw.finish()
        work?.cancel()
        DispatchQueue.main.async { self.ended = true; self.endWaiters.forEach { $0.resume() }; self.endWaiters = [] }
    }
}

// Before macOS 26: SFSpeechRecognizer. Needs Siri or Dictation turned on in System Settings.
final class LegacyRecognizer: Recognizer {
    private let req = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?

    init?(_ cb: RecognizerCallbacks) {
        guard let rec = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")), rec.isAvailable else { return nil }
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        if #available(macOS 13, *) { req.addsPunctuation = true }
        req.taskHint = .dictation
        req.contextualStrings = ["Roamies", "Roamie", "JARVIS"]
        task = rec.recognitionTask(with: req) { result, error in
            DispatchQueue.main.async {
                if let result {
                    cb.onText(result.bestTranscription.formattedString)
                    if result.isFinal { cb.onDone() }
                }
                if let error { cb.onError(error) }
            }
        }
    }
    func append(_ buffer: AVAudioPCMBuffer) { req.append(buffer) }
    func end() { req.endAudio() }
    func cancel() { task?.cancel(); task = nil }
}

// Mutes the default output while you talk so music or videos don't drown you out (or end up in the
// transcript), then puts it back. Only ever un-mutes what it muted itself.
enum OutputMute {
    private static var device: AudioDeviceID?
    static var enabled = true

    private static func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }
    private static func defaultOutput() -> AudioDeviceID? {
        var id = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var a = addr(kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id) == noErr && id != 0 ? id : nil
    }
    private static func muted(_ dev: AudioDeviceID) -> Bool? {
        var a = addr(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)
        guard AudioObjectHasProperty(dev, &a) else { return nil }
        var v = UInt32(0), size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &v) == noErr ? v != 0 : nil
    }
    private static func set(_ dev: AudioDeviceID, _ on: Bool) -> Bool {
        var a = addr(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)
        var v: UInt32 = on ? 1 : 0
        return AudioObjectSetPropertyData(dev, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v) == noErr
    }

    static func begin() {
        guard enabled, device == nil, let dev = defaultOutput(), muted(dev) == false else { return }
        if set(dev, true) { device = dev; log("output muted while listening") }
    }
    static func end() {
        guard let dev = device else { return }
        device = nil
        // Unmute only if it's still muted: the user may have unmuted by hand meanwhile.
        if muted(dev) == true, set(dev, false) { log("output restored") }
    }
}

// Some mics (many USB, headset and webcam ones) deliver speech near -50 dBFS, too faint for Speech to make
// out words. Boost quiet speech toward ordinary level, at most +20 dB; normal and loud mics pass through as is.
// Only sounds well above the room's noise count as speech, so silence alone never raises the boost.
final class AutoGain {
    static let target: Float = 0.05 // about -26 dBFS RMS, ordinary speech
    static let maxGain: Float = 10
    private(set) var gain: Float = 1
    private var noise: Float = 0, speech: Float = 0

    /// Feed one buffer's RMS (before boosting); returns the boost for it.
    func next(_ rms: Float) -> Float {
        noise = noise == 0 ? max(rms, 1e-5) : rms < noise ? max(rms, 1e-5) : noise * 1.002
        if rms > noise * 3 && rms > 1e-4 { speech = max(speech, rms) } else { speech *= 0.998 }
        let want = speech > 0 ? min(Self.maxGain, max(1, Self.target / speech)) : 1
        // Down at once so a louder voice never clips; up gradually (about 0.5 s from 1x to 10x).
        gain = want < gain ? want : min(want, gain * 1.1)
        return gain
    }

    /// Boosts the buffer in place, ramping from the previous boost to avoid clicks.
    func apply(_ buffer: AVAudioPCMBuffer, rms: Float) {
        let from = gain, to = next(rms)
        guard let ch = buffer.floatChannelData, from != 1 || to != 1 else { return }
        let n = Int(buffer.frameLength), step = (to - from) / Float(max(n, 1))
        for c in 0 ..< Int(buffer.format.channelCount) {
            let x = ch[c]
            for i in 0 ..< n { x[i] = min(1, max(-1, x[i] * (from + step * Float(i + 1)))) }
        }
    }
}

final class Voice {
    enum Phase { case idle, armed, holding, handsFree, finishing }

    private var phase = Phase.idle
    private var chordAt = 0.0, listenAt = 0.0, heardAt = 0.0, voiceAt = 0.0, levelAt = 0.0, releasedAt: Double?
    private var blocked = false, prevChord = false, authorizing = false, reportEmpty = false, failed = false
    private var engine: AVAudioEngine?
    // Kept across sessions (same mic, usually), so later takes start at the right boost.
    private let autoGain = AutoGain()
    private var rec: Recognizer?
    private var best = ""
    private var finishTimer: Timer?
    private var useAnalyzer: Bool { if #available(macOS 26, *) { return SpeechTranscriber.isAvailable } else { return false } }

    init() {
        // Resolve the locale and fetch the model up front so the first ⌃⌥ is instant.
        if #available(macOS 26, *), SpeechTranscriber.isAvailable { _ = AnalyzerRecognizer.prepare() }
    }

    // The talk chord: any two of ⌃ ⌥ ⌘ ⇧ (default ⌃⌥). Set with --chord or {"cmd":"chord"}.
    private static let allMods: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand, .maskShift]
    private var chordMask: CGEventFlags = [.maskControl, .maskAlternate]
    static func mask(_ names: [String]) -> CGEventFlags? {
        var m: CGEventFlags = []
        for n in names {
            switch n.lowercased() {
            case "control", "ctrl": m.insert(.maskControl)
            case "option", "alt": m.insert(.maskAlternate)
            case "command", "cmd": m.insert(.maskCommand)
            case "shift": m.insert(.maskShift)
            default: return nil
            }
        }
        return names.count == 2 && m.rawValue.nonzeroBitCount == 2 ? m : nil
    }
    func setChord(_ names: [String]) {
        guard let m = Self.mask(names) else { return log("ignored chord \(names)") }
        if phase != .idle { cancel() }
        chordMask = m; blocked = true
        log("talk chord: \(names.joined(separator: "+"))")
    }

    private static let modifierKeys: Set<CGKeyCode> = [0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F]
    private static let tapLimit = 0.25
    // A release must last this long to count, so one glitchy frame of key state can't end a session.
    private static let releaseDebounce = 0.09
    private static let pauseEnds = 1.5
    private static let maxSession = 60.0

    var engineName: String { useAnalyzer ? "speechanalyzer" : "sfspeech" }

    // ---------- hotkey ----------

    private func otherKeyDown() -> Bool {
        for code in CGKeyCode(0) ..< 0x80 where !Self.modifierKeys.contains(code) {
            if CGEventSource.keyState(.combinedSessionState, key: code) { return true }
        }
        return false
    }

    let ink = Ink()
    let wave = Wave()
    let buddy = Buddy()

    func tick() {
        // Drawing follows the keys: only while ⌃⌥ is down for a talk.
        defer { ink.setArmed(phase == .armed || phase == .holding); wave.tick(); buddy.tick() }
        let now = uptime()
        let f = CGEventSource.flagsState(.combinedSessionState).intersection(Self.allMods)
        let held = f.intersection(chordMask)
        let down = held == chordMask // once talking, a stray extra modifier doesn't count as letting go
        let extra = !f.subtracting(chordMask).isEmpty
        let chord = down && !extra
        defer { prevChord = chord }
        if held.isEmpty { blocked = false }

        // Debounced release: true only once ⌃⌥ has been up for releaseDebounce.
        let released: Bool = {
            if down { releasedAt = nil; return false }
            if releasedAt == nil { releasedAt = now }
            return now - (releasedAt ?? now) >= Self.releaseDebounce
        }()

        switch phase {
        case .idle:
            if chord && !prevChord && !blocked { arm(now) }
        case .armed:
            // Only the first moment decides shortcut vs. talk: ⌃⌥ plus a key, ⇧ or ⌘ is a shortcut.
            if down && (extra || otherKeyDown()) { log("not a talk: ⌃⌥ was part of a shortcut"); cancel(); blocked = true; return }
            if released { phase = .handsFree; showListening("handsfree", now); return }
            if down && now - chordAt >= Self.tapLimit { phase = .holding; showListening("hold", now) }
        case .holding:
            if released { end("released"); finish(); return }
            if now - listenAt > Self.maxSession { end("max length"); finish() }
        case .handsFree:
            // Pressing again switches to push-to-talk; letting go then sends.
            if chord && !prevChord && !blocked { phase = .holding; releasedAt = nil; return }
            let quiet = now - max(heardAt, voiceAt)
            if !best.isEmpty && quiet > Self.pauseEnds { end("pause"); finish() }
            else if best.isEmpty && now - listenAt > 8 { end("nothing heard"); cancel() }
            else if now - listenAt > Self.maxSession { end("max length"); finish() }
        case .finishing:
            break
        }
    }

    private func end(_ why: String) { log("session end: \(why) after \(String(format: "%.1f", uptime() - listenAt))s, mic boost \(String(format: "%.1f", autoGain.gain))x") }

    // ---------- session ----------

    private func arm(_ now: Double) {
        phase = .armed
        chordAt = now
        best = ""
        // The drawing layer first: starting the mic below holds this thread for a moment (longer with Bluetooth),
        // and a drag begun in that moment would otherwise land in the app underneath.
        ink.setArmed(true)
        // ROAMIES_VOICE_DRYRUN_TEXT: what a dry run "hears", to test what goes out with the words (like pen marks).
        if dryRun { best = ProcessInfo.processInfo.environment["ROAMIES_VOICE_DRYRUN_TEXT"] ?? ""; return }
        // Already allowed: start the mic now so the first word isn't lost. Otherwise wait until
        // the press is clearly a talk (hold or tap), so shortcuts like ⌃⌥S never trigger a prompt.
        if authorized { startAudio() }
    }

    private var authorized: Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized && (useAnalyzer || SFSpeechRecognizer.authorizationStatus() == .authorized)
    }

    private func showListening(_ mode: String, _ now: Double) {
        listenAt = now; heardAt = now; voiceAt = now
        if !dryRun && rec == nil {
            ensureAuthorized { [weak self] in
                guard let self, self.phase == .holding || self.phase == .handsFree, self.rec == nil else { return }
                self.startAudio()
            }
        }
        if !dryRun { OutputMute.begin() }
        wave.show()
        // wave: the cursor shows the listening, so the app shows no listening bubble.
        emit(["type": "state", "state": "listening", "mode": mode, "wave": true])
        if !best.isEmpty { emit(["type": "partial", "text": best]) }
    }

    private func finish() {
        guard phase == .armed || phase == .holding || phase == .handsFree else { return }
        let shown = phase != .armed
        reportEmpty = shown && !failed
        phase = .finishing
        wave.think()
        wave.setHidden(true)
        ink.capture { [weak self] in self?.wave.setHidden(false) }
        if shown { emit(["type": "state", "state": "processing"]) }
        guard let r = rec, !failed else { stopAudio(); finalize(); return }
        // Keep the mic open a moment after release so a word said while letting go isn't clipped.
        let tail = Timer(timeInterval: 0.3, repeats: false) { [weak self] _ in
            guard let self, self.phase == .finishing, self.rec === r else { return }
            self.stopAudio()
            r.end()
            let t = Timer(timeInterval: 2.5, repeats: false) { [weak self] _ in self?.finalize() }
            RunLoop.main.add(t, forMode: .common)
            self.finishTimer = t
        }
        RunLoop.main.add(tail, forMode: .common)
        finishTimer = tail
    }

    private func finalize() {
        guard phase == .finishing else { return }
        finishTimer?.invalidate(); finishTimer = nil
        rec?.cancel(); rec = nil
        phase = .idle
        let text = best.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { wave.hide() } else { wave.awaitAnswer() }
        let empty = text.isEmpty && reportEmpty, spoke = voiceAt > listenAt + 0.05
        reportEmpty = false
        let rest = {
            emit(["type": "state", "state": "idle"])
            // Listened but got no words: say so instead of closing silently.
            if empty { emit(["type": "error", "code": "nothing_heard", "spoke": spoke]) }
        }
        if text.isEmpty { ink.clear(); rest(); return }
        // What was marked on screen while talking rides along with the words.
        ink.take { area in
            var msg: [String: Any] = ["type": "final", "text": text]
            if let area { msg["area"] = area }
            emit(msg)
            rest()
        }
    }

    private func cancel() {
        stopAudio()
        rec?.cancel(); rec = nil
        finishTimer?.invalidate(); finishTimer = nil
        phase = .idle
        reportEmpty = false
        ink.clear()
        wave.hide()
        emit(["type": "state", "state": "idle", "cancelled": true])
    }

    /// The shell saw ⌃⌥S: that ⌃⌥ was a shortcut, not a request to talk.
    /// Start listening hands-free without a key press (after an area snap). Ends on a pause or a tap.
    func listenNow() {
        guard phase == .idle else { return }
        arm(uptime())
        phase = .handsFree
        blocked = true // the snap shortcut's keys may still be held: don't read them as a tap
        showListening("handsfree", uptime())
    }

    func externalCancel() {
        if phase == .armed || phase == .holding || phase == .handsFree { cancel() }
        blocked = true
    }

    // ---------- permissions ----------

    private func ensureAuthorized(_ then: @escaping () -> Void) {
        let mic = AVCaptureDevice.authorizationStatus(for: .audio)
        let speech = SFSpeechRecognizer.authorizationStatus()
        if mic == .authorized && (useAnalyzer || speech == .authorized) { then(); return }
        if mic == .denied || mic == .restricted { return denied("microphone") }
        if speech == .denied || speech == .restricted { return denied("speech") }
        if authorizing { return }
        authorizing = true
        AVCaptureDevice.requestAccess(for: .audio) { micOK in
            guard micOK else {
                DispatchQueue.main.async { self.authorizing = false; self.denied("microphone") }
                return
            }
            if self.useAnalyzer { DispatchQueue.main.async { self.authorizing = false; then() }; return }
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    self.authorizing = false
                    if status == .authorized { then() } else { self.denied("speech") }
                }
            }
        }
    }

    private func denied(_ what: String) {
        emit(["type": "error", "code": "permission", "what": what])
        cancel()
    }

    // ---------- audio + recognition ----------

    private func startAudio() {
        failed = false
        var mine: Recognizer?
        let cb = RecognizerCallbacks(
            onText: { [weak self] text in guard let self, self.rec === mine else { return }; self.onText(text) },
            onDone: { [weak self] in guard let self, self.rec === mine, self.phase == .finishing else { return }; self.finalize() },
            onError: { [weak self] err in guard let self, self.rec === mine else { return }; self.onError(err) }
        )
        if #available(macOS 26, *), useAnalyzer { mine = AnalyzerRecognizer(cb) } else { mine = LegacyRecognizer(cb) }
        guard let r = mine else {
            emit(["type": "error", "code": "unavailable"])
            return cancel()
        }

        let eng = AVAudioEngine()
        let input = eng.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emit(["type": "error", "code": "no_input"])
            return cancel()
        }
        let gain = autoGain
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let samples = buffer.floatChannelData?[0] else { r.append(buffer); return }
            let n = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0 ..< n { sum += samples[i] * samples[i] }
            let rms = sqrt(sum / Float(max(n, 1)))
            gain.apply(buffer, rms: rms)
            r.append(buffer)
            // Level and pause detection use the mic's own level, so boosted room noise can't hold a session open.
            let level = min(1, max(0, (Double(20 * log10(max(rms, 1e-7))) + 55) / 40))
            DispatchQueue.main.async { self?.onLevel(level) }
        }
        do {
            eng.prepare()
            try eng.start()
        } catch {
            log("engine start failed: \(error)")
            r.cancel()
            emit(["type": "error", "code": "no_input"])
            return cancel()
        }
        engine = eng
        rec = r
    }

    private func stopAudio() {
        OutputMute.end()
        guard let eng = engine else { return }
        eng.inputNode.removeTap(onBus: 0)
        eng.stop()
        engine = nil
    }

    private func onLevel(_ v: Double) {
        let now = uptime()
        if v > 0.2 { voiceAt = now }
        if phase == .holding || phase == .handsFree { wave.setLevel(v) }
        guard phase == .holding || phase == .handsFree, now - levelAt >= 0.05 else { return }
        levelAt = now
        emit(["type": "level", "v": (v * 100).rounded() / 100])
    }

    private func onText(_ text: String) {
        guard text != best else { return }
        best = text
        heardAt = uptime()
        if phase != .armed && phase != .idle { emit(["type": "partial", "text": text]) }
    }

    private func onError(_ error: Error) {
        let msg = error.localizedDescription
        log("recognition: \(msg)")
        // Ending a request early reports "no speech"/cancel errors; only real failures reach the user.
        let ns = error as NSError
        let benign = ns.domain == "kAFAssistantErrorDomain" && [203, 216, 301, 1110].contains(ns.code)
        if !benign && best.isEmpty {
            failed = true
            let code = msg.localizedCaseInsensitiveContains("dictation") || msg.localizedCaseInsensitiveContains("siri") ? "dictation_off" : "recognition"
            emit(["type": "error", "code": code, "message": msg])
        }
        // A failed recognizer can't hear anything more, so end; otherwise keep listening while held.
        if phase == .finishing { finalize() }
        else if failed { end("recognition error"); finish() }
    }
}

// ---------- one-shot permission modes (used by the setup guide) ----------
// --perms prints the current state; --request <mic|speech|screen> asks, then prints the state.
// Run as a child of Roamies, so macOS attributes the prompts and grants to Roamies.
func permStatus() -> [String: Any] {
    func av(_ s: AVAuthorizationStatus) -> String { s == .authorized ? "granted" : s == .notDetermined ? "unknown" : "denied" }
    func sp(_ s: SFSpeechRecognizerAuthorizationStatus) -> String { s == .authorized ? "granted" : s == .notDetermined ? "unknown" : "denied" }
    var analyzer = false
    if #available(macOS 26, *) { analyzer = SpeechTranscriber.isAvailable }
    return [
        "type": "perms",
        "mic": av(AVCaptureDevice.authorizationStatus(for: .audio)),
        // SpeechAnalyzer (macOS 26+) needs no speech-recognition permission.
        "speech": analyzer ? "granted" : sp(SFSpeechRecognizer.authorizationStatus()),
        "speechNeeded": !analyzer,
        "screen": CGPreflightScreenCaptureAccess() ? "granted" : "unknown",
    ]
}
let args = CommandLine.arguments
// --test-gain checks the quiet-mic boost with made-up levels; exits 1 on a failure.
if args.contains("--test-gain") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    func run(_ g: AutoGain, _ rms: Float, _ n: Int) { for _ in 0 ..< n { _ = g.next(rms) } }
    var g = AutoGain(); run(g, 0.001, 50); run(g, 0.06, 50)
    check("normal mic stays at 1x", g.gain == 1)
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.003, 30)
    check("quiet mic (-50 dB) boosted to 10x within 0.7 s", g.gain == AutoGain.maxGain)
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.01, 50)
    check("slightly quiet mic boosted just to ordinary level", abs(g.gain - 5) < 0.01)
    g = AutoGain(); run(g, 0.0005, 500)
    check("silence alone never boosted", g.gain == 1)
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.003, 50); _ = g.next(0.2)
    check("loud sound drops the boost at once", g.gain == 1)
    let fmt = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 4)!
    buf.frameLength = 4
    for c in 0 ..< 2 { for i in 0 ..< 4 { buf.floatChannelData![c][i] = 0.5 } }
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.003, 50); g.apply(buf, rms: 0.003)
    check("boost applies to every channel and never clips", (0 ..< 2).allSatisfy { c in buf.floatChannelData![c][3] == 1 })
    exit(bad == 0 ? 0 : 1)
}
if args.contains("--perms") { emit(permStatus()); exit(0) }
if let i = args.firstIndex(of: "--request"), i + 1 < args.count {
    let done = DispatchSemaphore(value: 0)
    switch args[i + 1] {
    case "mic": AVCaptureDevice.requestAccess(for: .audio) { _ in done.signal() }; done.wait()
    case "speech": SFSpeechRecognizer.requestAuthorization { _ in done.signal() }; done.wait()
    case "screen": _ = CGRequestScreenCaptureAccess()
    default: break
    }
    emit(permStatus()); exit(0)
}

var signalSources: [DispatchSourceSignal] = []
let voice = Voice()
if args.contains("--no-mute") { OutputMute.enabled = false }
if let i = args.firstIndex(of: "--chord"), i + 1 < args.count { voice.setChord(args[i + 1].components(separatedBy: ",")) }
let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { _ in voice.tick() }
RunLoop.main.add(timer, forMode: .common)
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        switch msg["cmd"] as? String {
        case "cancel": DispatchQueue.main.async { voice.externalCancel() }
        case "listen": DispatchQueue.main.async { voice.listenNow() }
        // The sidekick is answering (it appears where the cursor is): the listening pill can go.
        case "handoff": DispatchQueue.main.async { voice.wave.hide() }
        // The sidekick following the cursor in its cursor form, drawn here (buddy.swift) until the page takes it back.
        case "buddy": DispatchQueue.main.async { if msg["on"] as? Bool == true { voice.buddy.show(msg) } else { voice.buddy.hide() } }
        case "buddy_alpha": if let a = msg["a"] as? Double { DispatchQueue.main.async { voice.buddy.setHidden(a < 0.5) } }
        case "chord": if let mods = msg["mods"] as? [String] { DispatchQueue.main.async { voice.setChord(mods) } }
        case "mute": if let on = msg["on"] as? Bool { DispatchQueue.main.async { OutputMute.enabled = on; if !on { OutputMute.end() } } }
        default: break
        }
    }
    // Roamies quit: never leave the Mac muted.
    DispatchQueue.main.sync { OutputMute.end() }
    exit(0)
}
// Killed (Quit, crash restart): restore output on the way out too.
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { OutputMute.end(); exit(0) }
    src.resume()
    signalSources.append(src)
}
emit(["type": "ready", "engine": voice.engineName, "dryRun": dryRun])
// An app run loop (no Dock icon) so the drawing panels get mouse events.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
