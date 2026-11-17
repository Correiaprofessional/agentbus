import Cocoa

/// Menu bar face for agentbus: shows how many agents are talking, opens the
/// board, and starts or stops the daemon. No dock icon (LSUIElement).
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let statusLine = NSMenuItem(title: "starting…", action: nil, keyEquivalent: "")
    private let openItem = NSMenuItem(title: "Open board", action: nil, keyEquivalent: "o")
    private let copyItem = NSMenuItem(title: "Copy board URL", action: nil, keyEquivalent: "c")
    private let startItem = NSMenuItem(title: "Start daemon", action: nil, keyEquivalent: "")
    private let stopItem = NSMenuItem(title: "Stop daemon", action: nil, keyEquivalent: "")
    private let updateItem = NSMenuItem(title: "Update agentbus", action: nil, keyEquivalent: "u")
    private var timer: Timer?
    private var port: Int?
    private var token: String?

    /// <repo>/desktop/AgentBus.app → <repo>
    private var root: URL {
        Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
    }

    /// The CLI next to the bundle, else whatever `agentbus` is on PATH.
    private var binPath: String {
        let local = root.appendingPathComponent("bin/agentbus.js").path
        if FileManager.default.fileExists(atPath: local) { return local }
        if let override = ProcessInfo.processInfo.environment["AGENTBUS_BIN"],
           FileManager.default.fileExists(atPath: override) {
            return override
        }
        let searchPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        for directory in searchPath.split(separator: ":") {
            let candidate = "\(directory)/agentbus"
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return local
    }

    /** True when the resolved CLI is a node script rather than an executable. */
    private var binIsScript: Bool { binPath.hasSuffix(".js") }

    private var stateDir: String {
        ProcessInfo.processInfo.environment["AGENTBUS_HOME"]
            ?? (NSHomeDirectory() + "/.agentbus")
    }

    private var boardURL: URL? {
        guard let port, let token else { return nil }
        return URL(string: "http://127.0.0.1:\(port)/?t=\(token)")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            button.image = menuBarImage()
            button.imagePosition = .imageLeading
            button.toolTip = "agentbus — agents working in this project"
        }

        statusLine.isEnabled = false
        openItem.target = self
        openItem.action = #selector(openBoard)
        copyItem.target = self
        copyItem.action = #selector(copyBoardURL)
        startItem.target = self
        startItem.action = #selector(startDaemon)
        stopItem.target = self
        stopItem.action = #selector(stopDaemon)
        updateItem.target = self
        updateItem.action = #selector(updateAgentbus)

        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(openItem)
        menu.addItem(copyItem)
        menu.addItem(.separator())
        menu.addItem(startItem)
        menu.addItem(stopItem)
        menu.addItem(.separator())
        menu.addItem(updateItem)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit agentbus", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)

        statusItem.menu = menu

        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        timer?.tolerance = 1.0
        RunLoop.main.add(timer!, forMode: .common)

        refresh()
    }

    /// Template images are tinted by macOS, so one asset works in light and dark.
    private func menuBarImage() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "MenuBarTemplate", withExtension: "png"),
              let image = NSImage(contentsOf: url) else {
            return NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted",
                           accessibilityDescription: "agentbus")
        }
        image.isTemplate = true
        image.size = NSSize(width: 18, height: 18)
        return image
    }

    private func readDaemonInfo() -> (port: Int, token: String)? {
        let path = stateDir + "/daemon.json"
        guard let data = FileManager.default.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = object["port"] as? Int,
              let token = object["token"] as? String
        else { return nil }
        return (port, token)
    }

    private func refresh() {
        guard FileManager.default.fileExists(atPath: binPath) else {
            setStopped(reason: "agentbus not found next to the app")
            return
        }
        guard let info = readDaemonInfo() else {
            setStopped(reason: "daemon stopped")
            return
        }

        port = info.port
        token = info.token

        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(info.port)/api/overview")!)
        request.setValue(info.token, forHTTPHeaderField: "x-agentbus-token")
        request.timeoutInterval = 2

        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self else { return }
            guard let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                DispatchQueue.main.async { self.setStopped(reason: "daemon not answering") }
                return
            }
            let agents = object["totalActive"] as? Int ?? 0
            let peers = (object["peers"] as? [Any])?.count ?? 0
            let others = (object["otherProjects"] as? [Any])?.count ?? 0
            let running = (object["running"] as? [Any])?.count ?? 0
            let project = (object["project"] as? [String: Any])?["name"] as? String

            DispatchQueue.main.async {
                self.setRunning(agents: agents, peers: peers, projects: others + 1, running: running, project: project)
            }
        }.resume()
    }

    private func setRunning(agents: Int, peers: Int, projects: Int, running: Int, project: String?) {
        let where_ = project ?? "no project"
        statusLine.title = "\(agents) on the board · \(peers) here · \(projects) project(s)"
        openItem.isEnabled = true
        copyItem.isEnabled = boardURL != nil
        startItem.isEnabled = false
        stopItem.isEnabled = true
        updateItem.isEnabled = true
        statusItem.button?.title = agents > 0 ? " \(agents)" : ""
        statusItem.button?.toolTip = running > 0
            ? "agentbus — \(agents) on the board, \(running) running · \(where_)"
            : "agentbus — \(agents) on the board · \(where_)"
    }

    private func setStopped(reason: String) {
        port = nil
        token = nil
        statusLine.title = reason
        openItem.isEnabled = false
        copyItem.isEnabled = false
        startItem.isEnabled = FileManager.default.fileExists(atPath: binPath)
        stopItem.isEnabled = false
        updateItem.isEnabled = FileManager.default.fileExists(atPath: binPath)
        statusItem.button?.title = ""
        statusItem.button?.toolTip = "agentbus — \(reason)"
    }

    private func run(_ arguments: [String], completion: (() -> Void)? = nil) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = (binIsScript ? ["node", binPath] : [binPath]) + arguments
        process.currentDirectoryURL = root
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { completion?() }
        }
        do {
            try process.run()
        } catch {
            completion?()
        }
    }

    /** Like run(), but hands the command's output to the menu bar. */
    private func runCapturing(_ arguments: [String], completion: @escaping (String) -> Void) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = (binIsScript ? ["node", binPath] : [binPath]) + arguments
        process.currentDirectoryURL = root
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.terminationHandler = { _ in
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async { completion(text) }
        }
        do {
            try process.run()
        } catch {
            completion("cannot run \(binPath)")
        }
    }

    @objc private func openBoard() {
        guard let url = boardURL else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func copyBoardURL() {
        guard let url = boardURL else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(url.absoluteString, forType: .string)
    }

    @objc private func startDaemon() {
        setStopped(reason: "starting…")
        run(["start"]) { [weak self] in self?.refresh() }
    }

    @objc private func stopDaemon() {
        run(["stop"]) { [weak self] in self?.refresh() }
    }

    /// Pull a newer agentbus. The CLI restarts the daemon and rebuilds this app;
    /// the menu reports what it said, so the next launch is the new build.
    @objc private func updateAgentbus() {
        updateItem.isEnabled = false
        statusLine.title = "checking for updates…"
        runCapturing(["update"]) { [weak self] output in
            guard let self else { return }
            let lines = output.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
            if let first = lines.first {
                self.statusLine.title = first
                if lines.count > 1 { self.statusItem.button?.toolTip = output }
            }
            self.updateItem.isEnabled = true
            self.refresh()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
