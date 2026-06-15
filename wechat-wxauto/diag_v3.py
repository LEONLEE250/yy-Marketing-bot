# -*- coding: utf-8 -*-
"""v3 - 用 FindWindow 定位微信主窗口，逐步验证并截图"""
import sys, os, time, pythoncom
pythoncom.CoInitialize()

import pyautogui
from pywinauto import Application
import win32gui, win32process, psutil, win32con
pyautogui.FAILSAFE = False

BASE = r'C:\Users\EDY\WorkBuddy\2026-05-28-14-09-05'

def log(msg):
    print(f'[DIAG] {msg}', flush=True)

def screenshot(name):
    p = os.path.join(BASE, f'diagv3_{name}.png')
    pyautogui.screenshot().save(p)
    log(f'截图: {name}')

def find_wechat_by_enum():
    """EnumWindows 找所有微信窗口"""
    ws = []
    def _e(h, _):
        try:
            if not win32gui.IsWindow(h): return
            _, pid = win32process.GetWindowThreadProcessId(h)
            pn = psutil.Process(pid).name().lower()
            if 'wechat' not in pn and 'weixin' not in pn: return
            r = win32gui.GetWindowRect(h)
            w, h2 = r[2]-r[0], r[3]-r[1]
            if w < 100 or h2 < 100: return
            ws.append({'hwnd': h, 'rect': r, 'w': w, 'h': h2, 
                       'title': win32gui.GetWindowText(h)})
        except: pass
    win32gui.EnumWindows(_e, None)
    return ws

def get_main_hwnd():
    """用 FindWindow 获取微信主窗口正确的HWND"""
    h = win32gui.FindWindow('Qt51514QWindowIcon', None)
    if h and win32gui.IsWindow(h):
        r = win32gui.GetWindowRect(h)
        return {'hwnd': h, 'rect': r, 'w': r[2]-r[0], 'h': r[3]-r[1],
                'title': win32gui.GetWindowText(h)}
    return None

def fg(hwnd):
    try:
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.3)
    except: pass

# ═══════════════════════
log('STEP1: 获取微信主窗口 (FindWindow Qt51514QWindowIcon)')
main = get_main_hwnd()
if not main:
    log('FAIL: 找不到微信窗口!')
    sys.exit(1)
log(f'主窗口: HWND={main["hwnd"]} {main["w"]}x{main["h"]} rect={main["rect"]}')

fg(main['hwnd'])
time.sleep(0.5)
screenshot('01_main_window')

# ═══════════════════════
log('STEP2: UIA 点击侧边栏"朋友圈"')
app = Application(backend='uia').connect(handle=main['hwnd'])
win = app.window(handle=main['hwnd'])
btn = win.child_window(title='朋友圈', control_type='Button')
brect = btn.rectangle()
log(f'朋友圈按钮位置: ({brect.left},{brect.top})-({brect.right},{brect.bottom})')
btn.click_input()
time.sleep(2)
screenshot('02_clicked_moments_sidebar')

# ═══════════════════════
log('STEP3: 找朋友圈独立窗口')
sns = None
for _ in range(15):
    time.sleep(0.5)
    ws = find_wechat_by_enum()
    for w in ws:
        if '朋友圈' in w['title']:
            sns = w
            break
    if sns:
        break

if not sns:
    # 用 FindWindow mmui::SNSWindow 试试
    h2 = win32gui.FindWindow('mmui::SNSWindow', None)
    if h2:
        r2 = win32gui.GetWindowRect(h2)
        sns = {'hwnd': h2, 'rect': r2, 'w': r2[2]-r2[0], 'h': r2[3]-r2[1],
               'title': win32gui.GetWindowText(h2)}
        log(f'用FindWindow mmui::SNSWindow找到: {sns["w"]}x{sns["h"]} rect={sns["rect"]}')
    else:
        log('FAIL: 朋友圈窗口未找到! 屏幕截图:')
        screenshot('03_FAIL_no_sns')
        sys.exit(1)

log(f'朋友圈窗口: HWND={sns["hwnd"]} {sns["w"]}x{sns["h"]} rect={sns["rect"]}')
screenshot('03_sns_window')

# ═══════════════════════
log('STEP4: UIA 扫描朋友圈窗口工具栏')
fg(sns['hwnd'])
time.sleep(0.5)

sns_app = Application(backend='uia').connect(handle=sns['hwnd'])
sns_win = sns_app.window(handle=sns['hwnd'])

# 获取工具栏和发表按钮
try:
    toolbar = sns_win.child_window(auto_id='sns_window_tool_bar', control_type='ToolBar')
    trect = toolbar.rectangle()
    log(f'工具栏: ({trect.left},{trect.top})-({trect.right},{trect.bottom})')
    
    pub_btn = sns_win.child_window(title='发表', control_type='Button', found_index=0)
    prect = pub_btn.rectangle()
    log(f'发表按钮: ({prect.left},{prect.top})-({prect.right},{prect.bottom})')
    
    content_top = trect.bottom
    content_bottom = sns['rect'][3] - 5
    content_height = content_bottom - content_top
    cx = sns['rect'][0] + sns['w'] // 2
    
    log(f'内容区: top={content_top} bottom={content_bottom} height={content_height} cx={cx}')
    log(f'文本区(无图): ({cx}, {content_top + int(content_height * 0.35)})')
    log(f'文本区(有图): ({cx}, {content_top + int(content_height * 0.42)})')
    log(f'谁可以看: ({cx}, {content_top + int(content_height * 0.80)})')
    
    uia_ok = True
except Exception as e:
    log(f'UIA工具栏失败: {e}，用回退坐标')
    content_top = sns['rect'][1] + 60
    content_bottom = sns['rect'][3] - 10
    content_height = content_bottom - content_top
    cx = sns['rect'][0] + sns['w'] // 2
    uia_ok = False

# ═══════════════════════
log('STEP5: Escape关闭可能残留的编辑器')
pyautogui.press('escape')
time.sleep(0.5)

# ═══════════════════════
log('STEP6: 点击工具栏"发表"按钮')
if uia_ok:
    pub_btn.click_input()
else:
    btn_x = sns['rect'][0] + 86
    btn_y = sns['rect'][1] + 30
    pyautogui.click(btn_x, btn_y)

time.sleep(2)
screenshot('04_after_publish')

# ═══════════════════════
log('STEP7: 检查文件对话框')
dlg = None
def _fd(h, _):
    try:
        if win32gui.IsWindowVisible(h) and win32gui.GetClassName(h) == '#32770':
            dlg_title = win32gui.GetWindowText(h)
            if dlg_title:
                _fd.hwnd = h
                _fd.title = dlg_title
    except: pass
_fd.hwnd = None; _fd.title = ''
win32gui.EnumWindows(_fd, None)

if _fd.hwnd:
    log(f'文件对话框: "{_fd.title}" — 关闭它')
    fg(_fd.hwnd)
    time.sleep(0.3)
    pyautogui.press('escape')
    time.sleep(0.5)
    file_dlg = True
else:
    log('没有文件对话框')
    file_dlg = False

screenshot('05_editor_state')

# ═══════════════════════
log('')
log('========== 诊断结果 ==========')
log(f'主窗口: {main["w"]}x{main["h"]}')
log(f'朋友圈窗口: {sns["w"]}x{sns["h"]}')
log(f'内容区: top={content_top} height={content_height}')
log(f'文件对话框: {"出现" if file_dlg else "未出现（编辑器直接打开）"}')
log(f'UIA工具栏: {"可用" if uia_ok else "不可用（用回退坐标）"}')
log('')
log('关键坐标（用于后续点击）:')
log(f'  文本区(无图): ({cx}, {content_top + int(content_height * 0.35)})')
log(f'  文本区(有图): ({cx}, {content_top + int(content_height * 0.42)})')
log(f'  谁可以看: ({cx}, {content_top + int(content_height * 0.80)})')
