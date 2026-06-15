# -*- coding: utf-8 -*-
"""快速诊断：打开朋友圈编辑器并扫描UIA"""

import sys, os, time, json
sys.path.insert(0, os.path.dirname(__file__))

import pyautogui
from pywinauto import Application
import win32gui, win32process, psutil, win32con

pyautogui.FAILSAFE = False

# ═══════════════════════════════════════════════
# 复用 publish_moment.py 的工具函数
# ═══════════════════════════════════════════════

def find_wechat_windows():
    windows = []
    def _e(hwnd, _):
        try:
            if not win32gui.IsWindowVisible(hwnd): return
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            pn = psutil.Process(pid).name().lower()
            if 'wechat' not in pn and 'weixin' not in pn: return
            r = win32gui.GetWindowRect(hwnd)
            w, h = r[2]-r[0], r[3]-r[1]
            if w < 100 or h < 100: return
            windows.append({"hwnd": hwnd, "rect": r, "w": w, "h": h,
                          "title": win32gui.GetWindowText(hwnd)})
        except: pass
    win32gui.EnumWindows(_e, None)
    return windows

def fg(hwnd):
    try:
        if win32gui.IsIconic(hwnd): win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.3)
    except: pass

def deep_scan(win_info):
    try:
        app = Application(backend="uia").connect(handle=win_info['hwnd'])
        w = app.window(handle=win_info['hwnd'])
        results = []
        def _sc(ctrl, d=0):
            try:
                n = ctrl.window_text() or ""
                ct = ctrl.element_info.control_type or "?"
                ai = ctrl.element_info.automation_id or ""
                try:
                    r = ctrl.rectangle()
                    rs = f"({r.left},{r.top})-({r.right},{r.bottom})"
                except: rs = "?"
                en = ctrl.is_enabled() if hasattr(ctrl,'is_enabled') else "?"
                vi = ctrl.is_visible() if hasattr(ctrl,'is_visible') else "?"
                results.append(f"{'  '*d}[{ct}] name='{n}' id='{ai}' rect={rs} en={en} vi={vi}")
                for c in ctrl.children(): _sc(c, d+1)
            except Exception as e:
                results.append(f"{'  '*d}[!] err: {e}")
        _sc(w)
        return results
    except Exception as e:
        return [f"SCAN FAIL: {e}"]

# ═══════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════

def main():
    print("=== Step 1: 查找微信窗口 ===")
    wins = find_wechat_windows()
    for w in wins:
        print(f"  {w['title']} {w['w']}x{w['h']} rect={w['rect']}")

    main_win = [w for w in wins if '微信' in w['title'] and '朋友圈' not in w['title']]
    if not main_win:
        print("未找到微信主窗口!")
        return
    main_win = main_win[0]
    
    # ── 打开朋友圈 ──
    print("\n=== Step 2: 点击侧边栏'朋友圈' ===")
    fg(main_win['hwnd'])
    app = Application(backend="uia").connect(handle=main_win['hwnd'])
    w = app.window(handle=main_win['hwnd'])
    w.child_window(title="朋友圈", control_type="Button").click_input()
    time.sleep(2)
    
    # ── 检查朋友圈窗口是否打开 ──
    print("\n=== Step 3: 查找朋友圈窗口 ===")
    sns = None
    for _ in range(10):
        time.sleep(0.5)
        wins = find_wechat_windows()
        sns = next((x for x in wins if x['title'] == '朋友圈'), None)
        if sns: break
    
    if not sns:
        print("朋友圈窗口未打开!")
        return
    print(f"朋友圈窗口: {sns['w']}x{sns['h']} rect={sns['rect']}")
    
    # ── 扫描朋友圈窗口 UIA ──
    print("\n=== Step 4: 朋友圈窗口 UIA 扫描 ===")
    results = deep_scan(sns)
    for line in results:
        print(line)
    
    # ── 找工具栏"发表"按钮 ──
    print("\n=== Step 5: 查找工具栏'发表'按钮 ===")
    fg(sns['hwnd'])
    sns_app = Application(backend="uia").connect(handle=sns['hwnd'])
    sns_win = sns_app.window(handle=sns['hwnd'])
    
    try:
        btn = sns_win.child_window(title="发表", control_type="Button", found_index=0)
        r = btn.rectangle()
        print(f"工具栏'发表': rect=({r.left},{r.top})-({r.right},{r.bottom})")
    except Exception as e:
        print(f"未找到: {e}")
        # 尝试其他标题
        try:
            all_btns = sns_win.children(control_type="Button")
            print(f"\n所有Button控件:")
            for b in all_btns:
                try:
                    name = b.window_text()
                    r = b.rectangle()
                    print(f"  name='{name}' rect=({r.left},{r.top})-({r.right},{r.bottom})")
                except: pass
        except Exception as e2:
            print(f"枚举失败: {e2}")
    
    # ── Step 6: 点击"发表"打开编辑器 ──
    print("\n=== Step 6: 点击'发表'打开编辑器 ===")
    try:
        sns_win.child_window(title="发表", control_type="Button", found_index=0).click_input()
        time.sleep(2)
        
        # 检查是否有文件对话框
        print("\n=== Step 7: 检查文件对话框 ===")
        dlg = None
        def _f(h, _):
            try:
                if win32gui.IsWindowVisible(h) and win32gui.GetClassName(h) == '#32770' and win32gui.GetWindowText(h):
                    _f.h = h
            except: pass
        _f.h = None
        win32gui.EnumWindows(_f, None)
        dlg = _f.h
        
        if dlg:
            print(f"文件对话框已打开: '{win32gui.GetWindowText(dlg)}'")
            print("关闭对话框...")
            pyautogui.press('escape')
            time.sleep(1)
        else:
            print("无文件对话框")
        
        # ── 编辑器就绪，重新扫描朋友圈窗口 ──
        print("\n=== Step 8: 编辑器UIA扫描（内容区为Chromium渲染，预期不可见） ===")
        results2 = deep_scan(sns)
        for line in results2:
            print(line)
        
        # ── 检查是否有新的控件出现 ──
        print("\n=== Step 9: 对比差异 ===")
        old_lines = set(results)
        new_lines = set(results2)
        added = new_lines - old_lines
        if added:
            print("新增控件:")
            for l in sorted(added):
                print(f"  {l}")
        else:
            print("无新增UIA控件（Chromium内容区为UIA不透明）")
        
    except Exception as e:
        print(f"错误: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    main()
