# -*- coding: utf-8 -*-
"""
朋友圈发布 v8 — 已验证通过（文本+隐私像素确认）

使用方法:
  python publish_moment.py --text "文案" --privacy private [--media "img.jpg"] [--no-publish]
  
验证记录 (2026-06-12):
  ✅ 主窗口定位: EnumWindows 排除朋友圈窗口
  ✅ UIA侧边栏: 取坐标 → pyautogui点击
  ✅ 工具栏"发表": UIA取坐标 → pyautogui点击
  ✅ 文案粘贴: ratio=0.35 (无图) / 0.40 (有图), 像素亮度验证
  ✅ 隐私设置: ratio=0.74, 多位置重试 + 像素验证
"""
import sys, os, time, json, argparse, traceback, pythoncom
pythoncom.CoInitialize()

def log(msg):
    print(f"[v8] {msg}", file=sys.stderr, flush=True)

import pyautogui, pyperclip
from PIL import Image
from pywinauto import Application
import win32gui, win32con
pyautogui.FAILSAFE = False


def get_win(title):
    found = []
    def _e(hw,_):
        try:
            if win32gui.GetClassName(hw)=='Qt51514QWindowIcon':
                if win32gui.GetWindowText(hw)==title: found.append(hw)
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
        win32gui.SetForegroundWindow(hwnd); time.sleep(0.3)
    except: pass


def pixel_avg(x, y, w=160, h=20):
    try:
        img = pyautogui.screenshot(region=(x-w//2, y-h//2, w, h))
        pixels = list(img.getdata())
        return sum(p[0] for p in pixels)/len(pixels)
    except: return 255


def calc_coords(w):
    r = w['rect']
    return {
        'ct': r[1]+60, 'cb': r[3]-10,
        'cx': r[0]+w['w']//2,
        'pub': (r[0]+86, r[1]+30)
    }


def uia_click_sns_sidebar(main_hwnd):
    """UIA取朋友圈坐标 → pyautogui点击"""
    app = Application(backend='uia').connect(handle=main_hwnd)
    win = app.window(handle=main_hwnd)
    btn = win.child_window(title='朋友圈', control_type='Button')
    r = btn.rectangle()
    pyautogui.click((r.left+r.right)//2, (r.top+r.bottom)//2)


def uia_get_publish_coords(sns_hwnd):
    """UIA取发表按钮坐标"""
    try:
        app = Application(backend='uia').connect(handle=sns_hwnd)
        win = app.window(handle=sns_hwnd)
        pub = win.child_window(title='发表', control_type='Button', found_index=0)
        r = pub.rectangle()
        return ((r.left+r.right)//2, (r.top+r.bottom)//2)
    except:
        return None


def open_sns():
    """打开朋友圈窗口"""
    main = get_win('微信')
    if not main: return None
    fg(main['hwnd']); time.sleep(0.3)
    uia_click_sns_sidebar(main['hwnd'])
    time.sleep(2)
    return get_win('朋友圈')


def close_file_dialog():
    found = []
    def _f(hw,_):
        try:
            if win32gui.IsWindowVisible(hw) and win32gui.GetClassName(hw)=='#32770':
                if win32gui.GetWindowText(hw): found.append(hw)
        except: pass
    win32gui.EnumWindows(_f, None)
    if found:
        win32gui.SetForegroundWindow(found[0]); time.sleep(0.3)
        pyautogui.press('escape'); time.sleep(0.5)
        return True
    return False


def handle_images(media):
    """处理文件对话框添加图片"""
    for _ in range(30):
        found = []
        def _f(hw,_):
            try:
                if win32gui.IsWindowVisible(hw) and win32gui.GetClassName(hw)=='#32770':
                    if win32gui.GetWindowText(hw): found.append(hw)
            except: pass
        win32gui.EnumWindows(_f, None)
        if found: dlg = found[0]; break
        time.sleep(0.5)
    else:
        log("文件对话框未出现")
        return False

    log(f"文件对话框: {win32gui.GetWindowText(dlg)}")
    fg(dlg); time.sleep(0.8)

    paths = [os.path.abspath(p) for p in media if p and os.path.isfile(p)]
    if not paths:
        pyautogui.press('escape'); return False
    
    inp = paths[0] if len(paths)==1 else ' '.join(f'"{p}"' for p in paths)
    pyautogui.hotkey('alt','n'); time.sleep(0.5)
    pyperclip.copy(inp); time.sleep(0.2)
    pyautogui.hotkey('ctrl','a'); time.sleep(0.08)
    pyautogui.hotkey('ctrl','v'); time.sleep(0.5)
    
    dr = win32gui.GetWindowRect(dlg)
    pyautogui.click(dr[2]-100, dr[3]-45); time.sleep(1.5)
    
    # 确认关闭
    found2 = []
    def _f2(hw,_):
        try:
            if win32gui.IsWindowVisible(hw) and win32gui.GetClassName(hw)=='#32770':
                found2.append(hw)
        except: pass
    win32gui.EnumWindows(_f2, None)
    if found2: pyautogui.hotkey('alt','o'); time.sleep(1.0)
    
    log("图片已添加")
    return True


# ═══════════════ 主流程 ═══════════════
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--text', default='')
    ap.add_argument('--media', nargs='*', default=[])
    ap.add_argument('--privacy', default='public')
    ap.add_argument('--no-publish', action='store_true')
    args = ap.parse_args()
    
    text = args.text.strip()
    media = [os.path.abspath(p) for p in args.media if p and os.path.isfile(p)]
    privacy = args.privacy
    log(f"START: text={len(text)}字 img={len(media)}个 priv={privacy}")
    
    try:
        # ── 1. 打开朋友圈 ──
        sns = open_sns()
        if not sns:
            return print(json.dumps({"success":False,"error":"朋友圈窗口未打开"}), flush=True)
        log(f"朋友圈: {sns['w']}x{sns['h']}")
        
        # ── 2. 关残留 + 重开 ──
        pyautogui.press('escape'); time.sleep(0.5)
        sns = get_win('朋友圈')
        if not sns:
            log("SNS被关，重新打开...")
            sns = open_sns()
            if not sns:
                return print(json.dumps({"success":False,"error":"SNS重新打开失败"}), flush=True)
        
        # ── 3. 点"发表" ──
        fg(sns['hwnd']); time.sleep(0.3)
        pub = uia_get_publish_coords(sns['hwnd'])
        if pub:
            log(f"发表(UIA): {pub}")
            pyautogui.click(*pub)
        else:
            co = calc_coords(sns)
            log(f"发表(估算): {co['pub']}")
            pyautogui.click(*co['pub'])
        time.sleep(2)
        
        # ── 4. 图片处理 ──
        has_img = False
        if media:
            has_img = handle_images(media)
            time.sleep(3.0)
        else:
            close_file_dialog()  # 无图时关掉文件对话框
        
        # ── 5. 粘贴文案 ──
        text_ok = True
        if text:
            text_ok = False
            for attempt in range(4):
                sns = get_win('朋友圈')
                if not sns: break
                fg(sns['hwnd']); time.sleep(0.3)
                co = calc_coords(sns)
                
                ratios = [0.35, 0.40, 0.30, 0.45] if not has_img else [0.40, 0.35, 0.45, 0.50]
                r = ratios[attempt]
                tx, ty = co['cx'], co['ct']+int((co['cb']-co['ct'])*r)
                
                log(f"  文案{attempt+1}: ({tx},{ty}) r={r:.2f}")
                pyautogui.click(tx,ty); time.sleep(0.2)
                pyautogui.click(tx,ty); time.sleep(0.3)
                
                pyperclip.copy(text); time.sleep(0.1)
                pyautogui.hotkey('ctrl','a'); time.sleep(0.08)
                pyautogui.hotkey('ctrl','v'); time.sleep(0.5)
                
                b = pixel_avg(tx, ty+20, 200, 24)
                if b < 205:
                    text_ok = True; log(f"  ✓ 文案通过 (亮度={b:.0f})"); break
                log(f"  ✗ 亮度={b:.0f}")
        
        # ── 6. 隐私设置 ──
        priv_ok = True
        if privacy and privacy != 'public':
            priv_ok = False
            for attempt in range(5):
                sns = get_win('朋友圈')
                if not sns:
                    # SNS丢失，重新打开
                    sns = open_sns()
                    if not sns: break
                    co2 = calc_coords(sns)
                    pyautogui.click(*co2['pub']); time.sleep(2)
                    close_file_dialog()
                
                fg(sns['hwnd']); time.sleep(0.3)
                co = calc_coords(sns)
                
                ratios = [0.74, 0.78, 0.70, 0.82, 0.66]
                r = ratios[attempt]
                px, py = co['cx'], co['ct']+int((co['cb']-co['ct'])*r)
                
                log(f"  隐私{attempt+1}: ({px},{py}) r={r:.2f}")
                pyautogui.click(px,py); time.sleep(1.2)  # 等子界面完全加载
                
                pyautogui.press('down'); time.sleep(0.2)
                pyautogui.press('enter'); time.sleep(0.6)
                
                b1 = pixel_avg(px+50, py, 100, 16)
                b2 = pixel_avg(px+30, py+15, 60, 12)
                b3 = pixel_avg(px+70, py, 40, 12)
                bm = min(b1,b2,b3)
                if bm < 240:
                    priv_ok = True; log(f"  ✓ 隐私通过 (min={bm:.0f})"); break
                log(f"  ✗ min={bm:.0f}")
                pyautogui.click(px,py); time.sleep(0.3)  # 关子界面
        
        # ── 7. 发表 ──
        if not media and not text:
            return print(json.dumps({"success":False,"error":"无内容"}), flush=True)
        
        if args.no_publish:
            msg = f"就绪: 文案={'✓'if text_ok else '✗'} 隐私={'✓'if priv_ok else '✗'}"
            return print(json.dumps({"success":True,"message":msg}), flush=True)
        
        sns = get_win('朋友圈')
        if sns:
            fg(sns['hwnd']); time.sleep(0.3)
        pyautogui.hotkey('ctrl','enter'); time.sleep(3.0)
        print(json.dumps({"success":True,"message":"发布成功"}), flush=True)
    
    except Exception as e:
        print(json.dumps({"success":False,"error":f"{e}\n{traceback.format_exc()}"}), flush=True)


if __name__ == '__main__':
    main()
