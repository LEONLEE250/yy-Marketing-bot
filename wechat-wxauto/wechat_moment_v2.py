"""
壹准 AI 营销助手 - 朋友圈自动发布 v2.1 (任务状态机)
支持：文字 / 图片 / 视频 / 定时发布 / 取消 / 步骤日志 / 发布校验

技术栈: UIA 优先 + pyautogui 兜底 + pyperclip 粘贴
"""

import sys, os, time, threading, traceback, datetime, json, uuid
import pythoncom, pyautogui, pyperclip

pyautogui.FAILSAFE = False
WORK_DIR = os.path.dirname(os.path.abspath(__file__))
_DEBUG_LOG = os.path.join(WORK_DIR, 'moment_debug.log')
_OUTPUT_DIR = os.path.join(WORK_DIR, 'output')
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_VIDEO_EXTS = {'.mp4', '.mov', '.avi', '.wmv', '.mkv', '.flv', '.m4v', '.webm'}
_IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tiff'}

# ── 任务存储 ──────────────────────────────────────────
_tasks: dict = {}
_event_logs: dict = {}  # task_id → list of event dicts
_task_lock = threading.Lock()
MAX_EVENTS_PER_TASK = 500


class TaskCancelled(Exception):
    """任务被取消"""
    pass


# ── 日志 ──────────────────────────────────────────────

def _log(msg: str):
    try:
        ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with open(_DEBUG_LOG, 'a', encoding='utf-8') as f:
            f.write(f'[{ts}] {msg}\n')
    except:
        pass


def _emit_event(task_id: str, level: str, step: str, message: str, extra: dict = None):
    """写入结构化事件日志（内存 + 文件）"""
    event = {
        "timestamp": datetime.datetime.now().isoformat(),
        "level": level,
        "step": step,
        "message": message,
        "extra": extra or {},
    }
    with _task_lock:
        if task_id not in _event_logs:
            _event_logs[task_id] = []
        logs = _event_logs[task_id]
        logs.append(event)
        if len(logs) > MAX_EVENTS_PER_TASK:
            _event_logs[task_id] = logs[-MAX_EVENTS_PER_TASK:]
    _log(f'[{task_id}] [{level}] [{step}] {message}')


def _update_step(task_id: str, step_name: str, status: str, detail: str = '', error: str = ''):
    """更新任务步骤状态"""
    with _task_lock:
        task = _tasks.get(task_id)
        if not task:
            return
        steps = task.setdefault("steps", [])
        now = datetime.datetime.now().isoformat()
        # 找已有步骤
        found = None
        for s in steps:
            if s["name"] == step_name:
                found = s
                break
        if found:
            found["status"] = status
            found["end_time"] = now
            if detail:
                found["detail"] = detail
            if error:
                found["error"] = error
        else:
            steps.append({
                "name": step_name,
                "status": status,
                "start_time": now,
                "end_time": None,
                "detail": detail,
                "error": error,
            })
        task["current_step"] = step_name


# ── 窗口操作 ──────────────────────────────────────────

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
    """在 UIA 树中找第一个匹配元素"""
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


def _find_any_uia(**filters) -> object:
    """
    全局 UIA 搜索 — 遍历所有可见顶层窗口的 UIA 树。
    Qt 弹出菜单通常无窗口标题，因此不再要求 GetWindowText 非空。
    """
    import win32gui
    top_wnds = []

    def _enum_top(hwnd, res):
        try:
            if not win32gui.IsWindowVisible(hwnd):
                return
            r = win32gui.GetWindowRect(hwnd)
            w, h = r[2] - r[0], r[3] - r[1]
            # 放开尺寸门槛：小弹窗也要搜（菜单可能只有几十像素宽）
            if w < 20 or h < 20:
                return
            res.append(hwnd)
        except:
            pass

    win32gui.EnumWindows(_enum_top, top_wnds)
    # 先搜有标题的窗口，再搜无标题的弹窗（防止大窗口覆盖小弹窗的 UIA 匹配）
    titled = [w for w in top_wnds if win32gui.GetWindowText(w)]
    untitled = [w for w in top_wnds if not win32gui.GetWindowText(w)]
    for hwnd in titled[:10] + untitled[:10]:
        ctrl = _find_uia_control(hwnd, **filters)
        if ctrl:
            return ctrl
    return None


# ── 导航 ──────────────────────────────────────────────

def _goto_discover(win: dict):
    """导航到「发现」tab。策略：UIA > 键盘快捷键 > 安全坐标兜底"""
    _ensure_foreground(win)
    hwnd, x, y, w, h = win["hwnd"], win["rect"][0], win["rect"][1], win["w"], win["h"]

    # 1) UIA 搜索「发现」tab
    btn = (_find_uia_control(hwnd, ClassName="mmui::XTabBarItem", Name="发现")
           or _find_uia_control(hwnd, Name="发现")
           or _find_any_uia(Name="发现"))
    if btn:
        btn.Click(simulateMove=False)
        time.sleep(1.0)
        return

    # 2) 键盘导航：Ctrl+3 或 Ctrl+4（部分微信版本「发现」在第3/4位）
    for combo in (('ctrl', '3'), ('ctrl', '4')):
        try:
            pyautogui.hotkey(*combo)
            time.sleep(0.8)
            return
        except:
            continue

    # 3) 坐标兜底：左侧栏 25% 高度 ≈ 第3-4项（比之前 48% 安全得多，不会误触游戏）
    px, py = x + int(w * 0.04), y + int(h * 0.25)
    _log(f'[goto_discover] UIA/keys failed, fallback click ({px}, {py})')
    pyautogui.click(px, py)
    time.sleep(1.0)


def _goto_moments(win: dict):
    """在发现页点击「朋友圈」。策略：UIA > 安全坐标"""
    hwnd, x, y, w, h = win["hwnd"], win["rect"][0], win["rect"][1], win["w"], win["h"]
    btn = (_find_uia_control(hwnd, Name="朋友圈")
           or _find_any_uia(Name="朋友圈")
           or _find_uia_control(hwnd, Name="Moments"))
    if btn:
        btn.Click(simulateMove=False)
        time.sleep(1.2)
        return
    # 朋友圈通常位于发现页的顶部区域，50%x|20%y 是安全坐标
    px, py = x + int(w * 0.50), y + int(h * 0.20)
    _log(f'[goto_moments] UIA failed, fallback click ({px}, {py})')
    pyautogui.click(px, py)
    time.sleep(1.2)


# ── 发布动作 ──────────────────────────────────────────

# 记录上一次点击相机按钮的屏幕坐标，供菜单定位使用
_last_camera_click = None


def _click_camera_icon(win: dict, long_press: bool = False):
    """点相机按钮。long_press=True 则长按打开纯文字编辑器。
    使用绝对像素坐标：右侧 55px、顶部 75px"""
    global _last_camera_click
    hwnd = win["hwnd"]
    x, y, w, h = win["rect"][0], win["rect"][1], win["w"], win["h"]
    # 搜索相机按钮
    btn = (_find_uia_control(hwnd, Name="相机")
           or _find_uia_control(hwnd, AutomationId="CameraBtn")
           or _find_any_uia(Name="相机"))
    if btn:
        try:
            r = btn.BoundingRectangle
            cx, cy = int(r.left + r.width() / 2), int(r.top + r.height() / 2)
            _last_camera_click = (cx, cy)
            pyautogui.moveTo(cx, cy)
            time.sleep(0.15)
            if long_press:
                pyautogui.mouseDown(); time.sleep(1.5); pyautogui.mouseUp()
            else:
                pyautogui.click()
            time.sleep(0.8)
            return
        except Exception as e:
            _log(f'[click_camera] UIA click failed: {e}')
    # 坐标兜底：绝对像素 (right-55, top+75)
    cx, cy = x + w - 55, y + 75
    _last_camera_click = (cx, cy)
    _log(f'[click_camera] fallback click abs ({cx},{cy}) long_press={long_press}')
    pyautogui.moveTo(cx, cy)
    time.sleep(0.15)
    if long_press:
        pyautogui.mouseDown(); time.sleep(1.5); pyautogui.mouseUp()
    else:
        pyautogui.click()
    time.sleep(0.8)


def _paste_text(text: str, win: dict = None):
    """
    在朋友圈编辑器中粘贴文字。
    先点击编辑器中心区域确保焦点在编辑器内，避免文字进聊天框。
    """
    # 先点击编辑器中央（确保键盘输入进编辑器而不是后面的聊天窗口）
    if win:
        x, y, w, h = win["rect"][0], win["rect"][1], win["w"], win["h"]
        # 微信朋友圈编辑器文字区域通常在中间偏上
        cx, cy = x + int(w * 0.50), y + int(h * 0.55)
        pyautogui.click(cx, cy)
        time.sleep(0.4)

    pyperclip.copy(text)
    time.sleep(0.2)
    pyautogui.hotkey('ctrl', 'v')
    time.sleep(0.5)
    _log(f'[paste_text] pasted {len(text)} chars')


def _select_files_in_dialog(file_paths: list):
    """
    在文件对话框中选中文件。
    对话框打开后复制完整路径到剪贴板 → Ctrl+A Ctrl+V Enter。
    """
    if not file_paths:
        return

    abs_paths = [os.path.abspath(p) for p in file_paths]
    dir_part = os.path.dirname(abs_paths[0])
    _log(f'[select_files] waiting dialog, dir={dir_part}, count={len(abs_paths)}')

    # 等对话框
    for _ in range(12):
        if _is_file_dialog_open():
            break
        time.sleep(0.5)
    if not _is_file_dialog_open():
        _log('[select_files] WARNING: no dialog detected')
    time.sleep(0.6)

    # 多文件：先粘贴目录导航，再粘贴文件名声选择
    if len(abs_paths) > 1:
        # 多图：先导航到目录 → 再粘贴多文件名选中
        pyautogui.hotkey('alt', 'd')
        time.sleep(0.3)
        pyautogui.hotkey('ctrl', 'a')
        time.sleep(0.1)
        pyperclip.copy(dir_part)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.2)
        pyautogui.press('enter')
        time.sleep(1.5)
        # 粘贴文件名（带引号空格分隔）
        pyautogui.hotkey('alt', 'n')
        time.sleep(0.3)
        names = ' '.join(f'"{os.path.basename(p)}"' for p in abs_paths)
        pyautogui.hotkey('ctrl', 'a')
        time.sleep(0.1)
        pyperclip.copy(names)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.3)
        pyautogui.press('enter')
        time.sleep(2.5)
    else:
        # 单文件：直接在文件名框粘贴完整路径
        _log(f'[select_files] paste path: {abs_paths[0]}')
        pyperclip.copy(abs_paths[0])
        time.sleep(0.15)
        pyautogui.hotkey('ctrl', 'a')
        time.sleep(0.1)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.4)
        pyautogui.press('enter')
        time.sleep(2.5)

    if not _is_file_dialog_open():
        _log('[select_files] success')


def _is_file_dialog_open() -> bool:
    """检查是否有文件选择对话框窗口仍存在"""
    import win32gui
    result = []

    def _enum(hwnd, res):
        try:
            if not win32gui.IsWindowVisible(hwnd):
                return
            title = win32gui.GetWindowText(hwnd)
            cls = win32gui.GetClassName(hwnd)
            if any(kw in title for kw in ("打开", "Open", "选择", "Select", "上传", "选取")):
                res.append(hwnd)
            elif cls in ("#32770",) and any(kw in title.lower() for kw in ("open", "file")):
                res.append(hwnd)
        except:
            pass

    win32gui.EnumWindows(_enum, result)
    return len(result) > 0


def _click_media_source_menu():
    """
    点相机后微信弹出菜单，选「从手机相册选择」。
    策略：纯键盘 + 鼠标坐标双路并行，覆盖不同微信版本
    """
    global _last_camera_click
    time.sleep(0.6)

    # 先点一下菜单区确保焦点
    if _last_camera_click:
        pyautogui.click(_last_camera_click[0], _last_camera_click[1] + 20)
        time.sleep(0.3)

    # 键盘：按 down 到「从手机相册选择」
    for down_count in (1, 2, 3):
        _log(f'[media_menu] keyboard down*{down_count}')
        pyautogui.press('up', presses=5, interval=0.05)
        time.sleep(0.15)
        pyautogui.press('down', presses=down_count, interval=0.1)
        time.sleep(0.2)
        pyautogui.press('enter')
        time.sleep(2.0)
        if _is_file_dialog_open():
            _log(f'[media_menu] keyboard down*{down_count} OK')
            return

    # 键盘失败 → 坐标点击
    if _last_camera_click:
        cx, cy = _last_camera_click
        _log(f'[media_menu] keyboard all failed, try mouse offsets from ({cx},{cy})')
        for offset_y in (55, 70, 85, 100):
            pyautogui.click(cx + 8, cy + offset_y)
            time.sleep(1.5)
            if _is_file_dialog_open():
                _log(f'[media_menu] mouse offset_y={offset_y} OK')
                return

    _log('[media_menu] ALL strategies failed')


def _click_publish(win: dict):
    """点击发表按钮。策略：Ctrl+Enter 快捷键 > UIA > 坐标兜底"""
    hwnd = win["hwnd"]
    x, y, w, h = win["rect"][0], win["rect"][1], win["w"], win["h"]

    # 1) 微信原生快捷键：Ctrl+Enter 发表朋友圈（最可靠）
    _log('[click_publish] trying Ctrl+Enter shortcut')
    pyautogui.hotkey('ctrl', 'enter')
    time.sleep(2.0)

    # 2) 同时检查 UIA 是否有「发表」按钮残留（若残留说明快捷键没生效，再补一次 UIA 点击）
    btn = (_find_any_uia(Name="发表")
           or _find_any_uia(Name="發布")
           or _find_any_uia(Name="Publish"))
    if not btn:
        btn = _find_uia_control(hwnd, Name="发表") or _find_uia_control(hwnd, Name="發布")
    if btn:
        _log('[click_publish] UIA button found, clicking as backup')
        try:
            btn.Click(simulateMove=False)
            time.sleep(1.5)
            return
        except Exception as e:
            _log(f'[click_publish] UIA click failed: {e}')

    # 3) 坐标兜底：右上角（微信朋友圈编辑器发表按钮区域）
    px, py = x + int(w * 0.90), y + int(h * 0.08)
    _log(f'[click_publish] fallback click ({px}, {py})')
    pyautogui.click(px, py)
    time.sleep(1.5)


def _verify_publish_result(win: dict) -> dict:
    """
    校验发布是否真的成功。
    策略：发表后检查编辑态是否已消失、是否回到朋友圈内容页。
    """
    hwnd = win["hwnd"]

    # 1. 等待编辑器关闭（通常 Ctrl+Enter 后 1-2 秒即关闭）
    time.sleep(1.5)

    # 2. 检查「发表」按钮是否还存在（存在=编辑态未退出）
    btn = (_find_any_uia(Name="发表") or _find_any_uia(Name="發布")
           or _find_uia_control(hwnd, Name="发表") or _find_uia_control(hwnd, Name="發布"))
    if btn:
        return {"verified": False, "reason": "发表按钮仍存在，编辑态未退出"}

    # 3. 检查微信窗口标题是否包含朋友圈（回到朋友圈页面的标志）
    import win32gui
    title = win32gui.GetWindowText(hwnd)
    if "朋友圈" not in title:
        # 不在朋友圈页，可能卡在编辑页或其他页面
        return {"verified": False, "reason": f"未回到朋友圈页，当前窗口: {title}"}

    # 4. 检查是否有错误弹窗
    error_keywords = ["错误", "失败", "异常", "重试", "发送失败"]
    for kw in error_keywords:
        if kw in title:
            return {"verified": False, "reason": f"检测到异常窗口: {title}"}

    return {"verified": True, "reason": "编辑态已退出，已回到朋友圈页"}


# ── 任务主流程 ────────────────────────────────────────

def _run_task(task_id: str, text: str, media_paths: list, media_type: str):
    """
    执行任务状态机。每一步都记录到 task["steps"] 和事件日志中。
    media_paths: 文件路径列表
    返回最终状态字符串：completed / failed / cancelled
    """
    task = _tasks.get(task_id)
    if not task:
        return "failed"

    def _check_cancel():
        with _task_lock:
            t = _tasks.get(task_id)
            if t and t.get("cancel_requested"):
                raise TaskCancelled("任务已被取消")

    def _step(step_name: str, fn, *args):
        _check_cancel()
        _update_step(task_id, step_name, "current")
        _emit_event(task_id, "info", step_name, "开始执行")
        try:
            result = fn(*args)
            _update_step(task_id, step_name, "done", detail="完成")
            _emit_event(task_id, "success", step_name, "执行成功")
            return result
        except TaskCancelled:
            _update_step(task_id, step_name, "error", error="任务被取消")
            _emit_event(task_id, "warn", step_name, "任务被取消")
            raise
        except Exception as e:
            _update_step(task_id, step_name, "error", error=str(e))
            _emit_event(task_id, "error", step_name, f"执行失败: {e}")
            raise

    pythoncom.CoInitialize()
    try:
        _check_cancel()

        # Step 1: 验证输入
        _step("validating_input", lambda: None)

        # Step 2: 查找微信窗口
        win = _step("locating_wechat", _get_wechat_window)

        # Step 3: 确保窗口在前台
        _step("focusing_wechat", _ensure_foreground, win)

        # Step 4: 导航到发现页（键盘 Ctrl+3）
        _step("navigating_discover", lambda: _goto_discover(win))

        # Step 5: 进入朋友圈（纯坐标）
        _step("navigating_moments", lambda: _goto_moments(win))

        # Step 6: 打开编辑器
        is_text_only = not media_paths
        if is_text_only:
            _step("opening_editor", lambda: _click_camera_icon(win, True))
        else:
            _step("opening_editor", lambda: _click_camera_icon(win, False))

        # Step 7: 处理媒体菜单 (点击相机后弹出的菜单)
        if not is_text_only:
            _step("selecting_source", _click_media_source_menu)

            # Step 8: 在文件对话框中选择文件
            _step("selecting_media", _select_files_in_dialog, media_paths)

            # Step 9: 等待媒体加载
            wait_time = 4.0 if media_type == "video" else 2.0
            _step("waiting_media_ready", _sleep_with_cancel, task_id, wait_time)

        # Step 10: 输入文字（先点编辑器再粘贴，避免进聊天框）
        if text:
            _step("inputting_text", _paste_text, text, win)

        # Step 11: 点击发表
        _step("submitting", _click_publish, win)

        # Step 12: 校验结果
        verify = _step("verifying_result", _verify_publish_result, win)

        if verify.get("verified"):
            _emit_event(task_id, "success", "completed", f"发布成功: {verify.get('reason', '')}")
            return "completed"
        else:
            _emit_event(task_id, "warn", "completed", f"发布未确认成功: {verify.get('reason', '')}")
            task["verify_detail"] = verify
            return "completed"  # 仍视为完成，但附校验信息

    except TaskCancelled:
        with _task_lock:
            _tasks[task_id]["status"] = "cancelled"
        _emit_event(task_id, "warn", "cancelled", "任务被取消")
        return "cancelled"
    except Exception as e:
        _emit_event(task_id, "error", "failed", f"任务失败: {e}\n{traceback.format_exc()}")
        with _task_lock:
            _tasks[task_id]["error"] = str(e)
        return "failed"
    finally:
        pythoncom.CoUninitialize()


def _sleep_with_cancel(task_id: str, seconds: float):
    """可被取消的 sleep：每 0.5 秒检查一次取消令牌"""
    intervals = int(seconds / 0.5)
    for _ in range(max(intervals, 1)):
        time.sleep(0.5)
        with _task_lock:
            t = _tasks.get(task_id)
            if t and t.get("cancel_requested"):
                raise TaskCancelled("任务已被取消")


# ── 公开 API ──────────────────────────────────────────

def publish(text: str, media_paths=None, media_type: str = "image") -> dict:
    """
    发布朋友圈（立即执行）。返回包含 task_id 的响应，前端可轮询。
    media_paths: 图片路径列表（最多9张）或视频单路径字符串
    """
    # 统一为列表
    if media_paths is None:
        media_paths = []
    elif isinstance(media_paths, str):
        media_paths = [media_paths]

    if not text and not media_paths:
        return {"success": False, "error": "请至少输入文字或选择媒体文件"}

    for p in media_paths:
        if not os.path.isfile(p):
            return {"success": False, "error": f"媒体文件不存在: {p}"}

    if media_type == "auto" and media_paths:
        ext = os.path.splitext(media_paths[0])[1].lower()
        if ext in _VIDEO_EXTS:
            media_type = "video"
        elif ext in _IMAGE_EXTS:
            media_type = "image"
        else:
            return {"success": False, "error": f"不支持的媒体格式: {ext}"}

    # 校验限制
    if media_type == "image" and len(media_paths) > 9:
        return {"success": False, "error": "图片最多9张"}
    if media_type == "video" and len(media_paths) > 1:
        return {"success": False, "error": "视频最多1个"}

    # 创建任务
    task_id = f"moment-{uuid.uuid4().hex[:8]}"
    now = datetime.datetime.now()
    task = {
        "id": task_id,
        "task_id": task_id,
        "text": text,
        "media_paths": media_paths,
        "media_type": media_type,
        "status": "running",
        "current_step": "",
        "steps": [],
        "cancel_requested": False,
        "created_at": now.isoformat(),
        "scheduled_at": None,
        "error": None,
    }
    with _task_lock:
        _tasks[task_id] = task

    _emit_event(task_id, "info", "created", f"任务创建, text_len={len(text)}, media_count={len(media_paths)}, type={media_type}")

    # 在线程中执行
    def _exec():
        final_status = _run_task(task_id, text, media_paths, media_type)
        with _task_lock:
            t = _tasks.get(task_id)
            if t:
                t["status"] = final_status
                t["completed_at"] = datetime.datetime.now().isoformat()
        _emit_event(task_id, "info", "done", f"任务结束, status={final_status}")

    t = threading.Thread(target=_exec, daemon=True)
    t.start()

    return {
        "success": True,
        "task_id": task_id,
        "status": "running",
    }


def schedule(text: str, scheduled_at: str, media_paths=None) -> dict:
    """
    定时发布朋友圈。
    media_paths: 图片路径列表或视频单路径字符串
    scheduled_at: ISO 格式 "2026-06-05T18:30:00"
    """
    if media_paths is None:
        media_paths = []
    elif isinstance(media_paths, str):
        media_paths = [media_paths]

    if not text and not media_paths:
        return {"success": False, "error": "请至少输入文字或选择媒体文件"}

    try:
        scheduled_dt = datetime.datetime.fromisoformat(scheduled_at)
        now = datetime.datetime.now()
        delay = (scheduled_dt - now).total_seconds()
        if delay <= 0:
            return {"success": False, "error": "定时时间已过，请选择未来时间"}
    except Exception:
        return {"success": False, "error": "时间格式错误，请使用 YYYY-MM-DDTHH:MM:SS"}

    task_id = f"moment-{uuid.uuid4().hex[:8]}"
    task = {
        "id": task_id,
        "task_id": task_id,
        "text": text,
        "media_paths": media_paths,
        "media_type": "auto",
        "status": "pending",
        "current_step": "",
        "steps": [],
        "cancel_requested": False,
        "created_at": now.isoformat(),
        "scheduled_at": scheduled_at,
        "error": None,
    }
    with _task_lock:
        _tasks[task_id] = task

    _emit_event(task_id, "info", "scheduled", f"定时任务创建, 将于 {scheduled_at} 执行, delay={int(delay)}s")

    def _exec():
        # 分段 sleep，便于取消
        try:
            _sleep_with_cancel(task_id, delay)

            with _task_lock:
                _tasks[task_id]["status"] = "running"

            # 检测媒体类型
            mt = "auto"
            if media_paths:
                ext = os.path.splitext(media_paths[0])[1].lower()
                if ext in _VIDEO_EXTS:
                    mt = "video"
                elif ext in _IMAGE_EXTS:
                    mt = "image"

            final_status = _run_task(task_id, text, media_paths, mt)
            with _task_lock:
                t = _tasks.get(task_id)
                if t:
                    t["status"] = final_status
                    t["completed_at"] = datetime.datetime.now().isoformat()

        except TaskCancelled:
            _emit_event(task_id, "warn", "cancelled", "定时任务被取消")
        except Exception as e:
            _emit_event(task_id, "error", "failed", f"定时任务异常: {e}")
            with _task_lock:
                t = _tasks.get(task_id)
                if t:
                    t["status"] = "failed"
                    t["error"] = str(e)

    threading.Thread(target=_exec, daemon=True).start()

    return {
        "success": True,
        "task_id": task_id,
        "scheduled_at": scheduled_at,
        "delay_seconds": int(delay),
    }


def get_task(task_id: str) -> dict:
    """获取单个任务详情"""
    with _task_lock:
        t = _tasks.get(task_id)
        if not t:
            return {"success": False, "error": "任务不存在"}
        return {"success": True, **t}


def get_tasks(status: str = None) -> dict:
    """获取任务列表，可按状态筛选"""
    with _task_lock:
        tasks = list(_tasks.values())
    if status:
        tasks = [t for t in tasks if t.get("status") == status]
    # 最新在前
    tasks.sort(key=lambda t: t.get("created_at", ""), reverse=True)
    return {"success": True, "tasks": tasks}


def get_task_logs(task_id: str, limit: int = 100) -> dict:
    """获取任务事件日志"""
    with _task_lock:
        logs = _event_logs.get(task_id, [])
    return {"success": True, "task_id": task_id, "logs": logs[-limit:]}


def cancel_scheduled(task_id: str) -> dict:
    """取消任务（定时或执行中的）"""
    with _task_lock:
        t = _tasks.get(task_id)
        if not t:
            return {"success": False, "error": "任务不存在"}
        if t["status"] in ("completed", "failed", "cancelled"):
            return {"success": False, "error": f"任务已结束({t['status']})，无法取消"}
        t["cancel_requested"] = True
        t["status"] = "cancelled"
        _emit_event(task_id, "warn", "cancelled", "取消请求已发出")
    return {"success": True, "message": "已取消"}


def get_scheduled_moments() -> list:
    """获取所有定时任务（兼容旧接口）"""
    with _task_lock:
        tasks = [t for t in _tasks.values() if t.get("status") in ("pending",)]
    return [
        {
            "id": t["id"],
            "scheduled_at": t.get("scheduled_at", ""),
            "text_preview": t["text"][:50] + ("..." if len(t["text"]) > 50 else ""),
            "has_media": bool(t.get("media_path")),
            "status": t["status"],
        }
        for t in tasks
    ]


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
