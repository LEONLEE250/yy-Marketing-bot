"""
壹准 AI 营销助手 - 微信自动化服务 v3.0
基于 wxauto4 免费版 (wxauto4 41.1.2)，用户已验证可用

功能:
  1. 消息发送：文本/图片/图文/群发
  2. AI 文案：根据产品信息自动生成营销文案
  3. 定时发送：支持指定时间自动发送
"""

import sys
import os
import time
import json
import threading
import traceback
import datetime
import subprocess
import pyautogui
import pyperclip
import pygetwindow as gw
import pythoncom

try:
    import comtypes.gen.UIAutomationClient  # noqa: F401
except Exception:
    try:
        import comtypes.client
        _COMTYPES_GEN_DIR = os.path.join(WORK_DIR, 'comtypes_gen') if 'WORK_DIR' in globals() else None
        if _COMTYPES_GEN_DIR and os.path.isdir(_COMTYPES_GEN_DIR):
            comtypes.client.gen_dir = _COMTYPES_GEN_DIR
            import comtypes.gen.UIAutomationClient  # noqa: F401
    except Exception:
        pass

from wxauto4 import WeChat

# 配置（跨电脑兼容：先试 C:\Python312，再试环境变量，最后用系统 python）
_DEFAULT_PY = r'C:\Python312\python.exe'
PYTHON_PATH = _DEFAULT_PY if os.path.exists(_DEFAULT_PY) else (os.environ.get('YIZHUN_PYTHON') or os.environ.get('PYTHON') or 'python')
WORK_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(WORK_DIR, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 单例模式
_wx_instance = None

# 定时任务存储
_scheduled_tasks = {}
_task_counter = 0

# 调试日志
_DEBUG_LOG = os.path.join(WORK_DIR, 'wxauto_service_debug.log')


def _debug_log(message):
    try:
        timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with open(_DEBUG_LOG, 'a', encoding='utf-8') as f:
            f.write(f'[{timestamp}] {message}\n')
    except Exception:
        pass


def _inspect_wechat_windows():
    """检查微信窗口状态，辅助定位初始化失败原因。"""
    script = r'''
import json
try:
    import psutil
    import win32gui
    import win32process
    import win32con
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
    raise SystemExit(0)

wechat_pids = {
    p.info["pid"]
    for p in psutil.process_iter(["pid", "name", "exe"])
    if (
        ((p.info["name"] or "").lower() == "weixin.exe" and (p.info.get("exe") or "").lower().endswith("\\weixin.exe"))
        or ((p.info["name"] or "").lower() == "wechatappex.exe" and "\\tencent\\xwechat\\" in ((p.info.get("exe") or "").lower()))
    )
}

windows = []

def enum_all(hwnd, _):
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        if pid not in wechat_pids:
            return
        cls = win32gui.GetClassName(hwnd)
        rect = win32gui.GetWindowRect(hwnd)
        windows.append({
            "hwnd": hwnd,
            "pid": pid,
            "title": win32gui.GetWindowText(hwnd),
            "class": cls,
            "visible": bool(win32gui.IsWindowVisible(hwnd)),
            "rect": list(rect),
            "width": rect[2] - rect[0],
            "height": rect[3] - rect[1],
        })
    except Exception:
        pass

win32gui.EnumWindows(enum_all, None)

restored = []
for item in windows:
    if item["class"] != "Chrome_WidgetWin_0":
        continue
    if item["width"] <= 300 or item["height"] <= 300:
        continue
    try:
        win32gui.ShowWindow(item["hwnd"], win32con.SW_RESTORE)
        win32gui.ShowWindow(item["hwnd"], win32con.SW_SHOW)
        restored.append(item["hwnd"])
    except Exception:
        pass

print(json.dumps({
    "ok": True,
    "pids": sorted(wechat_pids),
    "windows": windows,
    "restored": restored,
}, ensure_ascii=False))
'''
    try:
        result = subprocess.run(
            [PYTHON_PATH, "-c", script],
            capture_output=True,
            text=True,
            timeout=10,
            encoding="utf-8",
            errors="ignore",
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0,
        )
        stdout = (result.stdout or "").strip().splitlines()
        raw = stdout[-1] if stdout else ""
        if not raw:
            return {"ok": False, "error": "未获取到窗口检测结果"}
        return json.loads(raw)
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _format_init_error(exc):
    info = _inspect_wechat_windows()
    if not info.get("ok"):
        return f"微信初始化失败: {exc}；窗口检测失败: {info.get('error', '未知错误')}"

    windows = info.get("windows", [])
    candidate_count = sum(
        1 for w in windows
        if w.get("visible") and w.get("width", 0) > 300 and w.get("height", 0) > 300 and w.get("class") in ("Chrome_WidgetWin_0", "Qt51514QWindowIcon", "mmui::MainWindow") and w.get("title") != "WxTrayIconMessageWindow"
    )
    visible_candidates = sum(
        1 for w in windows
        if w.get("visible") and w.get("width", 0) > 300 and w.get("height", 0) > 300 and w.get("class") in ("Chrome_WidgetWin_0", "Qt51514QWindowIcon", "mmui::MainWindow") and w.get("title") != "WxTrayIconMessageWindow"
    )
    return (
        f"微信初始化失败: {exc}；检测到微信相关进程 {len(info.get('pids', []))} 个，"
        f"主窗口候选 {candidate_count} 个，可见 {visible_candidates} 个。"
        "请先把微信主窗口切到前台并保持可见后重试。"
    )


def _restore_wechat_window():
    """尝试恢复正式微信主窗口。"""
    titles = ["微信", "Weixin"]
    restored = []
    for title in titles:
        try:
            for win in gw.getWindowsWithTitle(title):
                if getattr(win, 'width', 0) > 300 and getattr(win, 'height', 0) > 300:
                    try:
                        if win.isMinimized:
                            win.restore()
                    except Exception:
                        pass
                    try:
                        win.activate()
                    except Exception:
                        pass
                    restored.append(title)
                    time.sleep(0.8)
                    return {"ok": True, "restored": restored, "method": "pygetwindow"}
        except Exception:
            pass

    info = _inspect_wechat_windows()
    windows = info.get("windows", []) if isinstance(info, dict) else []
    candidates = [
        w for w in windows
        if w.get("visible")
        and w.get("width", 0) > 300
        and w.get("height", 0) > 300
        and w.get("class") in ("Qt51514QWindowIcon", "mmui::MainWindow", "Chrome_WidgetWin_0")
        and w.get("title") not in ("WxTrayIconMessageWindow",)
    ]
    candidates.sort(key=lambda w: (w.get("width", 0) * w.get("height", 0)), reverse=True)
    for item in candidates:
        try:
            import win32con
            import win32gui
            hwnd = item["hwnd"]
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
            win32gui.SetForegroundWindow(hwnd)
            time.sleep(1.0)
            return {"ok": True, "restored": [hwnd], "method": "win32gui", "window": item}
        except Exception:
            pass

    restored_hwnds = info.get("restored", []) if isinstance(info, dict) else []
    if restored_hwnds:
        time.sleep(1.2)
    return info


def _focus_weixin_main_window():
    info = _restore_wechat_window()
    time.sleep(0.5)
    return info


def _parse_session_cell_text(raw_text):
    lines = [line.strip() for line in (raw_text or "").splitlines() if line.strip()]
    if not lines:
        return None

    name = lines[0]
    skipped_tokens = {"已置顶", "消息免打扰", "折叠置顶聊天"}
    content = ""
    for line in lines[1:]:
        if line in skipped_tokens:
            continue
        content = line
        break

    return {
        "id": name,
        "name": name,
        "content": content,
        "raw": raw_text,
    }


def _activate_wechat_session_tab():
    """通过坐标点击左侧聊天页签，避免 wxauto4 初始化时找不到“微信”按钮。"""
    try:
        import win32con
        import win32gui
        hwnd = None
        info = _inspect_wechat_windows()
        if isinstance(info, dict):
            windows = info.get("windows", [])
            candidates = [
                w for w in windows
                if w.get("class") in ("Qt51514QWindowIcon", "mmui::MainWindow", "Chrome_WidgetWin_0")
                and w.get("title") not in ("WxTrayIconMessageWindow",)
                and w.get("width", 0) > 300
                and w.get("height", 0) > 300
            ]
            candidates.sort(key=lambda w: (w.get("width", 0) * w.get("height", 0)), reverse=True)
            if candidates:
                hwnd = candidates[0]["hwnd"]
        if not hwnd:
            return False

        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.8)

        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        width = right - left
        height = bottom - top
        click_x = left + max(28, min(56, int(width * 0.07)))
        click_y = top + max(72, min(120, int(height * 0.12)))

        old_failsafe = pyautogui.FAILSAFE
        pyautogui.FAILSAFE = False
        try:
            pyautogui.click(click_x, click_y)
            time.sleep(0.8)
        finally:
            pyautogui.FAILSAFE = old_failsafe
        return True
    except Exception:
        return False


def _serialize_session_element(session, idx=0):
    """将 wxauto4 的 SessionElement 转成前端可用结构。"""
    try:
        name = str(getattr(session, "name", "") or "").strip()
    except Exception:
        name = ""

    try:
        content = str(getattr(session, "content", "") or "").strip()
    except Exception:
        content = ""

    try:
        info = getattr(session, "info", None)
    except Exception:
        info = None

    session_id = name or content or f"session-{idx + 1}"
    payload = {
        "id": session_id,
        "name": name,
        "content": content,
        "raw": str(session),
    }
    if info is not None:
        payload["info"] = info
    return payload



def _run_with_timeout(fn, timeout=5.0, default=None, label='task'):
    box = {"done": False, "value": default, "error": None}

    def _inner():
        pythoncom.CoInitialize()
        try:
            box["value"] = fn()
            box["done"] = True
        except Exception as e:
            box["error"] = e
            box["done"] = True
        finally:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass

    t = threading.Thread(target=_inner, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        _debug_log(f'{label}:timeout')
        raise TimeoutError(f'{label} timeout')
    if box["error"] is not None:
        raise box["error"]
    return box["value"]


def _get_sessions_via_wxauto():
    """优先使用 wxauto4 原生 GetSession。
    注意：不使用全局 _wx_instance，避免 COM 对象跨线程导致 CoInitialize 错误。"""
    _debug_log('session_step=activate_tab:start')
    _activate_wechat_session_tab()
    _debug_log('session_step=activate_tab:done')

    def _init_and_get():
        """在同一 COM 线程内完成 WeChat 初始化 + 抓取会话"""
        try:
            wx = WeChat(ads=False)
        except TypeError:
            wx = WeChat()
        _debug_log('session_step=wechat_init:done')
        sessions = wx.GetSession() or []
        _debug_log(f'session_step=get_session:done count={len(sessions)}')
        return sessions

    _debug_log('session_step=wechat_init:start')
    raw = _run_with_timeout(_init_and_get, timeout=4.0, label='wechat_session')

    result = []
    seen = set()
    for idx, session in enumerate(raw):
        item = _serialize_session_element(session, idx)
        key = item.get("name") or item.get("content") or item.get("id")
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(item)
    _debug_log(f'session_step=serialize:done count={len(result)}')
    return result



def _get_sessions_from_main_window():
    import win32con
    import win32gui
    try:
        from wxauto4.uia import uiautomation as auto
    except Exception as e:
        _debug_log(f'uia_import_failed: {e}')
        raise RuntimeError(f'UIA 组件加载失败，请重新安装最新版软件: {e}')

    info = _inspect_wechat_windows()
    if not info.get("ok"):
        raise RuntimeError(info.get("error") or "微信窗口检测失败")

    windows = info.get("windows", [])
    candidates = [
        w for w in windows
        if w.get("visible")
        and w.get("width", 0) > 300
        and w.get("height", 0) > 300
        and w.get("class") in ("Qt51514QWindowIcon", "mmui::MainWindow", "Chrome_WidgetWin_0")
        and w.get("title") not in ("WxTrayIconMessageWindow",)
    ]
    candidates.sort(key=lambda w: (w.get("width", 0) * w.get("height", 0)), reverse=True)
    if not candidates:
        raise RuntimeError("未检测到可用的微信主窗口")

    hwnd = candidates[0]["hwnd"]
    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
    time.sleep(0.8)

    root = auto.ControlFromHandle(hwnd)
    found_session_cell = False
    for control, _depth in auto.WalkControl(root, includeTop=True, maxDepth=20):
        try:
            if getattr(control, "ClassName", "") == "mmui::ChatSessionCell":
                found_session_cell = True
                break
        except Exception:
            continue

    if not found_session_cell:
        for control, _depth in auto.WalkControl(root, includeTop=True, maxDepth=10):
            try:
                if getattr(control, "ClassName", "") == "mmui::XTabBarItem" and getattr(control, "Name", "") == "微信":
                    control.Click(simulateMove=False)
                    time.sleep(1.0)
                    break
            except Exception:
                continue

        root = auto.ControlFromHandle(hwnd)
        for control, _depth in auto.WalkControl(root, includeTop=True, maxDepth=20):
            try:
                if getattr(control, "ClassName", "") == "mmui::ChatSessionCell":
                    found_session_cell = True
                    break
            except Exception:
                continue

    if not found_session_cell:
        _debug_log('uia_session_cell_not_found')
        raise RuntimeError("当前微信窗口未定位到聊天会话列表，请先切到微信聊天首页")

    sessions = []
    seen = set()
    for control, _depth in auto.WalkControl(root, includeTop=True, maxDepth=20):
        try:
            if getattr(control, "ClassName", "") != "mmui::ChatSessionCell":
                continue
            raw_text = (getattr(control, "Name", "") or "").strip()
            parsed = _parse_session_cell_text(raw_text)
            if not parsed:
                continue
            key = parsed["name"]
            if key in seen:
                continue
            seen.add(key)
            sessions.append(parsed)
        except Exception:
            continue

    if not sessions:
        raise RuntimeError("会话列表为空，请确认微信已显示聊天列表")

    return sessions


def _send_via_keyboard(target, message, image_path=None):
    if not target:
        raise RuntimeError("缺少收件人")
    _focus_weixin_main_window()
    pyautogui.hotkey('ctrl', 'f')
    time.sleep(0.4)
    pyperclip.copy(target)
    pyautogui.hotkey('ctrl', 'v')
    time.sleep(0.8)
    pyautogui.press('enter')
    time.sleep(1.5)  # 等待聊天窗口完全打开，输入框自动获得焦点

    # 确保微信窗口在前台
    _focus_weixin_main_window()
    time.sleep(0.3)

    if image_path:
        path = _normalize_path(image_path)
        pyperclip.copy(path)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(1.2)
        pyautogui.press('enter')
        time.sleep(1.0)

    if message:
        pyperclip.copy(message)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.3)
        pyautogui.press('enter')
        time.sleep(0.5)

    return {"success": True, "to": target, "type": "keyboard"}


def _send_direct_preferred(to, message='', image_path=None):
    """最小可用发送链路：优先键盘兜底，不依赖会话列表与状态检查。"""
    has_image = bool(image_path)
    has_text = bool(message)
    try:
        result = _send_via_keyboard(to, message or '', image_path)
        result['fallback'] = 'keyboard'
        result['type'] = 'text+image' if has_image and has_text else 'image' if has_image else 'text'
        if has_image:
            result['file'] = _normalize_path(image_path)
        return result
    except Exception as keyboard_error:
        try:
            if has_image and has_text:
                return send_text_and_image(to, message, image_path)
            if has_image:
                return send_image(to, image_path)
            return send_text(to, message)
        except Exception as final_error:
            return {"success": False, "to": to, "error": f"键盘发送失败: {keyboard_error}; wxauto发送失败: {final_error}"}


def get_wx():
    """获取微信实例（单例）"""
    global _wx_instance
    if _wx_instance is None:
        _restore_wechat_window()
        try:
            _wx_instance = WeChat()
        except Exception:
            _restore_wechat_window()
            try:
                _wx_instance = WeChat()
            except Exception as e:
                raise RuntimeError(_format_init_error(e)) from e
    return _wx_instance


def reset_wx():
    """释放微信实例"""
    global _wx_instance
    _wx_instance = None


# ============================================================
# 核心功能：消息发送
# ============================================================

def _normalize_path(path):
    """标准化路径，确保 wxauto4 能识别"""
    if path is None:
        return None
    return os.path.abspath(path)


def send_text(to, message):
    """发送文本消息"""
    try:
        wx = get_wx()
        wx.ChatWith(to)
        time.sleep(0.5)
        wx.SendMsg(message)
        return {"success": True, "to": to, "type": "text"}
    except Exception:
        try:
            result = _send_via_keyboard(to, message)
            result["fallback"] = "keyboard"
            return result
        except Exception as e:
            return {"success": False, "to": to, "error": str(e)}


def send_image(to, image_path):
    """发送图片"""
    path = _normalize_path(image_path)
    try:
        wx = get_wx()
        wx.ChatWith(to)
        time.sleep(0.5)
        wx.SendFiles(path)
        return {"success": True, "to": to, "type": "image", "file": path}
    except Exception:
        try:
            result = _send_via_keyboard(to, "", path)
            result["type"] = "image"
            result["file"] = path
            result["fallback"] = "keyboard"
            return result
        except Exception as e:
            return {"success": False, "to": to, "error": str(e)}


def send_text_and_image(to, message, image_path):
    """发送图文（先图后文）"""
    path = _normalize_path(image_path)
    try:
        wx = get_wx()
        wx.ChatWith(to)
        time.sleep(0.5)
        wx.SendFiles(path)
        time.sleep(1)
        wx.SendMsg(message)
        return {"success": True, "to": to, "type": "text+image"}
    except Exception:
        try:
            result = _send_via_keyboard(to, message, path)
            result["type"] = "text+image"
            result["fallback"] = "keyboard"
            return result
        except Exception as e:
            return {"success": False, "to": to, "error": str(e)}


def broadcast_text(targets, message, interval=0.8, prefer_manual=False):
    """群发纯文本"""
    results = []
    for i, target in enumerate(targets):
        result = _send_direct_preferred(target, message) if prefer_manual else send_text(target, message)
        results.append({"to": target, "success": result.get("success", False), "error": result.get("error"), "fallback": result.get("fallback")})
        if i < len(targets) - 1:
            time.sleep(interval)

    success_count = sum(1 for r in results if r["success"])
    return {
        "success": success_count > 0,
        "total": len(targets),
        "sent": success_count,
        "failed": len(targets) - success_count,
        "results": results,
        "mode": "manual_only" if prefer_manual else "default"
    }


def broadcast_image(targets, image_path, message=None, interval=0.8, prefer_manual=False):
    """群发图文（可选纯图片）"""
    results = []
    for i, target in enumerate(targets):
        result = _send_direct_preferred(target, message or "", image_path) if prefer_manual else (send_text_and_image(target, message or "", image_path) if message else send_image(target, image_path))
        results.append({"to": target, "success": result.get("success", False), "error": result.get("error"), "fallback": result.get("fallback")})
        if i < len(targets) - 1:
            time.sleep(interval)

    success_count = sum(1 for r in results if r["success"])
    return {
        "success": success_count > 0,
        "total": len(targets),
        "sent": success_count,
        "failed": len(targets) - success_count,
        "results": results,
        "mode": "manual_only" if prefer_manual else "default"
    }


# ============================================================
# 会话管理
# ============================================================

def get_sessions():
    """获取当前聊天会话列表"""
    result = {"success": False, "sessions": [], "error": "", "stage": "init"}

    def _worker():
        pythoncom.CoInitialize()
        try:
            result["stage"] = "wxauto"
            _debug_log('get_sessions worker start: wxauto')
            try:
                sessions = _get_sessions_via_wxauto()
            except Exception as e:
                _debug_log(f'get_sessions wxauto failed: {e}')
                result["wxauto_error"] = str(e)
                result["stage"] = "uia_fallback"
                sessions = _get_sessions_from_main_window()
            if not sessions:
                result["stage"] = "uia_fallback"
                _debug_log('get_sessions fallback start: uia')
                sessions = _get_sessions_from_main_window()
            result["success"] = True
            result["sessions"] = sessions
            result["stage"] = "done"
            _debug_log(f'get_sessions success count={len(sessions)}')
        except Exception as e:
            result["error"] = str(e)
            _debug_log(f'get_sessions error stage={result.get("stage")} error={e}')
        finally:
            pythoncom.CoUninitialize()

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(10)
    if t.is_alive():
        _debug_log(f'get_sessions timeout stage={result.get("stage")}')
        return {
            "success": False,
            "stage": result.get('stage'),
            "can_manual_send": True,
            "wxauto_error": result.get('wxauto_error', ''),
            "error": f"获取会话列表超时，当前卡在 {result.get('stage')} 阶段。请保持微信聊天首页可见后重试；你也可以先手动输入联系人直接发送。"
        }
    if result["success"]:
        return {"success": True, "sessions": result["sessions"], "stage": "done", "can_manual_send": True}

    raw_error = str(result['error'] or '')
    wxauto_error = str(result.get('wxauto_error') or '')
    if 'UIA 组件加载失败' in raw_error:
        if wxauto_error:
            friendly_error = f"获取会话列表失败：wxauto 原生抓取失败（{wxauto_error}），UIA 兜底也不可用（{raw_error}）。你仍可先手动输入联系人直接发送。"
        else:
            friendly_error = f"获取会话列表失败（阶段: {result.get('stage')}）：当前打包环境缺少 UIA 组件依赖。你仍可先手动输入联系人直接发送。详情：{raw_error}"
    elif '未定位到聊天会话列表' in raw_error or '会话列表为空' in raw_error:
        friendly_error = f"获取会话列表失败（阶段: {result.get('stage')}）：当前微信未停留在聊天首页。请先切到聊天列表；你也可以先手动输入联系人直接发送。"
    else:
        friendly_error = f"获取会话列表失败（阶段: {result.get('stage')}），请先手动输入联系人或保持微信主窗口可见: {raw_error}"

    return {"success": False, "stage": result.get('stage'), "can_manual_send": True, "wxauto_error": wxauto_error, "error": friendly_error}


def match_sessions(keywords):
    """根据关键词模糊匹配会话"""
    result = get_sessions()
    if not result["success"]:
        return result
    sessions = result["sessions"]
    matched = []
    for session in sessions:
        name = session.get("name", "")
        content = session.get("content", "")
        haystack = f"{name}\n{content}"
        for kw in keywords:
            if kw and kw in haystack:
                matched.append(session)
                break
    return {"success": True, "matched": matched, "total": len(sessions)}


def _extract_session_names(sessions):
    names = []
    for session in sessions:
        if isinstance(session, dict):
            name = session.get("name") or session.get("content") or session.get("id")
            if name:
                names.append(name)
        elif session:
            names.append(str(session))
    return names


# ============================================================
# 全量群发
# ============================================================

def broadcast_all_text(message, exclude=None):
    """全量群发文本"""
    result = get_sessions()
    if not result["success"]:
        return result
    all_sessions = _extract_session_names(result["sessions"])
    if exclude:
        all_sessions = [s for s in all_sessions if s not in exclude]
    return broadcast_text(all_sessions, message)


def broadcast_all_image(image_path, message=None, exclude=None):
    """全量群发图片"""
    result = get_sessions()
    if not result["success"]:
        return result
    all_sessions = _extract_session_names(result["sessions"])
    if exclude:
        all_sessions = [s for s in all_sessions if s not in exclude]
    return broadcast_image(all_sessions, image_path, message)


# ============================================================
# 定时发送
# ============================================================

def schedule_broadcast(targets, message, scheduled_at, image_path=None):
    """安排定时群发任务"""
    global _task_counter
    _task_counter += 1
    task_id = str(_task_counter)

    try:
        scheduled_dt = datetime.datetime.fromisoformat(scheduled_at)
        now = datetime.datetime.now()
        delay = (scheduled_dt - now).total_seconds()

        if delay <= 0:
            return {"success": False, "error": "定时时间已过"}

        task_info = {
            "id": task_id,
            "targets": targets,
            "message": message,
            "image_path": image_path,
            "scheduled_at": scheduled_at,
            "status": "pending",
            "created_at": now.isoformat()
        }
        _scheduled_tasks[task_id] = task_info

        def _run_scheduled():
            time.sleep(delay)
            try:
                task_info["status"] = "running"
                if image_path and os.path.exists(image_path):
                    result = broadcast_image(targets, image_path, message)
                else:
                    result = broadcast_text(targets, message)
                task_info["result"] = result
                task_info["status"] = "completed" if result.get("success") else "failed"
            except Exception as e:
                task_info["status"] = "failed"
                task_info["result"] = {"success": False, "error": str(e)}

        t = threading.Thread(target=_run_scheduled, daemon=True)
        t.start()

        return {
            "success": True,
            "task_id": task_id,
            "scheduled_at": scheduled_at,
            "delay_seconds": int(delay),
            "targets_count": len(targets)
        }
    except Exception as e:
        return {"success": False, "error": f"创建定时任务失败: {str(e)}"}


def get_scheduled_tasks():
    """获取所有定时任务状态"""
    tasks = []
    for tid, info in _scheduled_tasks.items():
        tasks.append({
            "id": tid,
            "targets_count": len(info["targets"]),
            "message_preview": info["message"][:50] + ("..." if len(info["message"]) > 50 else ""),
            "scheduled_at": info["scheduled_at"],
            "status": info["status"]
        })
    return {"success": True, "tasks": tasks}


def cancel_scheduled_task(task_id):
    """取消定时任务"""
    if task_id in _scheduled_tasks:
        if _scheduled_tasks[task_id]["status"] == "pending":
            _scheduled_tasks[task_id]["status"] = "cancelled"
            return {"success": True, "message": "任务已取消"}
        return {"success": False, "error": "任务已开始执行，无法取消"}
    return {"success": False, "error": "任务不存在"}


# ============================================================
# 状态检查
# ============================================================

def check_status():
    """检查微信是否在线"""
    global _wx_instance
    if _wx_instance is None:
        return {"success": True, "online": False, "info": "未连接，点击「加载」连接微信"}
    try:
        online = _wx_instance.IsOnline()
        return {"success": True, "online": online, "info": "已连接" if online else "微信离线"}
    except Exception:
        _wx_instance = None
        return {"success": True, "online": False, "info": "连接断开，请重新加载"}


# ============================================================
# AI 文案生成
# ============================================================

def generate_marketing_copy(product_info, style="朋友圈"):
    """生成营销文案"""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from ai_copywriter import generate_copy
        copy = generate_copy(product_info, style=style)
        return {"success": True, "copy": copy, "style": style}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================
# CLI 接口
# ============================================================

def run_command(cmd_json):
    """统一命令入口"""
    try:
        cmd = json.loads(cmd_json) if isinstance(cmd_json, str) else cmd_json
    except json.JSONDecodeError:
        return {"success": False, "error": "命令格式错误，需要 JSON"}

    action = cmd.get("action", "")

    actions = {
        "send_text": lambda: send_text(cmd["to"], cmd["message"]),
        "send_image": lambda: send_image(cmd["to"], cmd["image_path"]),
        "send_text_image": lambda: send_text_and_image(cmd["to"], cmd["message"], cmd["image_path"]),
        "broadcast_text": lambda: broadcast_text(cmd["targets"], cmd["message"]),
        "broadcast_image": lambda: broadcast_image(cmd["targets"], cmd["image_path"], cmd.get("message")),
        "broadcast_all_text": lambda: broadcast_all_text(cmd["message"], cmd.get("exclude")),
        "broadcast_all_image": lambda: broadcast_all_image(cmd["image_path"], cmd.get("message"), cmd.get("exclude")),
        "get_sessions": lambda: get_sessions(),
        "match_sessions": lambda: match_sessions(cmd["keywords"]),
        "check_status": lambda: check_status(),
        "generate_copy": lambda: generate_marketing_copy(cmd["product_info"], cmd.get("style", "朋友圈")),
        "schedule_broadcast": lambda: schedule_broadcast(
            cmd["targets"], cmd["message"], cmd["scheduled_at"], cmd.get("image_path")
        ),
        "get_scheduled_tasks": lambda: get_scheduled_tasks(),
        "cancel_scheduled_task": lambda: cancel_scheduled_task(cmd["task_id"]),
    }

    if action in actions:
        return actions[action]()
    else:
        return {"success": False, "error": f"未知操作: {action}", "available": list(actions.keys())}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        cmd_json = sys.argv[1]
        result = run_command(cmd_json)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("=" * 60)
        print("  壹准 AI 营销助手 - 微信自动化服务 v3.0")
        print("  基于 wxauto4 41.1.2")
        print("=" * 60)
        print("\n可用操作:")
        for i, op in enumerate([
            "send_text", "send_image", "send_text_image",
            "broadcast_text", "broadcast_image",
            "broadcast_all_text", "broadcast_all_image",
            "get_sessions", "match_sessions", "check_status",
            "generate_copy", "schedule_broadcast",
            "get_scheduled_tasks", "cancel_scheduled_task"
        ], 1):
            print(f"  {i:2d}. {op}")
