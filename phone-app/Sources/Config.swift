import Foundation

// ── WHERE THE APP CONNECTS ───────────────────────────────────────────────────────────────────────
//
// Two doors, tried in order, re-chosen whenever the network changes or the app comes back:
//
//   1. THE MAC, DIRECT — its Tailscale Funnel host. Public HTTPS: the phone needs no VPN, works on
//      eduroam and cellular. Freshest UI, every capability, no middleman.
//   2. THE CLOUD (Fly) — always on, relays to the Mac over the cloud bridge when it can. Used when
//      the Mac is asleep or unreachable.
//
// Each door has ITS OWN token. The 25 Nov audit found the old single-host build pointed at the cloud
// with the Mac's token (cloud answered 401 to everything) — and the token itself was the unresolved
// CRED_REF placeholder from config.json. So the app was always on its offline copy.
//
// Secrets never live in git: build-ipa.sh / build-sim.sh write Sources/Secrets.swift (gitignored)
// from the Mac's vault. Everything is also editable in-app (long-press → Servers).
struct Endpoint: Equatable {
    let name: String      // "mac" | "cloud"
    let host: String
    let token: String
    var appURL: URL? { URL(string: "\(host)/app/\(token)") }
    var probeURL: URL? { URL(string: "\(host)/app/\(token)/version") }
    var usable: Bool { !host.isEmpty && !token.isEmpty && appURL != nil }
}

enum Config {
    private static func clean(_ s: String) -> String {
        let v = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return v.hasSuffix("/") ? String(v.dropLast()) : v
    }
    private static func stored(_ key: String, _ fallback: String) -> String {
        clean(UserDefaults.standard.string(forKey: key) ?? fallback)
    }

    static var mac: Endpoint { Endpoint(name: "mac", host: stored("bb_mac_host", Secrets.macHost), token: stored("bb_mac_token", Secrets.macToken)) }
    static var cloud: Endpoint { Endpoint(name: "cloud", host: stored("bb_cloud_host", Secrets.cloudHost), token: stored("bb_cloud_token", Secrets.cloudToken)) }
    /// In preference order. Only endpoints that have both a host and a token are tried.
    static var endpoints: [Endpoint] { [mac, cloud].filter { $0.usable } }

    static func save(mac: (String, String), cloud: (String, String)) {
        let d = UserDefaults.standard
        d.set(mac.0, forKey: "bb_mac_host"); d.set(mac.1, forKey: "bb_mac_token")
        d.set(cloud.0, forKey: "bb_cloud_host"); d.set(cloud.1, forKey: "bb_cloud_token")
    }
    static func resetToBuilt() {
        for k in ["bb_mac_host", "bb_mac_token", "bb_cloud_host", "bb_cloud_token", "bb_host", "bb_token"] { UserDefaults.standard.removeObject(forKey: k) }
    }

    /// Injected before the page's own scripts. The page talks to `host` with `token`; `route` tells it
    /// which door it came through so it can say so, and `alt` is the other door for its own retries.
    static func injectedJS(active: Endpoint?, bundled: Bool) -> String {
        func js(_ s: String) -> String { s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        let a = active ?? endpoints.first
        let alt = endpoints.first { $0 != a }
        var o = "{ host: \"\(js(a?.host ?? ""))\", token: \"\(js(a?.token ?? ""))\", route: \"\(bundled ? "offline" : (a?.name ?? "offline"))\", bundled: \(bundled ? "true" : "false")"
        if let alt = alt { o += ", alt: { name: \"\(alt.name)\", host: \"\(js(alt.host))\", token: \"\(js(alt.token))\" }" }
        o += " }"
        return "window.__BHATBOT__ = \(o);"
    }
}
