# -*- coding: utf-8 -*-
"""
v8 逐步测试 — UIA取坐标 + pyautogui点击 + 像素验证 + 每步重找窗口
"""
import sys, os, time, json, pythoncom
pythoncom.CoInitialize()

import pyautogui, pyperclip
from PIL import Image
from pywinauto import Application
import win32gui, win32con
pyautogui.FAILSAFE = False

BASE = r'C:/Users/EDY/WorkBuddy/2026-05-28-14-09-05'
LOG = []

def log(tag, msg):
    line = f"[{tag}] {msg}"
    print(line, flush=True)
    LOG.append(line)

def get_win(title):
    found = []
    def _e(hw,_):
        try:
            if win32gui.GetClassName(hw)=='Qt51514QWindowIcon':
                if win32gui.GetWindowText(hw)==title:
                    found.append(hw)
        except: pass
    win32gui.EnumWindows(_e, None)
    if found:
        r = win32gui.GetWindowRect(found[0])
        return {'hwnd':found[0], 'rect':r, 'w':r[2]-r[0], 'h':r[3]-r[1]}
    return None

def fg(hwnd):
    try:
        if win32gui.IsIconic(hwnd): win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.3)
    except Exception as e:
        log('WARN', f'fg: {e}')

def pixel_avg(x, y, w=160, h=20):
    try:
        img = pyautogui.screenshot(region=(x-w//2, y-h//2, w, h))
        pixels = list(img.getdata())
        return sum(p[0] for p in pixels)/len(pixels)
    except: return 255

def screenshot(name):
    pyautogui.screenshot().save(os.path.join(BASE, f'v8_{name}.png'))

# ═══════════════════════════════
log('INFO', 'v8 测试开始')

# 1. 主窗口
log('STEP', '1. 找微信主窗口')
main = get_win('微信')
if not main:
    log('FAIL', '未找到主窗口'); sys.exit(1)
log('PASS', f'{main["w"]}x{main["h"]}')
fg(main['hwnd']); time.sleep(0.5)

# 2. UIA取朋友圈按钮坐标 → pyautogui点击
log('STEP', '2. UIA获取朋友圈坐标')
try:
    app = Application(backend='uia').connect(handle=main['hwnd'])
    w = app.window(handle=main['hwnd'])
    btn = w.child_window(title='朋友圈', control_type='Button')
    r = btn.rectangle()
    cx, cy = (r.left+r.right)//2, (r.top+r.bottom)//2
    log('INFO', f'朋友圈按钮: ({cx},{cy}) rect=({r.left},{r.top})-({r.right},{r.bottom})')
    pyautogui.click(cx, cy)
    time.sleep(2)
    
    sns = get_win('朋友圈')
    if sns:
        log('PASS', f'朋友圈窗口: {sns["w"]}x{sns["h"]}')
    else:
        log('FAIL', '朋友圈窗口未打开'); sys.exit(1)
except Exception as e:
    log('FAIL', f'UIA异常: {e}'); sys.exit(1)

# 3. 后续步骤用 sns 的 rect (若被关会重建)
def calc_coords(w):
    r = w['rect']
    return {
        'ct': r[1] + 60, 'cb': r[3] - 10,
        'cx': r[0] + w['w'] // 2,
        'pub_x': r[0] + 86, 'pub_y': r[1] + 30
    }

# 4. 只需关一次编辑器（不要关两次，可能把朋友圈窗口也关了）
log('STEP', '4. 关残留编辑器(只按1次Escape)')
pyautogui.press('escape'); time.sleep(0.5)

# 检查SNS还在不在
sns_now = get_win('朋友圈')
if not sns_now:
    log('WARN', 'SNS被关闭，重新点击侧边栏...')
    try:
        app_re = Application(backend='uia').connect(handle=main['hwnd'])
        w_re = app_re.window(handle=main['hwnd'])
        btn_re = w_re.child_window(title='朋友圈', control_type='Button')
        r_re = btn_re.rectangle()
        pyautogui.click((r_re.left+r_re.right)//2, (r_re.top+r_re.bottom)//2)
        time.sleep(2)
        sns_now = get_win('朋友圈')
        if not sns_now: log('FAIL','SNS重新打开失败'); sys.exit(1)
        log('INFO', 'SNS已重新打开')
    except Exception as e:
        log('FAIL', f'重新打开SNS失败: {e}'); sys.exit(1)

co = calc_coords(sns_now)
log('INFO', f'内容区: top={co["ct"]} cx={co["cx"]}')

# 5. 点"发表" (UIA取坐标)
log('STEP', '5. 点击工具栏"发表"')
fg(sns_now['hwnd']); time.sleep(0.3)

pub_x, pub_y = co['pub_x'], co['pub_y']
try:
    app2 = Application(backend='uia').connect(handle=sns_now['hwnd'])
    w2 = app2.window(handle=sns_now['hwnd'])
    pub_btn = w2.child_window(title='发表', control_type='Button', found_index=0)
    pr = pub_btn.rectangle()
    pub_x, pub_y = (pr.left+pr.right)//2, (pr.top+pr.bottom)//2
    log('INFO', f'发表(UIA): ({pub_x},{pub_y})')
except Exception as e:
    log('WARN', f'UIA发表失败用估算: {e}')

pyautogui.click(pub_x, pub_y); time.sleep(2)

# 检查文件对话框
dlg = None
def _fd(hw,_):
    try:
        if win32gui.IsWindowVisible(hw) and win32gui.GetClassName(hw)=='#32770':
            if win32gui.GetWindowText(hw): _fd.h = hw
    except: pass
_fd.h = None; win32gui.EnumWindows(_fd, None)
if _fd.h:
    log('INFO', f'文件对话框: {win32gui.GetWindowText(_fd.h)} — 关闭')
    pyautogui.press('escape'); time.sleep(0.5)

screenshot('01_editor')

# 6. 粘贴文案 — 多次尝试 + 像素验证
TEXT = "壹准v8测试"
log('STEP', f'6. 粘贴文案: "{TEXT}"')

text_ok = False
for attempt in range(4):
    sns_t = get_win('朋友圈')
    if not sns_t: log('FAIL','SNS丢失(文案)'); break
    fg(sns_t['hwnd']); time.sleep(0.3)
    co = calc_coords(sns_t)  # 每次重算坐标
    
    ratios = [0.35, 0.30, 0.40, 0.45]
    ratio = ratios[attempt]
    tx = co['cx']
    ty = co['ct'] + int((co['cb'] - co['ct']) * ratio)
    
    log('INFO', f'  尝试{attempt+1}: ({tx},{ty}) ratio={ratio:.2f}')
    pyautogui.click(tx, ty); time.sleep(0.2)
    pyautogui.click(tx, ty); time.sleep(0.3)
    
    pyperclip.copy(''); time.sleep(0.05)
    pyperclip.copy(TEXT); time.sleep(0.1)
    pyautogui.hotkey('ctrl', 'a'); time.sleep(0.08)
    pyautogui.hotkey('ctrl', 'v'); time.sleep(0.5)
    
    b = pixel_avg(tx, ty+20, 200, 24)
    log('INFO', f'    亮度={b:.0f} (阈值<205)')
    
    if b < 205:
        log('PASS', f'文案验证通过 (亮度={b:.0f})')
        text_ok = True
        break

if not text_ok:
    log('FAIL', '文案粘贴未成功 (4次尝试均失败)')

screenshot('02_text')

# 7. 隐私设置
PRIVACY = 'private'
log('STEP', f'7. 隐私设置: {PRIVACY}')

sns3 = get_win('朋友圈')
if not sns3:
    log('FAIL', 'SNS丢失(隐私)')
else:
    fg(sns3['hwnd']); time.sleep(0.3)
    
    priv_ok = False
    for attempt in range(5):
        sns_p = get_win('朋友圈')
        if not sns_p:
            log('WARN', 'SNS丢失，重新打开...')
            # 重新通过侧边栏打开
            try:
                app_r = Application(backend='uia').connect(handle=main['hwnd'])
                w_r = app_r.window(handle=main['hwnd'])
                btn_r = w_r.child_window(title='朋友圈', control_type='Button')
                r_r = btn_r.rectangle()
                pyautogui.click((r_r.left+r_r.right)//2, (r_r.top+r_r.bottom)//2)
                time.sleep(2)
                sns_p = get_win('朋友圈')
                if not sns_p: break
                # 重新点"发表"打开编辑器
                co2 = calc_coords(sns_p)
                pyautogui.click(co2['pub_x'], co2['pub_y']); time.sleep(2)
                # 关文件对话框
                dlg2 = None
                def _fd2(hw,_):
                    try:
                        if win32gui.IsWindowVisible(hw) and win32gui.GetClassName(hw)=='#32770':
                            if win32gui.GetWindowText(hw): _fd2.h = hw
                    except: pass
                _fd2.h = None; win32gui.EnumWindows(_fd2, None)
                if _fd2.h: pyautogui.press('escape'); time.sleep(0.5)
            except: break
        
        fg(sns_p['hwnd']); time.sleep(0.3)
        co = calc_coords(sns_p)
        
        ratios = [0.78, 0.82, 0.74, 0.70, 0.86]
        ratio = ratios[attempt]
        px = co['cx']
        py = co['ct'] + int((co['cb'] - co['ct']) * ratio)
        
        log('INFO', f'  尝试{attempt+1}: ({px},{py}) ratio={ratio:.2f}')
        pyautogui.click(px, py); time.sleep(0.8)
        
        pyautogui.press('down'); time.sleep(0.15)
        pyautogui.press('enter'); time.sleep(0.5)
        
        # 多点验证
        b1 = pixel_avg(px+50, py, 100, 16)
        b2 = pixel_avg(px+30, py+15, 60, 12)
        b3 = pixel_avg(px+70, py, 40, 12)
        b_min = min(b1, b2, b3)
        log('INFO', f'    亮度: {b1:.0f} {b2:.0f} {b3:.0f} min={b_min:.0f}')
        
        if b_min < 230:
            log('PASS', f'隐私验证通过 (min={b_min:.0f})')
            priv_ok = True
            break
        
        # 不按Escape, 直接试下一个位置（先点回原位关子界面）
        pyautogui.click(px, py); time.sleep(0.3)
    
    if not priv_ok:
        log('FAIL', '隐私设置未成功')

screenshot('03_final')

# 总结
log('INFO', f'========== 结果汇总 ==========')
log('INFO', f'主窗口: PASS')
log('INFO', f'朋友圈: PASS')
log('INFO', f'文案粘贴: {"PASS" if text_ok else "FAIL"}')
log('INFO', f'隐私设置: {"PASS" if priv_ok else "FAIL"}')

print(json.dumps({"log": LOG, "text_ok": text_ok, "priv_ok": priv_ok}), flush=True)
