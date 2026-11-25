import SwiftUI
import WebKit
import AVFoundation
import Network

@main
struct BhatBotApp: App {
    init() { AudioSession.configure() }
    var body: some Scene {
        WindowGroup {
            WebRoot()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
        }
    }
}

// CRITICAL for voice: WKWebView's Web Audio plays through the app's AVAudioSession. The default
// category is silenced by the ring/silent switch, so replies arrive and you hear nothing.
// .playAndRecord + .defaultToSpeaker plays through the speaker while the mic can still record.
enum AudioSession {
    static func configure() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .spokenAudio,
                           options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .duckOthers])
        try? s.setActive(true, options: [])
    }
}

// ── THE CONNECTION ───────────────────────────────────────────────────────────────────────────────
//
// 2026-11-25: "I want to be sure that it's significantly better than last time now, especially with
// connectivity to the computer."
//
// The old shell loaded ONE URL and, on any failure, fell back to a cached page for the rest of the
// session. That page could not talk to anything either, and nothing ever tried again until the app
// was relaunched. Now:
//   • both doors (Mac direct, then cloud) are probed AT ONCE with a short timeout, and the first in
//     preference order that answers wins — the Mac when it is awake, the cloud otherwise;
//   • a network change (Wi-Fi ↔ cellular, eduroam captive portal clearing) re-probes immediately;
//   • while the app is open the active door is checked every 20 s; two misses in a row re-choose,
//     and the cloud yields to the Mac as soon as the Mac answers again (only between conversations —
//     the page reports when it is busy);
//   • the offline copy is a WAITING ROOM, not a destination: it keeps probing and loads the live UI
//     the moment either door opens.
enum Route: String { case mac, cloud, offline }

final class Connection {
    private(set) var active: Endpoint?
    private(set) var route: Route = .offline
    var onChange: ((Endpoint?) -> Void)?
    var pageBusy = false

    private let monitor = NWPathMonitor()
    private var timer: Timer?
    private var misses = 0
    private var probing = false

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            DispatchQueue.main.async { self?.choose(reason: "network changed") }
        }
        monitor.start(queue: DispatchQueue.global(qos: .utility))
    }

    func start() {
        choose(reason: "launch")
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.heartbeat() }
    }
    func pause() { timer?.invalidate(); timer = nil }
    /// Forget the current door so the next choice is applied even if it picks the same one again.
    func reset() { active = nil; route = .offline }

    /// GET <door>/app/<token>/version within `timeout`. 200 = open.
    static func probe(_ e: Endpoint, timeout: TimeInterval = 3.5, done: @escaping (Bool) -> Void) {
        guard let url = e.probeURL else { return done(false) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = "GET"
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout; cfg.timeoutIntervalForResource = timeout
        cfg.waitsForConnectivity = false
        URLSession(configuration: cfg).dataTask(with: req) { _, resp, _ in
            done((resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    /// Probe every door in parallel; take the most preferred that answered.
    func choose(reason: String) {
        if probing { return }
        let doors = Config.endpoints
        guard !doors.isEmpty else { set(nil); return }
        probing = true
        var ok = [String: Bool]()
        let group = DispatchGroup()
        let lock = NSLock()
        for d in doors {
            group.enter()
            Connection.probe(d) { up in lock.lock(); ok[d.name] = up; lock.unlock(); group.leave() }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            self.probing = false
            let pick = doors.first { ok[$0.name] == true }
            NSLog("[bhatbot] route (\(reason)): \(pick?.name ?? "offline")  \(ok)")
            if pick != self.active || self.route == .offline { self.set(pick) }
        }
    }

    private func set(_ e: Endpoint?) {
        active = e
        route = e.map { Route(rawValue: $0.name) ?? .cloud } ?? .offline
        misses = 0
        onChange?(e)
    }

    private func heartbeat() {
        guard let cur = active else { choose(reason: "waiting room"); return }
        Connection.probe(cur) { [weak self] up in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if up { self.misses = 0 } else { self.misses += 1 }
                if self.misses >= 2 { self.choose(reason: "\(cur.name) stopped answering"); return }
                // On the cloud but the Mac is back → move to the Mac, between conversations only.
                if up, cur.name == "cloud", !self.pageBusy, let mac = Config.endpoints.first(where: { $0.name == "mac" }) {
                    Connection.probe(mac) { macUp in
                        if macUp { DispatchQueue.main.async { if !self.pageBusy { self.set(mac) } } }
                    }
                }
            }
        }
    }
}

// Full-screen WKWebView on whichever door is open.
struct WebRoot: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsAirPlayForMediaPlayback = true
        // The page tells the shell when a conversation is in flight (so a route switch waits) and can
        // ask it to re-check the connection right now (its own fetch just failed).
        cfg.userContentController.add(context.coordinator, name: "bhatbot")

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = context.coordinator
        web.navigationDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.035, green: 0.05, blue: 0.075, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.scrollView.bounces = true
        web.allowsBackForwardNavigationGestures = false
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        context.coordinator.web = web

        let refresh = UIRefreshControl()
        refresh.tintColor = UIColor(red: 0.48, green: 0.18, blue: 0.24, alpha: 1)
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pull(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh

        // Long-press anywhere → servers (Mac + cloud host/token), so a new tunnel needs no rebuild.
        let lp = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.longPress(_:)))
        lp.minimumPressDuration = 0.9
        web.addGestureRecognizer(lp)

        let nc = NotificationCenter.default
        nc.addObserver(context.coordinator, selector: #selector(Coordinator.foreground), name: UIApplication.willEnterForegroundNotification, object: nil)
        nc.addObserver(context.coordinator, selector: #selector(Coordinator.background), name: UIApplication.didEnterBackgroundNotification, object: nil)

        context.coordinator.boot()
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
        weak var web: WKWebView?
        let conn = Connection()
        private var loaded: Endpoint?
        private var showingOffline = false
        private var liveNav: WKNavigation?        // the navigation whose failure means "this door is shut"

        // The last live UI, saved after each successful load: the offline waiting room shows the
        // newest UI it has seen rather than the copy bundled at build time.
        private var cachedURL: URL {
            FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("mobile-cached.html")
        }

        // Decide the door FIRST (≤3.5 s), and show the offline copy only if neither door answers in
        // ~4 s. Loading the offline page "instantly" and then the live one raced: WebKit kept the
        // file:// navigation and cancelled the live one, so every launch stayed on the stale copy.
        func boot() {
            conn.onChange = { [weak self] e in self?.show(e) }
            conn.start()
            DispatchQueue.main.asyncAfter(deadline: .now() + 4.2) { [weak self] in
                guard let self = self, self.loaded == nil else { return }
                self.loadOffline()
            }
        }

        private func inject(_ e: Endpoint?, bundled: Bool) {
            guard let web = web else { return }
            let ucc = web.configuration.userContentController
            ucc.removeAllUserScripts()
            ucc.addUserScript(WKUserScript(source: Config.injectedJS(active: e, bundled: bundled), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        private func show(_ e: Endpoint?) {
            guard let e = e, let url = e.appURL else { loadOffline(); return }
            if e == loaded && !showingOffline { return }
            inject(e, bundled: false)
            loaded = e; showingOffline = false
            liveNav = web?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12))
        }

        private func loadOffline() {
            guard let web = web, !showingOffline else { return }
            showingOffline = true; loaded = nil
            inject(Config.endpoints.first, bundled: true)
            if FileManager.default.fileExists(atPath: cachedURL.path) {
                web.loadFileURL(cachedURL, allowingReadAccessTo: cachedURL.deletingLastPathComponent())
            } else if let url = Bundle.main.url(forResource: "mobile", withExtension: "html") {
                web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            NSLog("[bhatbot] finished \(navigation == liveNav ? "LIVE" : "other") \(webView.url?.scheme ?? "?")://\(webView.url?.host ?? "")")
            guard !showingOffline, let e = loaded, let url = e.appURL else { return }
            URLSession.shared.dataTask(with: url) { [weak self] data, resp, _ in
                guard let self = self, (resp as? HTTPURLResponse)?.statusCode == 200, let data = data, data.count > 1000 else { return }
                try? data.write(to: self.cachedURL, options: .atomic)
            }.resume()
        }
        // A live load that fails → re-choose (the other door may be open), offline meanwhile.
        // Only a failure of the LIVE navigation counts. Starting the live load cancels the offline page
        // that was still loading (NSURLErrorCancelled); treating that as "the door is shut" sent the
        // first build straight back to the offline copy every launch.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(navigation, error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(navigation, error) }
        private func failed(_ nav: WKNavigation?, _ error: Error) {
            let ns = error as NSError
            if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
                // The live load itself was cancelled (something else navigated first) → load it again.
                if nav == liveNav, let e = loaded { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.loaded = nil; self?.show(e) } }
                return
            }
            guard nav == liveNav, !showingOffline else { return }
            NSLog("[bhatbot] live load failed on \(loaded?.name ?? "?"): \(ns.code) \(ns.localizedDescription)")
            loadOffline(); conn.reset(); conn.choose(reason: "page load failed")
        }

        // Messages from the page: {busy: Bool} or {recheck: true}.
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let m = message.body as? [String: Any] else { return }
            if let b = m["busy"] as? Bool { conn.pageBusy = b }
            if (m["recheck"] as? Bool) == true { conn.choose(reason: "page asked") }
        }

        @objc func pull(_ rc: UIRefreshControl) { loaded = nil; conn.choose(reason: "pull to refresh"); rc.endRefreshing() }
        @objc func foreground() { AudioSession.configure(); conn.start() }
        @objc func background() { conn.pause() }

        // Mic/camera auto-grant — his own app talking to his own Mac.
        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.grant) }

        // ---- Servers sheet ----
        @objc func longPress(_ g: UILongPressGestureRecognizer) {
            guard g.state == .began, let vc = topViewController() else { return }
            let mac = Config.mac, cloud = Config.cloud
            let a = UIAlertController(title: "BhatBot servers",
                message: "Now on: \(conn.route.rawValue). The Mac is tried first, then the cloud.", preferredStyle: .alert)
            let field: (String, String, Bool) -> Void = { ph, val, url in
                a.addTextField { tf in tf.placeholder = ph; tf.text = val; tf.autocapitalizationType = .none; tf.autocorrectionType = .no; if url { tf.keyboardType = .URL } }
            }
            field("Mac https://…ts.net", mac.host, true); field("Mac token", mac.token, false)
            field("Cloud https://…", cloud.host, true); field("Cloud token", cloud.token, false)
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            a.addAction(UIAlertAction(title: "Reset to built-in", style: .destructive) { [weak self] _ in
                Config.resetToBuilt(); self?.loaded = nil; self?.conn.choose(reason: "servers reset")
            })
            a.addAction(UIAlertAction(title: "Save", style: .default) { [weak self] _ in
                let t = (a.textFields ?? []).map { $0.text ?? "" }
                if t.count == 4 { Config.save(mac: (t[0], t[1]), cloud: (t[2], t[3])) }
                self?.loaded = nil; self?.conn.choose(reason: "servers edited")
            })
            vc.present(a, animated: true)
        }

        private func topViewController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
            var vc = scene?.keyWindow?.rootViewController
            while let presented = vc?.presentedViewController { vc = presented }
            return vc
        }
    }
}

private extension UIWindowScene {
    var keyWindow: UIWindow? { windows.first { $0.isKeyWindow } ?? windows.first }
}
