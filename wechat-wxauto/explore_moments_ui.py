"""
逆向微信朋友圈 UI 元素结构 — 探索脚本
运行方式：python explore_moments_ui.py
前提：微信已打开，并手动切换到「朋友圈」页面
"""
import sys
import os
import time
import json
import pythoncom

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wxauto_service import _inspect_wechat_windows

pythoncom.CoInitialize()

def explore_moments():
    """遍历当前微信窗口的 UIA 树，重点找朋友圈相关元素"""
    import win32con
    import win32gui
    from wxauto4.uia import uiautomation as auto

    info = _inspect_wechat_windows()
    if not info.get("ok"):
        print("微信窗口检测失败:", info.get("error"))
        return

    windows = info.get("windows", [])
    candidates = [
        w for w in windows
        if w.get("visible")
        and w.get("width", 0) > 300
        and w.get("height", 0) > 300
        and w.get("class") in ("Qt51514QWindowIcon", "mmui::MainWindow", "Chrome_WidgetWin_0")
        and w.get("title") not in ("WxTrayIconMessageWindow",)
    ]
    if not candidates:
        print("未找到微信主窗口，请确认微信已打开")
        return

    candidates.sort(key=lambda w: (w.get("width", 0) * w.get("height", 0)), reverse=True)
    hwnd = candidates[0]["hwnd"]
    print(f"微信 主窗口: hwnd={hwnd}, title={candidates[0]['title']}, size={candidates[0]['width']}x{candidates[0]['height']}")

    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
    time.sleep(0.8)

    root = auto.ControlFromHandle(hwnd)

    # 收集所有元素
    all_controls = []
    for control, depth in auto.WalkControl(root, includeTop=True, maxDepth=25):
        item = {
            "depth": depth,
        }
        try:
            item["ControlType"] = str(control.ControlType) if control.ControlType else ""
            item["ControlTypeName"] = control.ControlTypeName if control.ControlTypeName else ""
        except:
            pass
        try:
            item["ClassName"] = str(control.ClassName) if control.ClassName else ""
        except:
            pass
        try:
            item["Name"] = str(control.Name) if control.Name else ""
        except:
            pass
        try:
            item["AutomationId"] = str(control.AutomationId) if control.AutomationId else ""
        except:
            pass
        try:
            rect = control.BoundingRectangle
            item["Rect"] = f"{int(rect.left)},{int(rect.top)}-{int(rect.right)},{int(rect.bottom)}"
        except:
            pass
        try:
            item["IsEnabled"] = control.IsEnabled
        except:
            pass
        try:
            item["IsOffscreen"] = control.IsOffscreen
        except:
            pass
        all_controls.append(item)

    # 输出关键元素
    print(f"\n=== 总元素数: {len(all_controls)} ===\n")

    # Tab 栏
    print("=== Tab 栏元素 (mmui::XTabBar) ===")
    for c in all_controls:
        if "XTabBar" in c.get("ClassName", "") or "Tab" in c.get("ClassName", ""):
            print(f"  depth={c['depth']} | Class={c['ClassName']} | Name={c['Name']} | Rect={c.get('Rect','')}")

    print("\n=== 朋友圈相关元素 ===")
    keywords = ["朋友圈", "moment", "相机", "camera", "发表", "publish", "sns", "timeline", "发现"]
    for c in all_controls:
        name = c.get("Name", "").lower()
        cls = c.get("ClassName", "").lower()
        aid = c.get("AutomationId", "").lower()
        combined = name + cls + aid
        if any(kw in combined for kw in keywords):
            print(f"  depth={c['depth']} | Class={c['ClassName']} | Name={c['Name']} | AutoId={c['AutomationId']} | Rect={c.get('Rect','')}")

    print("\n=== 按钮元素 ===")
    for c in all_controls:
        if "Button" in c.get("ControlTypeName", "") or "button" in c.get("ClassName", "").lower():
            print(f"  depth={c['depth']} | Class={c['ClassName']} | Name={c['Name']} | Enabled={c.get('IsEnabled','')} | Rect={c.get('Rect','')}")

    print("\n=== 编辑框元素 ===")
    for c in all_controls:
        if "Edit" in c.get("ControlTypeName", "") or "textedit" in c.get("ClassName", "").lower() or "richedit" in c.get("ClassName", "").lower():
            print(f"  depth={c['depth']} | Class={c['ClassName']} | Name={c['Name']} | Rect={c.get('Rect','')}")

    # 存完整 JSON
    out_path = os.path.join(os.path.dirname(__file__), "moments_ui_tree.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(all_controls, f, ensure_ascii=False, indent=2)
    print(f"\n完整树已保存: {out_path}")

    pythoncom.CoUninitialize()

if __name__ == "__main__":
    explore_moments()
