import SwiftUI
import WebKit
import AVFoundation

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

// CRITICAL for voice: WKWebView's Web Audio (the AudioContext the page uses for TTS) plays
// through the app's AVAudioSession. The default category is silenced by the hardware ring/
// silent switch — so the cloud's audio arrives fine but you hear nothing. .playAndRecord with
// .defaultToSpeaker plays LOUD through the speaker (ignores the mute switch) while still letting
// the mic record for hands-free. .spokenAudio + .duckOthers = nice for a voice assistant.
enum AudioSession {
    static func configure() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .spokenAudio,
                           options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .duckOthers])
        try? s.setActive(true, options: [])
    }
}

// Full-screen WKWebView. Primary load = the live UI the Mac serves (auto-updates on every
// push). If the Mac is unreachable (asleep / off Tailscale), it falls back to a BUNDLED copy
// of the UI so the app still OPENS instead of showing a dead page — the first step toward an
// app that doesn't depend on the Mac being awake. Host + token are configurable at runtime
// (long-press) and injected as window.__BHATBOT__ so the page targets the Mac by absolute URL.
struct WebRoot: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsAirPlayForMediaPlayback = true

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = context.coordinator
        web.navigationDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.035, green: 0.05, blue: 0.075, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.scrollView.bounces = true
        web.allowsBackForwardNavigationGestures = false
        context.coordinator.web = web

        let refresh = UIRefreshControl()
        refresh.tintColor = UIColor(red: 0.224, green: 0.843, blue: 1.0, alpha: 1)
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pull(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh

        // Long-press anywhere → settings (server host + token), so you can repoint the app at a
        // new tunnel/backend without a rebuild.
        let lp = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.longPress(_:)))
        lp.minimumPressDuration = 0.8
        web.addGestureRecognizer(lp)

        NotificationCenter.default.addObserver(context.coordinator,
            selector: #selector(Coordinator.foreground),
            name: UIApplication.willEnterForegroundNotification, object: nil)

        context.coordinator.loadRemote()
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate {
        weak var web: WKWebView?
        private var usingFallback = false

        // Self-updating offline cache: the last UI we successfully loaded from the cloud, saved to
        // disk. This decouples the OFFLINE path from the .ipa too — when the cloud is unreachable we
        // serve the latest deployed UI we've seen, not the (possibly months-old) build-time bundle.
        // Net effect: rebuilding the .ipa is only ever needed for NATIVE (Swift) changes, never UI.
        private var cachedURL: URL {
            FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("mobile-cached.html")
        }

        // Re-inject the current host/token (config can change at runtime) before each load.
        private func applyConfigScript() {
            guard let web = web else { return }
            let ucc = web.configuration.userContentController
            ucc.removeAllUserScripts()
            let s = WKUserScript(source: Config.injectedConfigJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            ucc.addUserScript(s)
        }

        func loadRemote() {
            guard let web = web else { return }
            usingFallback = false
            applyConfigScript()
            web.load(URLRequest(url: Config.remoteURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12))
        }

        // Offline UI — always opens even with the cloud/Mac down. Prefer the self-updating cache
        // (latest deployed UI we've seen); fall back to the build-time bundle only if nothing cached.
        func loadFallback() {
            guard let web = web, !usingFallback else { return }
            usingFallback = true
            applyConfigScript()
            let fm = FileManager.default
            if fm.fileExists(atPath: cachedURL.path) {
                web.loadFileURL(cachedURL, allowingReadAccessTo: cachedURL.deletingLastPathComponent())
            } else if let url = Bundle.main.url(forResource: "mobile", withExtension: "html") {
                web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            }
        }

        // After a successful live load, snapshot the served HTML to the offline cache. The cloud's
        // /app/:token accepts the path token, so a plain GET returns the same UI the WebView rendered.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !usingFallback else { return }
            URLSession.shared.dataTask(with: Config.remoteURL) { [weak self] data, _, _ in
                guard let self = self, let data = data, data.count > 1000 else { return }
                try? data.write(to: self.cachedURL, options: .atomic)
            }.resume()
        }

        @objc func pull(_ rc: UIRefreshControl) { loadRemote(); rc.endRefreshing() }

        // On return to foreground, re-arm audio (iOS can deactivate the session in background)
        // and try the live UI again (the Mac / cloud may have come back).
        @objc func foreground() { AudioSession.configure(); loadRemote() }

        // Mic/camera auto-grant — the user's own app talking to their own Mac.
        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.grant)
        }

        // Mac unreachable → drop to the bundled UI instead of a dead page.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loadFallback() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loadFallback() }

        // ---- Settings sheet (host + token) ----
        @objc func longPress(_ g: UILongPressGestureRecognizer) {
            guard g.state == .began, let vc = topViewController() else { return }
            let a = UIAlertController(title: "BhatBot server",
                message: "Where the app connects. Change this to point at a new tunnel or backend.",
                preferredStyle: .alert)
            a.addTextField { tf in
                tf.placeholder = "https://host"; tf.text = Config.host
                tf.autocapitalizationType = .none; tf.autocorrectionType = .no; tf.keyboardType = .URL
            }
            a.addTextField { tf in
                tf.placeholder = "token"; tf.text = Config.token
                tf.autocapitalizationType = .none; tf.autocorrectionType = .no
            }
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
            a.addAction(UIAlertAction(title: "Reset", style: .destructive) { [weak self] _ in
                Config.save(host: Config.defaultHost, token: Config.defaultToken); self?.loadRemote()
            })
            a.addAction(UIAlertAction(title: "Save", style: .default) { [weak self] _ in
                let h = a.textFields?.first?.text ?? ""
                let t = a.textFields?.last?.text ?? ""
                if !h.isEmpty && !t.isEmpty { Config.save(host: h, token: t) }
                self?.loadRemote()
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
