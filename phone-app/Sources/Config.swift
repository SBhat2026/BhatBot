import Foundation

// BhatBot phone app target. Content is served by the Mac over the Tailscale Funnel, so
// the app auto-updates with every push — you never rebuild the app to get UI changes.
// If your funnel host or token ever changes, edit this one line and rebuild once.
enum Config {
    static let url = URL(string: "https://siddhants-macbook-air.tail816be0.ts.net/app/ece52d3ac6ca1a5c491eb06e53251e555d7953aa84110ea7")!
}
