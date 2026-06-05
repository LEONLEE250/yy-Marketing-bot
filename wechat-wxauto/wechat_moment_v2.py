"""
壹准 AI 营销助手 - 朋友圈自动发布 v2.0
支持：文字 / 图片 / 视频 / 定时发布

技术栈: UIA 优先 + pyautogui 兜底 + pyperclip 粘贴
"""

import sys, os, time, threading, traceback, datetime, json
import pythoncom, pyautogui, pyperclip

pyautogui.FAILSAFE = False
WORK_DIR = os.path.dirname(os.path.abspath(__file__))
_DEBUG_LOG = os.path.join(WORK_DIR, 'moment_debug.log')
_OUTPUT_DIR = os.path.join(WORK_DIR, 'output')
os.makedirs(_OUTPUT_DIR, exist_ok=True)

# 定时任务存储
_scheduled_tasks: dict = {}
_task_counter = 0

_VIDEO_EXTS = {'.mp4', '.mov', '.avi', '.wmv', '.mkv', '.flv', '.m4v', '.webm'}
_IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tiff'}


def _log(msg: str):
    try:
        ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with open(_DEBUG_LOG, 'a', encoding='utf-8') as f:
            f.write(f'[{ts}] {msg}\n')
    except:
        pass


def _get_wechat_window() -> dict:
    """获取微信主窗口"""
    import win32gui
    result = []

    def _enum(hwnd, res):
        try:
            cls = win32gui.GetClassName(hwnd)
            title = win32gui.GetWindowText(hwnd)
            if cls not in ("Qt51514QWindowIcon", "mmui::MainWindow", "Chrome_WidgetWin_0"):
                return
            if title in ("WxTrayIconMessageWindow",):
                return
            if not win32gui.IsWindowVisible(hwnd):
                return
            r = win32gui.GetWindowRect(hwnd)
            w, h = r[2] - r[0], r[3] - r[1]
            if w < 300 or h < 300:
                return
            res.append({"hwnd": hwnd, "rect": r, "w": w, "h": h, "title": title})
        except:
            pass

    win32gui.EnumWindows(_enum, result)
    if not result:
        raise RuntimeError("未检测到微信窗口，请先打开并登录电脑微信")
    result.sort(key=lambda x: x["w"] * x["h"], reverse=True)
    return result[0]


def _ensure_foreground(win: dict):
    """把微信窗口拉到前台"""
    import win32gui, win32con
    hwnd = win["hwnd"]
    try:
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.5)
    except:
        pass


# ── UIA 辅助 ──────────────────────────────────────────

def _find_uia_control(hwnd, **filters) -> object:
    """在 UIA 树中找第一个匹配元素。filters 支持: Name, ClassName, AutomationId, ControlTypeName"""
    try:
        from wxauto4.uia import uiautomation as auto
        root = auto.ControlFromHandle(hwnd)
        for ctrl, _ in auto.WalkControl(root, includeTop=True, maxDepth=25):
            try:
                match = True
                for k, v in filters.items():
                    val = str(getattr(ctrl, k, "") or "")
                    if v not in val:
                        match = False
                        break
                if match:
                    return ctrl
            except:
                continue
    except Exception as e:
        _log(f'UIA error: {e}')
    return None


# ── 导航 ──────────────────────────────────────────────

def _goto_discover(win: dict):
    """导航到「发现」tab"""
    _ensure_foreground(win)
    hwnd, x, y, w, h = win["hwnd"], win["rect"][0], win["rect"][1], win["w"], win["h"]

    # UIA
    btn = _find_uia_control(hwnd, ClassName="mmui::XTabBarItem", Name="发现")
    if btn:
        btn.Click(simulateMove=False)
        _log('goto_discover: UIA ok')
        time.sleep(1.0)
        return

    # pyautogui 兜底 — 左侧 tab 栏第 4 个
    px, py = x + int(w * 0.05), y + int(h * 0.48)
    _log(f'goto_discover: pyautogui ({px},{py})')
    pyautogui.click(px, py)
    time.sleep(1.0)


def _goto_moments(win: dict):
    """在发现页点击「朋友圈」"""
    hwnd, x, y, w, h = win["hwnd"], win["rect"][0], win["rect"][1], win["w"], win["h"]

    # UIA
    btn = _find_uia_control(hwnd, Name="朋友圈")
    if btn:
        btn.Click(simulateMove=False)
        _log('goto_moments: UIA ok')
        time.sleep(1.2)
        return

    # pyautogui
    px, py = x + int(w * 0.50), y + int(h * 0.25)
    _log(f'goto_moments: pyautogui ({px},{py})')
    pyautogui.click(px, py)
    time.sleep(1.2)


# ── 发布 ──────────────────────────────────────────────

def _click_camera_icon(win: dict, long_press: bool = False):
    """点相机按钮。long_press=True 则长按 1.5s"""
    hwnd = win["hwnd"]
    x, y, w, h = win["rect"][0], win["rect"][1], win["w"], win["h"]

    # UIA 找相机
    btn = _find_uia_control(hwnd, Name="相机") or _find_uia_control(hwnd, AutomationId="CameraBtn")
    if btn:
        try:
            r = btn.BoundingRectangle
            cx, cy = int(r.left + r.width() / 2), int(r.top + r.height() / 2)
            pyautogui.moveTo(cx, cy)
            time.sleep(0.15)
            if long_press:
                pyautogui.mouseDown(); time.sleep(1.5); pyautogui.mouseUp()
            else:
                pyautogui.click()
            _log(f'camera: UIA {"long-press" if long_press else "click"} ({cx},{cy})')
            time.sleep(0.8)
            return
        except:
            pass

    # pyautogui 兜底 — 右上角
    cx, cy = x + int(w * 0.94), y + int(h * 0.11)
    pyautogui.moveTo(cx, cy)
    time.sleep(0.15)
    if long_press:
        pyautogui.mouseDown(); time.sleep(1.5); pyautogui.mouseUp()
    else:
        pyautogui.click()
    _log(f'camera: pyautogui {"long-press" if long_press else "click"} ({cx},{cy})')
    time.sleep(0.8)


def _paste_text(text: str):
    pyperclip.copy(text)
    time.sleep(0.2)
    pyautogui.hotkey('ctrl', 'v')
    time.sleep(0.5)


def _select_file_in_dialog(file_path: str):
    """
    在 Windows 文件选择对话框中输入文件路径并确认。
    对话框打开后：
    1. Alt+D 定位到地址栏
    2. 粘贴完整路径
    3. Enter 确认
    """
    path = os.path.abspath(file_path)
    _log(f'select_file: path={path}')

    time.sleep(0.8)
    # Alt+D → 地址栏
    pyautogui.hotkey('alt', 'd')
    time.sleep(0.3)
    # 粘贴路径
    pyperclip.copy(path)
    pyautogui.hotkey('ctrl', 'v')
    time.sleep(0.4)
    pyautogui.press('enter')
    time.sleep(2.0)  # 等文件加载


def _publish(win: dict):
    """点击发表按钮"""
    hwnd = win["hwnd"]
    x, y, w, h = win["rect"][0], win["rect"][1], win["w"], win["h"]

    # UIA
    for name in ("发表", "發布", "Publish"):
        btn = _find_uia_control(hwnd, Name=name)
        if btn:
            btn.Click(simulateMove=False)
            _log(f'publish: UIA clicked [{name}]')
            time.sleep(1.5)
            return

    # pyautogui 兜底 — 右下角
    px, py = x + int(w * 0.82), y + int(h * 0.90)
    pyautogui.click(px, py)
    _log(f'publish: pyautogui ({px},{py})')
    time.sleep(0.5)

    # Ctrl+Enter 快捷键
    pyautogui.hotkey('ctrl', 'enter')
    time.sleep(1.5)


# ── 公开 API ──────────────────────────────────────────

def publish(text: str, media_path: str = None, media_type: str = "auto") -> dict:
    """
    发布朋友圈（统一入口）
    - text: 文字内容
    - media_path: 图片/视频文件路径
    - media_type: "image"/"video"/"auto"
    """
    _log(f'=== publish START: text_len={len(text)}, media={media_path} ===')

    if not text and not media_path:
        return {"success": False, "error": "请至少输入文字或选择媒体文件"}

    if media_path and not os.path.isfile(media_path):
        return {"success": False, "error": f"媒体文件不存在: {media_path}"}

    # 检测媒体类型
    if media_type == "auto" and media_path:
        ext = os.path.splitext(media_path)[1].lower()
        if ext in _VIDEO_EXTS:
            media_type = "video"
        elif ext in _IMAGE_EXTS:
            media_type = "image"
        else:
            return {"success": False, "error": f"不支持的媒体格式: {ext}"}

    is_text_only = not media_path
    is_video = media_type == "video"

    def _run():
        pythoncom.CoInitialize()
        try:
            win = _get_wechat_window()
            _log(f'step1: window {win["w"]}x{win["h"]}')

            _goto_discover(win)
            _log('step2: discover')

            _goto_moments(win)
            _log('step3: moments')

            if is_text_only:
                # 纯文字 → 长按相机
                _click_camera_icon(win, long_press=True)
                _log('step4a: text publisher opened')
                _paste_text(text)
                _log('step5a: text pasted')
            else:
                # 图片/视频 → 点相机 → 文件对话框
                _click_camera_icon(win, long_press=False)
                _log('step4b: camera clicked (file dialog should open)')
                _select_file_in_dialog(media_path)
                _log('step5b: file selected')

                # 等媒体加载完成后（视频较慢），再贴文字
                wait_time = 4.0 if is_video else 2.0
                time.sleep(wait_time)
                _log(f'step6: waited {wait_time}s for media load')

                if text:
                    _paste_text(text)
                    _log('step7: text pasted')

            _publish(win)
            _log('step8: publish done')
            return {"success": True, "error": None, "media_type": media_type}

        except Exception as e:
            _log(f'publish ERROR: {e}\n{traceback.format_exc()}')
            return {"success": False, "error": str(e)}
        finally:
            pythoncom.CoUninitialize()

    # 线程执行（视频需要更长时间）
    timeout = 60 if is_video else 35
    box = {"done": False, "value": {"success": False, "error": "timeout"}}
    t = threading.Thread(target=lambda: box.update(value=_run(), done=True), daemon=True)
    t.start()
    t.join(timeout)

    if not box["done"]:
        _log('publish TIMEOUT')
        return {"success": False, "error": f"发布超时（{timeout}秒），请检查微信是否响应"}

    _log(f'=== publish DONE: {box["value"]} ===')
    return box["value"]


# ── 定时发布 ──────────────────────────────────────────

def schedule(text: str, scheduled_at: str, media_path: str = None) -> dict:
    """
    定时发布朋友圈
    - scheduled_at: ISO 时间格式，如 "2026-06-05T18:30:00"
    """
    global _task_counter
    _task_counter += 1
    task_id = f"moment-{_task_counter}"

    try:
        scheduled_dt = datetime.datetime.fromisoformat(scheduled_at)
        now = datetime.datetime.now()
        delay = (scheduled_dt - now).total_seconds()
        if delay <= 0:
            return {"success": False, "error": "定时时间已过，请选择未来时间"}
    except Exception:
        return {"success": False, "error": "时间格式错误，请使用 YYYY-MM-DDTHH:MM:SS"}

    task = {
        "id": task_id,
        "text": text,
        "media_path": media_path,
        "scheduled_at": scheduled_at,
        "status": "pending",
        "created_at": now.isoformat(),
    }
    _scheduled_tasks[task_id] = task

    def _exec():
        time.sleep(delay)
        try:
            task["status"] = "running"
            result = publish(text, media_path)
            task["result"] = result
            task["status"] = "completed" if result.get("success") else "failed"
        except Exception as e:
            task["status"] = "failed"
            task["result"] = {"success": False, "error": str(e)}

    threading.Thread(target=_exec, daemon=True).start()

    return {
        "success": True,
        "task_id": task_id,
        "scheduled_at": scheduled_at,
        "delay_seconds": int(delay),
    }


def get_scheduled_moments() -> list:
    """获取所有定时朋友圈任务"""
    return [
        {
            "id": t["id"],
            "scheduled_at": t["scheduled_at"],
            "text_preview": t["text"][:50] + ("..." if len(t["text"]) > 50 else ""),
            "has_media": bool(t.get("media_path")),
            "status": t["status"],
        }
        for t in _scheduled_tasks.values()
    ]


def cancel_scheduled(task_id: str) -> dict:
    """取消定时发布"""
    t = _scheduled_tasks.get(task_id)
    if not t:
        return {"success": False, "error": "任务不存在"}
    if t["status"] not in ("pending",):
        return {"success": False, "error": "任务已开始执行，无法取消"}
    t["status"] = "cancelled"
    return {"success": True, "message": "已取消"}


# ── CLI ────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default="")
    ap.add_argument("--media", default="")
    ap.add_argument("--schedule", default="")
    args = ap.parse_args()

    if args.schedule:
        r = schedule(args.text, args.schedule, args.media or None)
    else:
        r = publish(args.text, args.media or None)

    print(json.dumps(r, ensure_ascii=False, indent=2))
