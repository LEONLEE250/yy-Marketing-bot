# -*- coding: utf-8 -*-
"""
UIA 控件树扫描器 — 用于分析微信朋友圈页面的控件结构
运行: python scan_wechat_uia.py
输出: wechat_uia_tree.txt (控件树)
"""

import sys, os, time, json

def log(msg):
    print(msg, file=sys.stderr, flush=True)

def find_wechat():
    import win32gui, win32process, psutil
    results = []
    def _e(hwnd, _):
        try:
            if not win32gui.IsWindowVisible(hwnd): return
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            pname = psutil.Process(pid).name().lower()
            if 'wechat' not in pname and 'weixin' not in pname: return
            r = win32gui.GetWindowRect(hwnd)
            w, h = r[2]-r[0], r[3]-r[1]
            if w < 400 or h < 300: return
            results.append({"hwnd": hwnd, "rect": r, "w": w, "h": h})
        except: pass
    win32gui.EnumWindows(_e, None)
    if not results: raise RuntimeError("未找到微信窗口")
    results.sort(key=lambda x: x["w"]*x["h"], reverse=True)
    return results[0]

def dump_tree(ctrl, depth=0, max_depth=4, file=None):
    indent = "  " * depth
    try:
        name = ctrl.window_text() or "(无文字)"
        ctype = "?"
        try:
            ctype = ctrl.element_info.control_type
        except: pass
        aid = ""
        try:
            aid = ctrl.element_info.automation_id
        except: pass
        cls = ""
        try:
            cls = ctrl.element_info.class_name
        except: pass
        rect = None
        try:
            r = ctrl.rectangle()
            rect = f"({r.left},{r.top},{r.right},{r.bottom})"
        except: pass

        line = f"{indent}[{ctype}] name={name!r} auto_id={aid!r} class={cls!r} rect={rect}"
        print(line)
        if file: file.write(line + "\n")

        if depth < max_depth:
            for child in ctrl.children():
                dump_tree(child, depth + 1, max_depth, file)
    except Exception as e:
        line = f"{indent}ERR: {e}"
        print(line)
        if file: file.write(line + "\n")


def main():
    from pywinauto import Application
    import pyautogui

    wx_info = find_wechat()
    log(f"微信: hwnd={wx_info['hwnd']} size={wx_info['w']}x{wx_info['h']}")

    app = Application(backend="uia").connect(handle=wx_info["hwnd"])
    win = app.window(handle=wx_info["hwnd"])
    win.set_focus()
    time.sleep(0.3)

    # ── 先进入朋友圈页面 ──
    pyautogui.hotkey('ctrl', '3')
    time.sleep(1.0)
    log("Ctrl+3 sent, scanning discover page...")

    with open("wechat_uia_tree.txt", "w", encoding="utf-8") as f:
        f.write("=== 发现页 ===\n")
        dump_tree(win, 0, 4, f)

    # 点击朋友圈入口
    log("Clicking 朋友圈 entry...")
    try:
        btn = win.child_window(title="朋友圈", control_type="ListItem")
        btn.click_input()
    except:
        # fallback: click center
        x, y = wx_info["rect"][0], wx_info["rect"][1]
        pyautogui.click(x + wx_info["w"] // 2, y + int(wx_info["h"] * 0.11))
    time.sleep(2.0)

    # ── 扫描朋友圈页面 ──
    log("Scanning moments page...")
    with open("wechat_uia_tree.txt", "a", encoding="utf-8") as f:
        f.write("\n=== 朋友圈页面 ===\n")
        dump_tree(win, 0, 4, f)

    log(f"Done! Output: {os.path.abspath('wechat_uia_tree.txt')}")
    print(json.dumps({"success": True, "message": "UIA tree saved to wechat_uia_tree.txt"}), flush=True)


if __name__ == '__main__':
    main()
