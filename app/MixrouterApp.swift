// MixrouterApp.swift — Mixrouter 的原生 macOS 外壳:用 WKWebView 把本地控制台包成桌面应用。
// 单文件(AppKit + WebKit),swiftc 直接编,见 scripts/build-app.sh,不依赖任何包管理器。
//
// 约定:服务常驻由 launchd / mixctl 负责,本应用只管"显示 + 遥控"。
// 启动先探 /healthz:已经在跑就绝不重启(用户当前会话正走这个代理,重启会打断)。
import AppKit
import WebKit

// 控制台地址;MIXROUTER_CONSOLE_URL 可覆盖(调试/换端口用,正常别动)。
private let consoleBase = ProcessInfo.processInfo.environment["MIXROUTER_CONSOLE_URL"] ?? "http://127.0.0.1:8788"
private let consoleURL = URL(string: consoleBase)!
private let healthURL = URL(string: consoleBase + "/healthz")!
private let frameAutosaveName: NSWindow.FrameAutosaveName = "MixrouterMainWindow"
private let ID = (reload: NSToolbarItem.Identifier("reload"),
                  restart: NSToolbarItem.Identifier("restart"),
                  logs: NSToolbarItem.Identifier("logs"))

/// 仓库根:运行时 MIXROUTER_REPO > 构建时烘进 Info.plist > 安装根的 current 链接。
/// **兜底不写死某个人的目录**:正常情况走第二条(构建脚本已把仓库根写进 Info.plist),
/// 兜底只在 Info.plist 缺失或被搬走时触发。它按 lib/paths.js 的安装布局拼出
/// `<安装根>/releases/current`(MIXR_INSTALL_PREFIX 可覆盖安装根)并原样返回;
/// `runMixctl` 会检查该目录下的 mixctl 是否存在,不存在就明说"找不到 mixctl"。
func repoRoot() -> String {
    if let e = ProcessInfo.processInfo.environment["MIXROUTER_REPO"], !e.isEmpty { return e }
    if let p = Bundle.main.object(forInfoDictionaryKey: "MixrouterRepoRoot") as? String, !p.isEmpty { return p }
    let home = NSHomeDirectory()
    let installRoot = ProcessInfo.processInfo.environment["MIXR_INSTALL_PREFIX"]
        ?? home + "/.local/share/mixrouter"
    return installRoot + "/releases/current"
}

/// node 不在 GUI 进程的 PATH 里(Finder 启动只有 /usr/bin:/bin…),按 launchd-run.sh 的路子自己找。
func findNode() -> String? {
    var paths: [String] = []
    if let p = ProcessInfo.processInfo.environment["PATH"] { paths += p.split(separator: ":").map { "\($0)/node" } }
    let nvm = NSHomeDirectory() + "/.nvm/versions/node"
    if let vers = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
        paths += vers.sorted().reversed().map { "\(nvm)/\($0)/bin/node" }
    }
    return (paths + ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"])
        .first { FileManager.default.isExecutableFile(atPath: $0) }
}

func escapeHTML(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
}

@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, NSToolbarDelegate {
    static var current: AppDelegate?          // NSApp.delegate 是 weak,这里留个强引用
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem?      // 菜单栏常驻图标(见 buildStatusItem)
    private var pollTimer: Timer?
    private var healthy = false
    private var booting = false
    private var bootLog = ""

    static func main() {
        let app = NSApplication.shared
        current = AppDelegate()
        app.delegate = current
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildStatusItem()
        buildWindow()
        showStatusPage(title: "正在检查本地服务…", detail: "GET \(healthURL.absoluteString)")
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.poll() }
        NSApp.activate(ignoringOtherApps: true)
    }

    // 关掉窗口 ≠ 退出:界面收起后进程留在后台(菜单栏图标还在),服务本来就由 launchd /
    // mixctl 独立托管,不受影响。真要结束走菜单「退出 Mixrouter」或 ⌘Q。
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    /// 点 Dock 图标(此时没有可见窗口)把主窗口叫回来
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    private func showWindow() {
        if window == nil { buildWindow(); return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 菜单栏常驻图标:窗口关掉之后仍能一眼看到服务状态、随手叫回界面或退出。
    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            let img = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: "Mixrouter")
            img?.isTemplate = true                                  // 模板图:跟随菜单栏明暗
            button.image = img
            button.toolTip = "Mixrouter · 检查中…"
        }
        let menu = NSMenu()
        menu.addItem(withTitle: "显示主窗口", action: #selector(showMainWindow(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "重载控制台", action: #selector(reloadConsole(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "重启本地服务…", action: #selector(restartService(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "打开日志文件夹", action: #selector(openLogs(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Mixrouter", action: #selector(quitApp(_:)), keyEquivalent: "")
        for mi in menu.items where mi.action != nil { mi.target = self }
        item.menu = menu
        statusItem = item
    }

    @objc func showMainWindow(_ sender: Any?) { showWindow() }
    @objc func quitApp(_ sender: Any?) { NSApp.terminate(nil) }

    /// 标题栏副标题与菜单栏 tooltip 一起更新,免得状态两处各说各的
    private func setStatus(_ text: String) {
        window.subtitle = text
        statusItem?.button?.toolTip = "Mixrouter · " + text
    }

    func applicationWillTerminate(_ note: Notification) { pollTimer?.invalidate() }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Mixrouter"
        window.subtitle = "检查中…"
        window.minSize = NSSize(width: 640, height: 420)
        window.delegate = self
        // 关窗后进程还活着,窗口对象必须一起留着:程序化创建的窗口默认随关随释放,
        // 那样再从菜单栏/Dock 叫回来就是个悬空引用
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName(frameAutosaveName)                      // 记住上次位置大小
        if !window.setFrameUsingName(frameAutosaveName) { window.center() }

        webView = WKWebView(frame: window.contentView!.bounds, configuration: WKWebViewConfiguration())
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView!.addSubview(webView)

        let toolbar = NSToolbar(identifier: "MixrouterToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconAndLabel
        toolbar.allowsUserCustomization = false
        (window.toolbar, window.toolbarStyle) = (toolbar, .unified)
        window.makeKeyAndOrderFront(nil)
    }

    private func statusText() -> String {
        if booting { return "正在启动服务…" }
        return healthy ? "运行中 · \(consoleBase.replacingOccurrences(of: "http://", with: ""))" : "未运行"
    }

    private func checkHealth(_ done: @escaping (Bool) -> Void) {
        let req = URLRequest(url: healthURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    private func poll() {                             // 轮询只更新标题栏状态,不动页面内容
        checkHealth { ok in
            guard ok != self.healthy else { return }
            self.healthy = ok
            self.setStatus(self.statusText())
        }
    }

    /// 探活 → 已经在跑就只加载页面(绝不重启);探不到才 mixctl start,等就绪再加载。
    private func refresh() {
        checkHealth { ok in
            self.healthy = ok
            self.setStatus(self.statusText())
            if ok { self.loadConsole() } else { self.bootService() }
        }
    }

    private func bootService() {
        guard !booting else { return }
        booting = true
        bootLog = ""
        setStatus(statusText())
        showStatusPage(title: "本地服务未运行", detail: "正在执行  ./mixctl start …")
        runMixctl(["start"]) { _, out in
            self.bootLog = out
            self.waitForHealth(deadline: Date().addingTimeInterval(25), delay: 0.5)
        }
    }

    private func waitForHealth(deadline: Date, delay: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            self.checkHealth { ok in
                if !ok && Date() <= deadline { return self.waitForHealth(deadline: deadline, delay: 0.5) }
                self.booting = false
                self.healthy = ok
                self.setStatus(self.statusText())
                // 起来了 → 显示控制台;超时 → 把 mixctl 的原话摆出来,别让人猜
                if ok { self.loadConsole() } else {
                    self.showStatusPage(title: "服务没能起来", detail: self.bootLog.isEmpty
                                        ? "拿不到 /healthz 响应。看日志:logs/server.log" : self.bootLog)
                }
            }
        }
    }

    private func loadConsole() {
        webView.load(URLRequest(url: consoleURL, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 15))
    }

    /// 跑 <node> <repo>/mixctl <args>(cwd = 仓库根),完成后回主线程回调 (退出码, 输出)。
    private func runMixctl(_ args: [String], _ done: @escaping (Int32, String) -> Void) {
        let root = repoRoot()
        let mixctl = root + "/mixctl"
        guard FileManager.default.fileExists(atPath: mixctl) else { return done(-1, "找不到 \(mixctl)") }
        let proc = Process()
        var env = ProcessInfo.processInfo.environment
        if let node = findNode() {
            proc.executableURL = URL(fileURLWithPath: node)
            proc.arguments = [mixctl] + args
            env["PATH"] = (node as NSString).deletingLastPathComponent + ":" + (env["PATH"] ?? "/usr/bin:/bin")
        } else {                                        // 兜底:交给 env 去找 node
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", mixctl] + args
        }
        proc.currentDirectoryURL = URL(fileURLWithPath: root)
        proc.environment = env
        let pipe = Pipe()
        (proc.standardOutput, proc.standardError) = (pipe, pipe)
        proc.terminationHandler = { p in
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async { done(p.terminationStatus, out) }
        }
        do { try proc.run() } catch { done(-1, "启动 mixctl 失败:\(error.localizedDescription)") }
    }

    @objc func reloadConsole(_ sender: Any?) { refresh() }   // 顺带当"重试"用

    @objc func restartService(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "重启本地服务?"
        alert.informativeText = """
        会短暂中断代理:正在跑的 Claude Code / Codex 会话会断线。
        重启的只是 mixrouter 服务,不影响本窗口。
        """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "重启")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        booting = true
        bootLog = ""
        setStatus(statusText())
        showStatusPage(title: "正在重启本地服务…", detail: "./mixctl restart")
        runMixctl(["restart"]) { _, out in
            self.bootLog = out
            // 给 stop→start 留出切换时间,否则第一次探活还会打到旧进程
            self.waitForHealth(deadline: Date().addingTimeInterval(25), delay: 1.5)
        }
    }

    @objc func openLogs(_ sender: Any?) {
        let dir = URL(fileURLWithPath: repoRoot() + "/logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)          // 只在 Finder 里打开,不碰浏览器
    }

    private func showStatusPage(title: String, detail: String) {
        webView.loadHTMLString("""
        <!doctype html><meta charset="utf-8"><title>Mixrouter</title>
        <style>
          :root { color-scheme: light dark; }
          body { font: 15px/1.6 -apple-system, system-ui; margin: 0; min-height: 100vh; display: flex;
                 align-items: center; justify-content: center; }
          .box { max-width: 34rem; padding: 2rem; }
          h1 { font-size: 1.15rem; margin: 0 0 .6rem; }
          pre { white-space: pre-wrap; word-break: break-all; font-size: .78rem; opacity: .75; padding: .75rem;
                border-radius: 6px; background: color-mix(in srgb, currentColor 8%, transparent); }
          p { opacity: .75; margin: .4rem 0 0; }
        </style>
        <div class="box"><h1>\(escapeHTML(title))</h1>
        <pre>\(escapeHTML(detail))</pre>
        <p>⌘R 重试 · 菜单「控制台」里有重启服务与打开日志</p></div>
        """, baseURL: nil)
    }

    /// 一行一个菜单项:"-" 是分隔线;selector 以 "chain:" 开头就走响应链(NSApp / 网页),其余发给本 delegate。
    private func makeMenu(_ title: String, _ rows: [(String, String, String)]) -> NSMenuItem {
        let item = NSMenuItem()
        let menu = NSMenu(title: title)
        for (title, sel, key) in rows {
            if title == "-" { menu.addItem(.separator()); continue }
            let viaChain = sel.hasPrefix("chain:")
            let mi = NSMenuItem(title: title,
                                action: NSSelectorFromString(viaChain ? String(sel.dropFirst(6)) : sel),
                                keyEquivalent: key)
            mi.target = viaChain ? nil : self
            menu.addItem(mi)
        }
        item.submenu = menu
        return item
    }

    private func buildMenu() {
        let mainMenu = NSMenu()
        mainMenu.addItem(makeMenu("Mixrouter", [
            ("关于 Mixrouter", "chain:orderFrontStandardAboutPanel:", ""),
            ("-", "", ""),
            ("隐藏 Mixrouter", "chain:hide:", "h"),
            ("-", "", ""),
            ("退出 Mixrouter", "chain:terminate:", "q"),
        ]))
        mainMenu.addItem(makeMenu("控制台", [
            ("重载控制台", "reloadConsole:", "r"),
            ("重启本地服务…", "restartService:", "R"),
            ("-", "", ""),
            ("打开日志文件夹", "openLogs:", "l"),
        ]))
        // 网页里要能复制 key / 日志,标准的编辑菜单不能省
        mainMenu.addItem(makeMenu("编辑", [
            ("撤销", "chain:undo:", "z"),
            ("重做", "chain:redo:", "Z"),
            ("-", "", ""),
            ("剪切", "chain:cut:", "x"),
            ("拷贝", "chain:copy:", "c"),
            ("粘贴", "chain:paste:", "v"),
            ("全选", "chain:selectAll:", "a"),
        ]))
        let windowMenu = makeMenu("窗口", [
            ("最小化", "chain:performMiniaturize:", "m"),
            ("缩放", "chain:performZoom:", ""),
        ])
        mainMenu.addItem(windowMenu)
        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu.submenu
    }

    func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [ID.reload, ID.restart, ID.logs] }
    func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(t) }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let spec: (String, String, Selector) = id == ID.reload ? ("重载", "arrow.clockwise", #selector(reloadConsole(_:)))
            : id == ID.restart ? ("重启服务", "arrow.triangle.2.circlepath", #selector(restartService(_:)))
            : ("日志", "folder", #selector(openLogs(_:)))
        let item = NSToolbarItem(itemIdentifier: id)
        item.label = spec.0
        item.paletteLabel = spec.0
        item.image = NSImage(systemSymbolName: spec.1, accessibilityDescription: spec.0)
        item.target = self
        item.action = spec.2
        item.isBordered = true
        return item
    }
}
