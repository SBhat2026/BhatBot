import SwiftUI
import WebKit

@main
struct BhatBotApp: App {
    var body: some Scene {
        WindowGroup {
            WebRoot()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
        }
    }
}

// Full-screen WKWebView pointing at the Mac's funnel URL. Because the page is served by
// the Mac, every push lands automatically — pull down to refresh, or just background and
// reopen the app (it reloads on foreground). Mic/camera are auto-granted (your own app).
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

        NotificationCenter.default.addObserver(context.coordinator,
            selector: #selector(Coordinator.foreground),
            name: UIApplication.willEnterForegroundNotification, object: nil)

        web.load(URLRequest(url: Config.url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate {
        weak var web: WKWebView?

        @objc func pull(_ rc: UIRefreshControl) { web?.reloadFromOrigin(); rc.endRefreshing() }

        // Reload on return to foreground so the latest push is shown without a manual refresh.
        @objc func foreground() {
            guard let web = web else { return }
            if web.url == nil { web.load(URLRequest(url: Config.url)) } else { web.reload() }
        }

        // Auto-grant mic/camera — it's the user's own app talking to their own Mac.
        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.grant)
        }

        // If the Mac is briefly unreachable, retry shortly instead of showing a dead page.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retry() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retry() }
        private func retry() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.web?.load(URLRequest(url: Config.url))
            }
        }
    }
}
