import AppKit
import ApplicationServices

func output(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
func fail(_ message: String) -> Never { output(["error": message]); exit(1) }
let input = try! JSONSerialization.jsonObject(with: CommandLine.arguments[1].data(using: .utf8)!) as! [String: Any]
let action = input["action"] as! String
let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.electron.lark").first
if action == "status" { output(["accessibility": AXIsProcessTrusted(), "running": app != nil]); exit(0) }
if action == "open" {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-b", "com.electron.lark"]
    try p.run(); p.waitUntilExit()
    if p.terminationStatus != 0 { fail("FEISHU_NOT_INSTALLED") }
    output(["opened": true]); exit(0)
}
guard AXIsProcessTrusted() else { fail("ACCESSIBILITY_REQUIRED") }
guard let app = app else { fail("FEISHU_NOT_RUNNING") }
let root = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(root, 1)
AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &v) == .success ? v : nil
}
func text(_ element: AXUIElement, _ name: String) -> String { String(String(describing: value(element, name) ?? "" as CFString).prefix(1500)) }
func children(_ element: AXUIElement, _ name: String = "AXChildren") -> [AXUIElement] { value(element, name) as? [AXUIElement] ?? [] }
let windows = children(root, "AXWindows")
if action == "inspect" {
    var nodes: [[String: Any]] = []; var visited = 0
    var queue = windows.enumerated().map { ($0.element, String($0.offset), 0) }
    while visited < queue.count && visited < 2000 {
        let (element, id, depth) = queue[visited]; visited += 1
        let role = text(element, "AXRole"), name = text(element, "AXTitle"), desc = text(element, "AXDescription"), val = text(element, "AXValue")
        if role != "AXGroup" || !name.isEmpty || !desc.isEmpty || !val.isEmpty {
            nodes.append(["id": id, "role": role, "name": name, "description": desc, "value": val,
                          "focused": (value(element, "AXFocused") as? Bool) ?? false,
                          "enabled": (value(element, "AXEnabled") as? Bool) ?? true])
        }
        if depth < 60 && queue.count < 5000 {
            for (index, child) in children(element).enumerated() { queue.append((child, id + "/" + String(index), depth + 1)) }
        }
    }
    output(["frontmost": app.isActive, "nodes": nodes, "truncated": visited < queue.count]); exit(0)
}
guard app.isActive else { fail("FEISHU_NOT_FRONTMOST") }
if action == "key" {
    let keys: [String: CGKeyCode] = ["enter":36, "escape":53, "tab":48, "down":125, "up":126, "search":40]
    let key = input["key"] as? String ?? ""
    guard let code = keys[key] else { fail("INVALID_KEY") }
    for down in [true, false] {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
        if key == "search" { event.flags = .maskCommand }
        event.postToPid(app.processIdentifier)
    }
} else {
    let parts = (input["element_id"] as? String ?? "").split(separator: "/").compactMap { Int($0) }
    guard let first = parts.first, windows.indices.contains(first) else { fail("STALE_ELEMENT") }
    var element = windows[first]
    for index in parts.dropFirst() {
        let list = children(element); guard list.indices.contains(index) else { fail("STALE_ELEMENT") }; element = list[index]
    }
    if action == "press" {
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { fail("ELEMENT_NOT_PRESSABLE") }
    } else if action == "set_text" {
        let text = input["text"] as? String ?? ""
        guard ["AXTextArea", "AXTextField", "AXComboBox"].contains(String(describing: value(element, "AXRole") ?? "" as CFString)) else { fail("ELEMENT_NOT_EDITABLE") }
        if AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString) != .success {
            AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard (value(element, "AXFocused") as? Bool) == true else { fail("ELEMENT_NOT_FOCUSED") }
            // Chromium contenteditable controls may reject AXValue. Send Unicode only
            // to the verified focused editor in Feishu, without using the clipboard.
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)!
                event.flags = .maskCommand; event.postToPid(app.processIdentifier)
            }
            usleep(50000)
            let units = Array(text.utf16)
            for start in stride(from: 0, to: units.count, by: 20) {
                let chunk = Array(units[start..<min(start + 20, units.count)])
                for down in [true, false] {
                    let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)!
                    event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                    event.postToPid(app.processIdentifier)
                }
            }
        }
    } else { fail("INVALID_ACTION") }
}
output(["performed": true, "delivery_verified": false])
