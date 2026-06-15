# -*- coding: utf-8 -*-
"""极简诊断：逐个验证每一步是否成功"""
import sys, os, time, json
import pythoncom
pythoncom.CoInitialize()

import pyautogui, pyperclip
from pywinauto import Application
import win32gui, win32process, psutil, win32con
pyautogui.FAILSAFE = False

BASE = r'C:\Users\EDY\WorkBuddy\2026-05-28-14-09-05'

def log(msg):
    print(f'[DIAG] {msg}', flush=True)

def find_wechat():
    ws = []
    def _e(h,_):
        try:
            if not win32gui.IsWindow(h): return
            _,pid = win32process.GetWindowThreadProcessId(h)
            pn = psutil.Process(pid).name().lower()
            if 'wechat' not in pn and 'weixin' not in pn: return
            r = win32gui.GetWindowRect(h)
            w,h = r[2]-r[0], r[3]-r[1]
            if w<100 or h<100: return
            ws.append({'hwnd':h,'rect':r,'w':w,'h':h,'title':win32gui.GetWindowText(h)})
        except: pass
    win32gui.EnumWindows(_e, None)
    return ws

def fg(hwnd):
    try:
        if win32gui.IsIconic(hwnd): win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        if not win32gui.IsWindowVisible(hwnd): win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.3)
    except: pass

def screenshot(name):
    p = os.path.join(BASE, f'diag_{name}.png')
    pyautogui.screenshot().save(p)
    log(f'Screenshot: {p}')
    return p

# ═════════════════════════════════════════════════
log('=== STEP 1: 找微信窗口 ===')
wins = find_wechat()
for w in wins:
    log(f'  title="{w["title"]}" {w["w"]}x{w["h"]} rect={w["rect"]}')

main = next((w for w in wins if '微信' in w['title']), None)
if not main:
    # 找最大的非朋友圈窗口
    non = [w for w in wins if '朋友圈' not in w['title']]
    main = max(non, key=lambda w: w['w']*w['h']) if non else None

if not main:
    log('FAIL: 找不到微信窗口! 请打开微信')
    sys.exit(1)
log(f'主窗口: HWND={main["hwnd"]} {main["w"]}x{main["h"]} rect={main["rect"]}')

# ═════════════════════════════════════════════════
log('=== STEP 2: 恢复窗口 ===')
fg(main['hwnd'])
screenshot('01_restored')

# ═════════════════════════════════════════════════
log('=== STEP 3: UIA点击侧边栏朋友圈 ===')
try:
    app = Application(backend='uia').connect(handle=main['hwnd'])
    w = app.window(handle=main['hwnd'])
    w.child_window(title='朋友圈', control_type='Button').click_input()
    log('  已点击')
    time.sleep(2)
except Exception as e:
    log(f'  UIA失败: {e}, 尝试坐标点击')
    # 朋友圈按钮在侧边栏固定位置: 窗口左+60, 窗口顶+200
    pyautogui.click(main['rect'][0] + 60, main['rect'][1] + 200)
    time.sleep(2)

screenshot('02_after_sidebar')

# ═════════════════════════════════════════════════
log('=== STEP 4: 找朋友圈窗口 ===')
sns = None
for _ in range(15):
    time.sleep(0.5)
    wins = find_wechat()
    for ww in wins:
        if '朋友圈' in ww['title']:
            sns = ww
            break
    if sns: break

if not sns:
    log('FAIL: 朋友圈窗口未打开!')
    screenshot('03_no_sns_window')
    sys.exit(1)

log(f'朋友圈窗口: HWND={sns["hwnd"]} {sns["w"]}x{sns["h"]} rect={sns["rect"]}')
screenshot('03_sns_window')

# ═════════════════════════════════════════════════
log('=== STEP 5: 关闭可能的残留编辑器 ===')
fg(sns['hwnd'])
time.sleep(0.3)
pyautogui.press('escape')
time.sleep(0.5)
pyautogui.press('escape')
time.sleep(0.5)

# ═════════════════════════════════════════════════
log('=== STEP 6: 点击工具栏"发表"按钮(坐标) ===')
fg(sns['hwnd'])
time.sleep(0.5)

# 基于UIA扫描数据: 按钮中心在(窗口左+86, 窗口顶+30)
btn_x = sns['rect'][0] + 86
btn_y = sns['rect'][1] + 30
log(f'  点击位置: ({btn_x}, {btn_y}) [窗口: left={sns["rect"][0]}, top={sns["rect"][1]}]')
pyautogui.click(btn_x, btn_y)

# 等待看是否弹出文件对话框
log('  等待3秒看是否有文件对话框...')
time.sleep(3)

# 检查是否有 #32770 对话框
dlg_found = False
def _fd(h, _):
    try:
        if win32gui.IsWindowVisible(h) and win32gui.GetClassName(h) == '#32770':
            log(f'  找到对话框: "{win32gui.GetWindowText(h)}"')
            _fd.h = h; _fd.found = True
    except: pass
_fd.h = None; _fd.found = False
win32gui.EnumWindows(_fd, None)

if _fd.found:
    log('  文件对话框已弹出! 关闭它...')
    fg(_fd.h)
    time.sleep(0.5)
    pyautogui.press('escape')
    time.sleep(0.5)
else:
    log('  没有文件对话框，编辑器已直接打开')

screenshot('04_after_publish_btn')

# ═════════════════════════════════════════════════
log('=== STEP 7: 分析编辑器状态 ===')
fg(sns['hwnd'])
time.sleep(0.5)

# 计算内容区
# 工具栏底部 ≈ 窗口顶 + 60
content_top = sns['rect'][1] + 60
content_bottom = sns['rect'][3] - 10
content_h = content_bottom - content_top
cx = sns['rect'][0] + sns['w'] // 2

log(f'  内容区: top={content_top} bot={content_bottom} h={content_h} cx={cx}')

# 截图标记各个位置
img = pyautogui.screenshot()
screenshot('05_editor_state')

log('')
log('=== 诊断完成 ===')
log(f'内容区起点(工具栏底部): {content_top}')
log(f'文本区中心(无图): ({cx}, {content_top + int(content_h * 0.35)})')
log(f'文本区中心(有图): ({cx}, {content_top + int(content_h * 0.42)})')
log(f'谁可以看: ({cx}, {content_top + int(content_h * 0.80)})')
log(f'底边: {content_bottom}')
