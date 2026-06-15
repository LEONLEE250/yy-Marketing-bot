"""
壹准 AI 营销助手 - 朋友圈自动发布 v1.0
基于 UIA + pyautogui 双模式，无需 wxauto4 朋友圈 API

依赖: win32gui, pyautogui, pyperclip, wxauto4.uia.uiautomation
"""

import sys
import os
import time
import threading
import pythoncom
import pyautogui
import pyperclip

# 禁用 pyautogui 的 fail-safe（角落检测），避免自动化中断
pyautogui.FAILSAFE = False

WORK_DIR = os.path.dirname(os.path.abspath(__file__))
_DEBUG_LOG = os.path.join(WORK_DIR, 'moment_debug.log')


def _log(msg):
    """调试日志"""
    import datetime
    try:
        ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with open(_DEBUG_LOG, 'a', encoding='utf-8') as f:
            f.write(f'[{ts}] {msg}\n')
    except:
        pass


def _get_wechat_window():
    """获取微信主窗口 hwnd 和 rect"""
    import win32gui
    import win32con

    def _enum(hwnd, result):
        try:
            cls = win32gui.GetClassName(hwnd)
            title = win32gui.GetWindowText(hwnd)
            if cls not in ("Qt51514QWindowIcon", "mmui::MainWindow", "Chrome_WidgetWin_0"):
                return
            if title in ("WxTrayIconMessageWindow",):
                return
            if not win32gui.IsWindowVisible(hwnd):
                return
            rect = win32gui.GetWindowRect(hwnd)
            w, h = rect[2] - rect[0], rect[3] - rect[1]
            if w < 300 or h < 300:
                return
            result.append({"hwnd": hwnd, "rect": rect, "w": w, "h": h, "title": title})
        except:
            pass

    result = []
    win32gui.EnumWindows(_enum, result)
    if not result:
        raise RuntimeError("未检测到微信窗口，请先打开微信并登录")
    result.sort(key=lambda x: x["w"] * x["h"], reverse=True)
    return result[0]


def _ensure_window_foreground(win):
    """确保微信窗口在前台且可见"""
    import win32gui
    import win32con

    hwnd = win["hwnd"]
    try:
        import psutil
        _, pid = win32gui.GetWindowThreadProcessId(hwnd)
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.6)
    except:
        pass


# ============================================================
# 导航：到朋友圈页面
# ============================================================

def _navigate_to_discover(win):
    """点击左侧「发现」tab"""
    import win32gui
    import win32con

    _ensure_window_foreground(win)
    hwnd = win["hwnd"]
    rect = win32gui.GetWindowRect(hwnd)
    x, y = rect[0], rect[1]
    w, h = rect[2] - rect[0], rect[3] - rect[1]

    _log(f'navigate_to_discover: window {w}x{h} at ({x},{y})')

    # 策略 A: UIA 找「发现」Tab
    try:
        from wxauto4.uia import uiautomation as auto
        root = auto.ControlFromHandle(hwnd)
        for control, depth in auto.WalkControl(root, includeTop=True, maxDepth=15):
            try:
                if getattr(control, "ClassName", "") == "mmui::XTabBarItem" and getattr(control, "Name", "") == "发现":
                    control.Click(simulateMove=False)
                    _log('navigate_to_discover: UIA clicked mmui::XTabBarItem[发现]')
                    time.sleep(1.0)
                    return True
            except:
                continue
        _log('navigate_to_discover: UIA not found, falling back to pyautogui')
    except Exception as e:
        _log(f'navigate_to_discover: UIA failed: {e}')

    # 策略 B: pyautogui 坐标点击
    # 微信左侧 Tab 栏约在 x: 2%-8% 处，「发现」约在第 4 个位置 (从上往下约 48%-52%)
    tab_x = x + int(w * 0.05)
    tab_y = y + int(h * 0.48)
    _log(f'navigate_to_discover: pyautogui click ({tab_x},{tab_y})')
    pyautogui.click(tab_x, tab_y)
    time.sleep(1.0)
    return True


def _navigate_to_moments(win):
    """在「发现」页面点击「朋友圈」"""
    import win32gui

    hwnd = win["hwnd"]
    rect = win32gui.GetWindowRect(hwnd)
    x, y = rect[0], rect[1]
    w, h = rect[2] - rect[0], rect[3] - rect[1]

    _log(f'navigate_to_moments: window {w}x{h}')

    # 策略 A: UIA 找名称含「朋友圈」的可点击元素
    try:
        from wxauto4.uia import uiautomation as auto
        root = auto.ControlFromHandle(hwnd)
        for control, depth in auto.WalkControl(root, includeTop=True, maxDepth=20):
            try:
                name = str(getattr(control, "Name", "") or "")
                if "朋友圈" in name:
                    control.Click(simulateMove=False)
                    _log(f'navigate_to_moments: UIA clicked [{name}]')
                    time.sleep(1.2)
                    return True
            except:
                continue
        _log('navigate_to_moments: UIA not found, falling back to pyautogui')
    except Exception as e:
        _log(f'navigate_to_moments: UIA failed: {e}')

    # 策略 B: pyautogui 坐标点击
    # 「朋友圈」在发现页约在中间偏上位置 (50%, 28%)
    click_x = x + int(w * 0.50)
    click_y = y + int(h * 0.28)
    _log(f'navigate_to_moments: pyautogui click ({click_x},{click_y})')
    pyautogui.click(click_x, click_y)
    time.sleep(1.2)
    return True


# ============================================================
# 发布文字朋友圈
# ============================================================

def _open_text_publisher(win):
    """
    长按右上角相机图标 → 进入纯文字编辑模式
    注意：此功能需要微信版本支持（长按相机出现「发表文字」）
    """
    import win32gui

    hwnd = win["hwnd"]
    rect = win32gui.GetWindowRect(hwnd)
    x, y = rect[0], rect[1]
    w, h = rect[2] - rect[0], rect[3] - rect[1]

    _log(f'open_text_publisher: window {w}x{h}')

    # 策略 A: UIA 找相机按钮
    try:
        from wxauto4.uia import uiautomation as auto
        root = auto.ControlFromHandle(hwnd)
        for control, depth in auto.WalkControl(root, includeTop=True, maxDepth=20):
            try:
                name = str(getattr(control, "Name", "") or "")
                aid = str(getattr(control, "AutomationId", "") or "")
                cls = str(getattr(control, "ClassName", "") or "")
                if "相机" in name or "camera" in (name + aid).lower() or "CameraBtn" in aid:
                    # 长按 = 先移动到元素上，然后 mouseDown + sleep + mouseUp
                    rect_el = control.BoundingRectangle
                    cx = int(rect_el.left + rect_el.width() / 2)
                    cy = int(rect_el.top + rect_el.height() / 2)
                    pyautogui.moveTo(cx, cy)
                    time.sleep(0.2)
                    pyautogui.mouseDown()
                    time.sleep(1.5)  # 长按 1.5 秒
                    pyautogui.mouseUp()
                    _log(f'open_text_publisher: UIA long-pressed [{name}] at ({cx},{cy})')
                    time.sleep(0.8)
                    return True
            except:
                continue
        _log('open_text_publisher: UIA camera not found, falling back to pyautogui')
    except Exception as e:
        _log(f'open_text_publisher: UIA failed: {e}')

    # 策略 B: pyautogui 坐标长按
    # 相机按钮在朋友圈页右上角，约 (94%, 12%)
    cam_x = x + int(w * 0.94)
    cam_y = y + int(h * 0.12)
    _log(f'open_text_publisher: pyautogui long-press ({cam_x},{cam_y})')
    pyautogui.moveTo(cam_x, cam_y)
    time.sleep(0.2)
    pyautogui.mouseDown()
    time.sleep(1.5)
    pyautogui.mouseUp()
    time.sleep(0.8)
    return True


def _input_moment_text(text):
    """在编辑框中输入文字"""
    _log(f'input_moment_text: len={len(text)}')
    pyperclip.copy(text)
    time.sleep(0.2)
    pyautogui.hotkey('ctrl', 'v')
    time.sleep(0.5)
    return True


def _click_publish_button(win):
    """点击「发表」按钮"""
    import win32gui

    hwnd = win["hwnd"]
    rect = win32gui.GetWindowRect(hwnd)
    x, y = rect[0], rect[1]
    w, h = rect[2] - rect[0], rect[3] - rect[1]

    # 策略 A: UIA 找「发表」按钮
    try:
        from wxauto4.uia import uiautomation as auto
        root = auto.ControlFromHandle(hwnd)
        for control, depth in auto.WalkControl(root, includeTop=True, maxDepth=20):
            try:
                name = str(getattr(control, "Name", "") or "")
                cls = str(getattr(control, "ClassName", "") or "")
                if name in ("发表", "發布") and "Button" in (getattr(control, "ControlTypeName", "") or ""):
                    control.Click(simulateMove=False)
                    _log(f'click_publish: UIA clicked [{name}]')
                    time.sleep(1.0)
                    return True
                # 有些版本是绿色按钮，Name 可能为空
                if "PublishBtn" in str(getattr(control, "AutomationId", "") or ""):
                    control.Click(simulateMove=False)
                    _log('click_publish: UIA clicked PublishBtn')
                    time.sleep(1.0)
                    return True
            except:
                continue
        _log('click_publish: UIA not found, falling back to pyautogui')
    except Exception as e:
        _log(f'click_publish: UIA failed: {e}')

    # 策略 B: pyautogui 坐标点击
    # 发表按钮在编辑弹窗右下角
    publish_x = x + int(w * 0.82)
    publish_y = y + int(h * 0.88)
    _log(f'click_publish: pyautogui click ({publish_x},{publish_y})')
    pyautogui.click(publish_x, publish_y)
    time.sleep(1.0)

    # 策略 C: Ctrl+Enter 快捷键
    try:
        pyautogui.hotkey('ctrl', 'enter')
        _log('click_publish: sent Ctrl+Enter')
        time.sleep(1.0)
    except:
        pass

    return True


# ============================================================
# 公开接口
# ============================================================

def publish_text_moment(text):
    """
    发布纯文字朋友圈
    Args:
        text: 朋友圈文字内容
    Returns:
        dict: {"success": True/False, "error": "..."}
    """
    _log(f'=== publish_text_moment START ===')

    def _run():
        pythoncom.CoInitialize()
        try:
            # 1. 获取微信窗口
            win = _get_wechat_window()
            _log(f'step1: found window {win["w"]}x{win["h"]}')

            # 2. 导航到发现页
            _navigate_to_discover(win)
            _log('step2: navigated to discover')

            # 3. 点击朋友圈
            _navigate_to_moments(win)
            _log('step3: entered moments')

            # 4. 长按相机 → 文字编辑
            _open_text_publisher(win)
            _log('step4: opened text publisher')

            # 5. 输入文字
            _input_moment_text(text)
            _log('step5: text pasted')

            # 6. 点击发表
            _click_publish_button(win)
            _log('step6: publish clicked')

            return {"success": True, "error": None}
        except Exception as e:
            _log(f'publish_text_moment ERROR: {e}')
            return {"success": False, "error": str(e)}
        finally:
            pythoncom.CoUninitialize()

    box = {"done": False, "value": {"success": False, "error": "timeout"}}

    def _worker():
        box["value"] = _run()
        box["done"] = True

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(30)  # 最多等 30 秒

    if not box["done"]:
        _log('publish_text_moment TIMEOUT')
        return {"success": False, "error": "发布超时（30秒），请检查微信是否卡顿"}

    _log(f'=== publish_text_moment DONE: {box["value"]} ===')
    return box["value"]


def publish_image_moment(image_path, text=""):
    """
    发布图片朋友圈（含可选文字）
    Args:
        image_path: 图片文件路径
        text: 可选文字
    Returns:
        dict: {"success": True/False, "error": "..."}
    """
    _log(f'=== publish_image_moment START: image={image_path} ===')

    def _run():
        pythoncom.CoInitialize()
        try:
            import win32gui

            win = _get_wechat_window()
            hwnd = win["hwnd"]
            rect = win32gui.GetWindowRect(hwnd)
            x, y = rect[0], rect[1]
            w, h = rect[2] - rect[0], rect[3] - rect[1]

            # 1-3. 导航到朋友圈
            _navigate_to_discover(win)
            _navigate_to_moments(win)

            # 4. 点击相机（非长按）→ 图片选择
            cam_x = x + int(w * 0.94)
            cam_y = y + int(h * 0.12)
            _log(f'open_image_publisher: click ({cam_x},{cam_y})')
            pyautogui.click(cam_x, cam_y)
            time.sleep(1.0)

            # 5. 从相册选择 → 用 Ctrl+V 粘贴图片路径（微信支持文件路径粘贴）
            # 先点击「从相册选择」或等文件对话框出现
            time.sleep(0.5)
            pyperclip.copy(os.path.abspath(image_path))
            pyautogui.hotkey('ctrl', 'v')
            time.sleep(1.5)
            pyautogui.press('enter')
            time.sleep(1.5)

            # 6. 如有文字，粘贴
            if text and text.strip():
                pyperclip.copy(text)
                time.sleep(0.3)
                pyautogui.hotkey('ctrl', 'v')
                time.sleep(0.5)

            # 7. 发表
            _click_publish_button(win)

            return {"success": True, "error": None}
        except Exception as e:
            _log(f'publish_image_moment ERROR: {e}')
            import traceback
            _log(traceback.format_exc())
            return {"success": False, "error": str(e)}
        finally:
            pythoncom.CoUninitialize()

    box = {"done": False, "value": {"success": False, "error": "timeout"}}

    def _worker():
        box["value"] = _run()
        box["done"] = True

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(35)

    if not box["done"]:
        _log('publish_image_moment TIMEOUT')
        return {"success": False, "error": "发布超时（35秒）"}

    _log(f'=== publish_image_moment DONE: {box["value"]} ===')
    return box["value"]


# ============================================================
# CLI
# ============================================================

if __name__ == "__main__":
    if len(sys.argv) > 1:
        import json
        cmd = json.loads(sys.argv[1])
        action = cmd.get("action", "")
        text = cmd.get("text", "")
        image = cmd.get("image_path")

        if action == "text":
            result = publish_text_moment(text)
        elif action == "image":
            result = publish_image_moment(image, text)
        else:
            result = {"success": False, "error": f"unknown action: {action}"}

        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("wechat_moment.py — 朋友圈自动发布")
        print("  usage: python wechat_moment.py '{\"action\":\"text\",\"text\":\"Hello\"}'")
