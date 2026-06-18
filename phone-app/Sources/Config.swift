import Foundation

// Where the app points. Defaults are baked in, but BOTH are overridable at runtime from the
// in-app settings (long-press the screen) and stored in UserDefaults — so you can repoint the
// app at a new tunnel (Cloudflare) or, later, a cloud backend WITHOUT rebuilding. This is the
// first step off the hardcoded Tailscale URL.
enum Config {
    // SECURITY: never commit a live token here — this repo is PUBLIC. These defaults are blank;
    // build-ipa.sh injects the real host+token from ~/.bhatbot/config.json at BUILD time into the
    // (gitignored) .ipa only, and they're also overridable at runtime via the in-app long-press
    // settings. So the secret lives in the local binary + UserDefaults, never in git.
    static let defaultHost = ""
    static let defaultToken = ""

    static var host: String {
        let v = (UserDefaults.standard.string(forKey: "bb_host") ?? defaultHost)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return v.hasSuffix("/") ? String(v.dropLast()) : v
    }
    static var token: String {
        (UserDefaults.standard.string(forKey: "bb_token") ?? defaultToken)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func save(host: String, token: String) {
        UserDefaults.standard.set(host, forKey: "bb_host")
        UserDefaults.standard.set(token, forKey: "bb_token")
    }

    // The live UI the Mac serves (auto-updates on every push).
    static var remoteURL: URL { URL(string: "\(host)/app/\(token)")! }
    // JS injected before the page's own scripts so a bundled file:// page can reach the Mac.
    static var injectedConfigJS: String {
        let h = host.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let t = token.replacingOccurrences(of: "\"", with: "\\\"")
        return "window.__BHATBOT__ = { host: \"\(h)\", token: \"\(t)\" };"
    }
}
