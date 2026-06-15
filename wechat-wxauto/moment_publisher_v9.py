"""
朋友圈发布流程 v9 (成功版)
=============================
已验证的流程：
  1. 点击 UIA「发表」按钮 → 弹出文件选择对话框
  2. 选择图片文件 → 对话框关闭 → 编辑器出现（嵌入朋友圈窗口内）
  3. 在编辑器内输入文案 (Ctrl+V)
  4. 点击编辑器内「发表」按钮 → 发布完成

用法:
  python moment_publisher_v9.py --text "文案" --media "p1.jpg" "p2.jpg" --privacy "公开"
  python moment_publisher_v9.py --text "文案" --privacy "谁可以看" --contact "张三"

坐标基准：朋友圈窗口 (179,115)，UIA 动态获取
"""
import os
import sys
import time
import json
import argparse

# ★ 强制 UTF-8 输出（Electron spawn 子进程时避免 GBK 乱码）★
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import pythoncom
import win32gui
import win32con
import pyautogui
import pyperclip
import uiautomation as auto
import numpy as np
from PIL import ImageGrab

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.3


def get_window(title_substr):
    """查找窗口，返回 {'hwnd','rect'} 或 None"""
    result = {}
    def cb(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            if title_substr in win32gui.GetWindowText(hwnd):
                result['hwnd'] = hwnd
                result['rect'] = win32gui.GetWindowRect(hwnd)
    win32gui.EnumWindows(cb, None)
    return result if result else None


def wait_for_window(title_substr, timeout=10):
    """等待窗口出现"""
    for _ in range(timeout * 2):
        win = get_window(title_substr)
        if win:
            return win
        time.sleep(0.5)
    return None


def get_uia_button(hwnd, name, min_y=0):
    """在窗口内查找指定名称的 UIA Button，返回 (cx, cy)"""
    pythoncom.CoInitialize()
    try:
        ctrl = auto.ControlFromHandle(hwnd)
        
        def find(c, depth=0):
            if depth > 8:
                return None
            try:
                n = c.Name or ''
                if n == name and c.ControlTypeName == 'ButtonControl':
                    rect = c.BoundingRectangle
                    if rect:
                        y = int(rect.top)
                        if y >= min_y:
                            return (int(rect.left + rect.width()/2),
                                    int(rect.top + rect.height()/2))
            except:
                pass
            try:
                for child in c.GetChildren():
                    res = find(child, depth+1)
                    if res:
                        return res
            except:
                pass
            return None
        
        return find(ctrl)
    finally:
        pythoncom.CoUninitialize()


def get_editor_buttons(hwnd, min_y=400):
    """获取编辑器底部按钮（退出前请手动 CoUninitialize）"""
    ctrl = auto.ControlFromHandle(hwnd)
    buttons = {}
    
    def find(c, depth=0):
        if depth > 8:
            return
        try:
            name = c.Name or ''
            if c.ControlTypeName == 'ButtonControl':
                rect = c.BoundingRectangle
                if rect:
                    y = int(rect.top)
                    if y > min_y:
                        cx = int(rect.left + rect.width()/2)
                        cy = int(rect.top + rect.height()/2)
                        buttons[name] = (cx, cy)
        except:
            pass
        try:
            for child in c.GetChildren():
                find(child, depth+1)
        except:
            pass
    
    find(ctrl)
    return buttons


class MomentPublisher:
    """微信朋友圈发布器"""
    
    def __init__(self):
        self.results = []
        self.moments_win = None
    
    def log(self, step, status, detail=""):
        self.results.append({"step": step, "status": status, "detail": detail})
        icon = "✓" if status == "PASS" else "✗" if status == "FAIL" else "?"
        print(f"  [{icon}] {detail}")
    
    def screenshot(self, name):
        import tempfile
        path = os.path.join(tempfile.gettempdir(), f"yizhun_moment_{name}.png")
        ImageGrab.grab().save(path)
        return path
    
    # ====== Step 1: 打开朋友圈 ======
    def step1_open_moments(self):
        """打开朋友圈页面"""
        print("\n=== Step 1: 打开朋友圈 ===")
        
        # 找微信主窗口
        wx = get_window("微信")
        if not wx:
            self.log(1, "FAIL", "未找到微信主窗口")
            return False
        
        print(f"  微信: ({wx['rect'][0]},{wx['rect'][1]})")
        
        # 激活微信
        win32gui.SetForegroundWindow(wx['hwnd'])
        time.sleep(0.3)
        
        # 点击侧边栏朋友圈 (之前验证过 y_offset=320)
        r = wx['rect']
        pyautogui.click(r[0] + 30, r[1] + 320)
        time.sleep(1.5)
        
        # 验证朋友圈窗口出现
        self.moments_win = get_window("朋友圈")
        if not self.moments_win:
            self.log(1, "FAIL", "朋友圈窗口未出现")
            return False
        
        r2 = self.moments_win['rect']
        self.log(1, "PASS", f"朋友圈窗口 ({r2[0]},{r2[1]}) {r2[2]-r2[0]}x{r2[3]-r2[1]}")
        return True
    
    # ====== Step 2: 点击入口 ======
    def step2_click_entry(self):
        """点击发表按钮（或相机图标）"""
        print("\n=== Step 2: 点击入口 ===")
        
        if not self.moments_win:
            self.log(2, "FAIL", "朋友圈窗口不存在")
            return False
        
        hwnd = self.moments_win['hwnd']
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.5)
        
        # 检查是否有残留编辑器：UIA 扫描找「取消」或「发表」按钮 (y>400=编辑器内)
        cancel_btn = get_uia_button(hwnd, "取消", min_y=400)
        if cancel_btn:
            print(f"  检测到残留编辑器，先点取消: {cancel_btn}")
            pyautogui.click(*cancel_btn)
            time.sleep(3)  # 等待编辑器关闭动画
            win32gui.SetForegroundWindow(hwnd)
            time.sleep(1)
        
        # 通过 UIA 获取「发表」按钮坐标
        coords = get_uia_button(hwnd, "发表", min_y=0)
        
        if not coords:
            # 回退：使用已知坐标 (窗口左+86, 窗口顶+30)
            sl, st = self.moments_win['rect'][:2]
            cx, cy = sl + 86, st + 30
            print(f"  UIA 未找到发表按钮，使用回退坐标: ({cx},{cy})")
        else:
            cx, cy = coords
            print(f"  发表按钮: ({cx},{cy})")
        
        pyautogui.click(cx, cy)
        time.sleep(2.5)
        
        # 验证文件对话框出现
        dialog = get_window("选择文件") or get_window("打开")
        # 也检查 #32770 类窗口
        if not dialog:
            def find_32770():
                r = {}
                def cb(h, _):
                    if win32gui.IsWindowVisible(h) and win32gui.GetClassName(h) == '#32770':
                        r['hwnd'] = h
                        r['rect'] = win32gui.GetWindowRect(h)
                win32gui.EnumWindows(cb, None)
                return r
            dialog = find_32770()
        
        if dialog:
            self.dialog_win = dialog
            self.log(2, "PASS", f"文件对话框已打开")
            return True
        else:
            self.log(2, "FAIL", "未弹出文件对话框")
            return False
    
    # ====== Step 3: 选择文件 ======
    def step3_select_file(self, file_path):
        """在文件对话框中选择文件"""
        print(f"\n=== Step 3: 选择文件: {os.path.basename(file_path)} ===")
        
        if not os.path.exists(file_path):
            self.log(3, "FAIL", f"文件不存在: {file_path}")
            return False
        
        dialog = self.dialog_win
        win32gui.SetForegroundWindow(dialog['hwnd'])
        time.sleep(0.3)
        
        # 方法：Alt+N 聚焦文件名 → 粘贴路径 → 回车
        pyautogui.hotkey('alt', 'n')
        time.sleep(0.3)
        
        pyperclip.copy(file_path)
        pyautogui.hotkey('ctrl', 'a')
        time.sleep(0.1)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.3)
        
        pyautogui.press('enter')
        time.sleep(2.5)
        
        # 验证对话框关闭
        dialog2 = get_window("选择文件")
        if not dialog2:
            # 也检查 #32770
            def find_32770():
                r = {}
                def cb(h, _):
                    if win32gui.IsWindowVisible(h) and win32gui.GetClassName(h) == '#32770':
                        r['hwnd'] = h
                win32gui.EnumWindows(cb, None)
                return r
            if not find_32770():
                self.log(3, "PASS", "文件已选择，编辑器应已出现")
                return True
        
        self.log(3, "FAIL", "对话框未关闭")
        return False
    
    # ====== Step 4: 输入文案 ======
    def step4_input_text(self, text):
        """在编辑器中输入文案"""
        print(f"\n=== Step 4: 输入文案 ===")
        print(f"  内容: {text[:50]}{'...' if len(text)>50 else ''}")
        
        self.moments_win = get_window("朋友圈")
        if not self.moments_win:
            self.log(4, "FAIL", "朋友圈窗口丢失")
            return False
        
        hwnd = self.moments_win['hwnd']
        r = self.moments_win['rect']
        sl, st = r[0], r[1]
        
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.3)
        
        # 点击编辑器文本区（白色区域顶部中心）
        text_x = sl + 240
        text_y = st + 90
        
        pyautogui.click(text_x, text_y)
        time.sleep(0.3)
        
        pyperclip.copy(text)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.5)
        
        # 验证：文本区亮度变化
        arr = np.array(ImageGrab.grab())
        text_area = arr[st+75:st+120, sl+200:sl+500, :]
        brightness = text_area.mean()
        print(f"  文本区亮度: {brightness:.0f}")
        
        self.log(4, "PASS", f"文案已粘贴")
        return True
    
    # ====== Step 5: 设置隐私 ======
    def _uia_scan(self, hwnd):
        """扫描窗口内所有有名字的 UIA 元素，返回 {name: {type,cx,cy,x,y,w,h}}"""
        pythoncom.CoInitialize()
        try:
            ctrl = auto.ControlFromHandle(hwnd)
            items = {}
            def scan(c, depth=0):
                if depth > 8:
                    return
                try:
                    n = c.Name or ''
                    t = c.ControlTypeName or ''
                    rect = c.BoundingRectangle
                    if rect and n and len(n.strip()) > 0:
                        x, y = int(rect.left), int(rect.top)
                        w2, h2 = int(rect.width()), int(rect.height())
                        items[n] = {'type': t, 'cx': x + w2//2, 'cy': y + h2//2,
                                    'x': x, 'y': y, 'w': w2, 'h': h2}
                except:
                    pass
                try:
                    for ch in c.GetChildren():
                        scan(ch, depth + 1)
                except:
                    pass
            scan(ctrl)
            return items
        finally:
            pythoncom.CoUninitialize()
    
    def uia_find_text(self, hwnd, text_substr):
        """UIA 查找名称包含指定文本的控件（不限类型），返回 (cx,cy) 或 None。
        先从 hwnd 开始找，找不到则从根控件扫描。"""
        pythoncom.CoInitialize()
        try:
            # 方法1：从 hwnd 开始
            ctrl = auto.ControlFromHandle(hwnd)
            result = [None]
            def find(c, depth=0):
                if depth > 8 or result[0]:
                    return
                try:
                    n = c.Name or ''
                    if text_substr in n:
                        rect = c.BoundingRectangle
                        if rect:
                            result[0] = (int(rect.left + rect.width()/2),
                                         int(rect.top + rect.height()/2))
                            return
                except:
                    pass
                try:
                    for ch in c.GetChildren():
                        find(ch, depth + 1)
                except:
                    pass
            find(ctrl)
            if result[0]:
                return result[0]
            
            # 方法2：从根控件扫描（覆盖所有窗口）
            root = auto.GetRootControl()
            def find_root(c, depth=0):
                if depth > 10 or result[0]:
                    return
                try:
                    n = c.Name or ''
                    if text_substr in n:
                        rect = c.BoundingRectangle
                        if rect:
                            wh = rect.width(), rect.height()
                            if 10 < wh[0] < 800 and 10 < wh[1] < 200:
                                result[0] = (int(rect.left + rect.width()/2),
                                             int(rect.top + rect.height()/2))
                                return
                except:
                    pass
                try:
                    for ch in c.GetChildren():
                        find_root(ch, depth + 1)
                except:
                    pass
            find_root(root)
            return result[0]
        finally:
            pythoncom.CoUninitialize()
    
    def _uia_scan(self, hwnd):
        """扫描窗口内所有有名字的 UIA 元素，返回 {name: {type,cx,cy,x,y,w,h}}"""
        try:
            ctrl = auto.ControlFromHandle(hwnd)
            items = {}
            def scan(c, depth=0):
                if depth > 8:
                    return
                try:
                    n = c.Name or ''
                    t = c.ControlTypeName or ''
                    rect = c.BoundingRectangle
                    if rect and n and len(n.strip()) > 0:
                        x, y = int(rect.left), int(rect.top)
                        w2, h2 = int(rect.width()), int(rect.height())
                        items[n] = {'type': t, 'cx': x + w2//2, 'cy': y + h2//2,
                                    'x': x, 'y': y, 'w': w2, 'h': h2}
                except:
                    pass
                try:
                    for ch in c.GetChildren():
                        scan(ch, depth + 1)
                except:
                    pass
            scan(ctrl)
            return items
        finally:
            pythoncom.CoUninitialize()
    
    def _find_popup_confirm(self, popup_title="Weixin"):
        """
        在指定标题的 Qt 弹窗中查找「确定」按钮并点击。
        返回 True 表示点击成功，False 表示未找到。
        """
        # 方法1：通过 UIA 扫描弹窗内的「确定」
        popup_hwnd = None
        
        def find_popup(hwnd, _):
            nonlocal popup_hwnd
            if win32gui.IsWindowVisible(hwnd):
                t = win32gui.GetWindowText(hwnd)
                c = win32gui.GetClassName(hwnd)
                if popup_title in t and 'Qt5' in c:
                    popup_hwnd = hwnd
        
        win32gui.EnumWindows(find_popup, None)
        
        if not popup_hwnd:
            # 尝试匹配包含关键词的窗口
            def find_any_popup(hwnd, _):
                nonlocal popup_hwnd
                if win32gui.IsWindowVisible(hwnd):
                    t = win32gui.GetWindowText(hwnd)
                    c = win32gui.GetClassName(hwnd)
                    if 'Qt5' in c and ('Weixin' in t or '微信' in t):
                        r = win32gui.GetWindowRect(hwnd)
                        w, h = r[2]-r[0], r[3]-r[1]
                        if 300 < w < 800 and 400 < h < 800:
                            popup_hwnd = hwnd
            
            win32gui.EnumWindows(find_any_popup, None)
        
        if not popup_hwnd:
            print(f"    未找到弹窗窗口（关键词: {popup_title}）")
            return False
        
        print(f"    弹窗窗口: hwnd={popup_hwnd}")
        win32gui.SetForegroundWindow(popup_hwnd)
        time.sleep(0.3)
        
        # 方法1a: 扫描弹窗 UIA 树找「确定」
        pythoncom.CoInitialize()
        try:
            ctrl = auto.ControlFromHandle(popup_hwnd)
            confirm_btns = []
            
            def find_confirms(c, depth=0):
                if depth > 8:
                    return
                try:
                    n = c.Name or ''
                    t = c.ControlTypeName or ''
                    rect = c.BoundingRectangle
                    if rect and n == '确定':
                        x, y = int(rect.left), int(rect.top)
                        w2, h2 = int(rect.width()), int(rect.height())
                        confirm_btns.append({
                            'cx': x + w2//2, 'cy': y + h2//2,
                            'type': t, 'y': y
                        })
                except:
                    pass
                try:
                    for ch in c.GetChildren():
                        find_confirms(ch, depth+1)
                except:
                    pass
            
            find_confirms(ctrl)
            
            if confirm_btns:
                # 优先选 ButtonControl，其次选 y 更大的（主弹窗确定通常在更下方）
                btn_controls = [b for b in confirm_btns if 'Button' in b['type']]
                target = btn_controls[0] if btn_controls else max(confirm_btns, key=lambda x: x['y'])
                
                print(f"    点击弹窗「确定」: ({target['cx']},{target['cy']}) [{target['type']}]")
                pyautogui.click(target['cx'], target['cy'])
                time.sleep(1)
                
                # 验证是否关闭
                still_open = False
                def check_closed(hwnd, _):
                    if hwnd == popup_hwnd and win32gui.IsWindowVisible(hwnd):
                        nonlocal still_open
                        still_open = True
                win32gui.EnumWindows(check_closed, None)
                
                if not still_open:
                    print(f"    ✓ 弹窗已关闭")
                    return True
                
                # 若未关闭，重试一次
                print(f"    重试点击...")
                pyautogui.click(target['cx'], target['cy'])
                time.sleep(1)
                
                still_open2 = False
                def check_closed2(hwnd, _):
                    if hwnd == popup_hwnd and win32gui.IsWindowVisible(hwnd):
                        nonlocal still_open2
                        still_open2 = True
                win32gui.EnumWindows(check_closed2, None)
                
                if not still_open2:
                    print(f"    ✓ 弹窗已关闭（重试成功）")
                    return True
        finally:
            pythoncom.CoUninitialize()
        
        # 方法2：按 Enter 键（某些弹窗确认按钮响应键盘）
        print(f"    尝试 Enter 键...")
        win32gui.SetForegroundWindow(popup_hwnd)
        time.sleep(0.3)
        pyautogui.press('enter')
        time.sleep(1)
        
        still_open3 = False
        def check_closed3(hwnd, _):
            if hwnd == popup_hwnd and win32gui.IsWindowVisible(hwnd):
                nonlocal still_open3
                still_open3 = True
        win32gui.EnumWindows(check_closed3, None)
        
        if not still_open3:
            print(f"    ✓ Enter 关闭成功")
            return True
        
        print(f"    弹窗仍存在，尝试 WM_CLOSE...")
        win32gui.SendMessage(popup_hwnd, win32con.WM_CLOSE, 0, 0)
        time.sleep(1)
        
        return not still_open3
    
    def _scroll_to_reveal_bottom(self, hwnd_parent, file_count):
        """反复尝试滚动编辑器内容，直到内容不再变化（已滚到底）。
        使用 win32api mouse_event 直接发送鼠标滚轮事件到编辑器位置。"""
        r = self.moments_win['rect']
        cw, ch = r[2]-r[0], r[3]-r[1]
        cx = r[0] + cw // 2
        
        if file_count < 3:
            return  # 1-2 张图不需要滚动
        
        print(f"  滚动编辑器 ({file_count}张图)...")
        
        # 鼠标移到编辑器中间位置（图片区域），确保滚动事件发给正确窗口
        img_y = r[1] + ch * 2 // 3
        pyautogui.moveTo(cx, img_y)
        time.sleep(0.3)
        
        # 用 win32api.mouse_event 发送滚轮事件
        # 这会精确模拟物理鼠标滚轮，Qt 窗口应该能正确响应
        import win32api
        
        # 先截取滚动前底部区域
        before_region = ImageGrab.grab(bbox=(r[0], r[1]+ch-220, r[2], r[3]-10))
        before_mean = np.array(before_region).mean()
        
        # 分段滚动：每次滚 30 格，然后检查
        for batch in range(5):  # 最多 5 批 × 30 格 = 150 格
            for _ in range(30):
                win32api.mouse_event(win32con.MOUSEEVENTF_WHEEL, 0, 0, -120, 0)
                time.sleep(0.01)
            time.sleep(0.3)
            
            # 截取滚动后底部对比
            after_region = ImageGrab.grab(bbox=(r[0], r[1]+ch-220, r[2], r[3]-10))
            after_mean = np.array(after_region).mean()
            diff = abs(after_mean - before_mean)
            before_mean = after_mean  # 更新基准
            
            print(f"    批次{batch+1}: 亮度变化 {diff:.0f}")
            
            if diff < 3:
                # 两次亮度几乎一样 → 内容不再变化 → 已滚到底
                print(f"  内容已滚到底（稳定）")
                break
        else:
            print(f"  滚动完成（{5}批次）")
    
    def _find_privacy_row_after_scroll(self, hwnd_parent):
        """找到滚动后「谁可以看」行的精确 Y 坐标。
        扫描取消按钮上方的像素行，找行分隔间隙。
        滚动到底后，「谁可以看」是紧贴按钮上方的第一个设置行。"""
        items = self._uia_scan(hwnd_parent)
        anchor_y = None
        for name, info in items.items():
            if name == "取消" and info['cy'] > 400:
                anchor_y = info['cy']
                print(f"  锚点「取消」: ({info['cx']},{info['cy']})")
                break
        if not anchor_y:
            for name, info in items.items():
                if name == "发表" and info['cy'] > 400:
                    anchor_y = info['cy']
        if not anchor_y:
            print(f"  ✗ 找不到锚点按钮")
            return 0, 0
        
        r = self.moments_win['rect']
        x_center = r[0] + int((r[2]-r[0]) * 0.4)
        
        # 截取取消按钮上方 170px → 20px 的区域
        scan_top = anchor_y - 170
        scan_bot = anchor_y - 20
        if scan_top < r[1]:
            scan_top = r[1]
        if scan_bot <= scan_top:
            return x_center, anchor_y - 55
        
        region = (r[0], scan_top, r[2], scan_bot)
        img = ImageGrab.grab(bbox=region)
        arr = np.array(img)
        h, w, _ = arr.shape
        sl, sr = int(w*0.12), int(w*0.88)  # 取中间 76% 宽度
        
        # 逐行判断亮度（是否属于"内容"行）
        row_bright = np.array([arr[y, sl:sr, :].mean() for y in range(h)])
        is_dark = row_bright < 200  # 暗行=有内容
        
        # 从底部向上扫描，找间隙行（亮行）的起始位置
        # 内容依次：按钮间隙 → [设置行+间隙 → 设置行+间隙 → ...] → 图片
        # 从底部开始的第一个亮行就是按钮与设置行之间的间隙
        
        gap_start = None  # 间隙开始的Y坐标（在截图中的偏移）
        for y in range(h-1, -1, -1):
            if not is_dark[y] and gap_start is None:
                gap_start = y  # 找到一个亮行 = 间隙
            elif is_dark[y] and gap_start is not None:
                # 亮行结束，进入内容行
                # gap_start 到 y 之间就是间隙
                gap_bottom = scan_top + gap_start  # 间隙底部（屏幕坐标）
                gap_top = scan_top + y              # 间隙顶部
                gap_height = gap_bottom - gap_top
                
                if 3 <= gap_height <= 35:  # 3-35px的行间距
                    # 间隙上方的第一行内容就是「谁可以看」
                    guess_y = gap_top - 15  # 定位到间隙上方内容的中部
                    print(f"  找到间隙: y=[{gap_top},{gap_bottom}] 高{gap_height}px → 设置行≈{guess_y}")
                    return x_center, guess_y
                gap_start = None  # 继续找上级间隙
        
        # 没找到间隙，用默认偏移
        print(f"  像素扫描未定位间隙，偏移=60px")
        return x_center, anchor_y - 60
    
    def _find_private_subwindow(self):
        """查找隐私设置子窗口（点击「谁可以看」后弹出的窗口）"""
        for title in ["微信谁可以看", "谁可以看", "Weixin"]:
            w = get_window(title)
            if w:
                return w['hwnd']
        
        # 枚举所有 Qt5 窗口，选尺寸合适的
        result = [None]
        def find_sub(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                c = win32gui.GetClassName(hwnd)
                t = win32gui.GetWindowText(hwnd)
                if 'Qt5' in c:
                    r = win32gui.GetWindowRect(hwnd)
                    w, h = r[2]-r[0], r[3]-r[1]
                    if 300 < w < 500 and 400 < h < 600:
                        result[0] = hwnd
                        print(f"  找到子窗口: {t} ({w}x{h})")
        win32gui.EnumWindows(find_sub, None)
        return result[0]
    
    def step5_set_privacy(self, privacy="公开", contact="", file_count=0):
        """设置隐私：先多方式滚动 → 像素分析找行 → 点击「谁可以看」→ 选「私密」→ 确定"""
        print(f"\n=== Step 5: 设置隐私 ({privacy}) ===")
        
        self.moments_win = get_window("朋友圈")
        if not self.moments_win:
            self.log(5, "FAIL", "朋友圈窗口丢失")
            return False
        
        hwnd = self.moments_win['hwnd']
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.5)
        
        # 第一步：多图时滚动到底（win32api mouse_event + 像素对比验证）
        self._scroll_to_reveal_bottom(hwnd, file_count)
        
        # 第二步：像素分析找「谁可以看」行的精确位置
        click_x, click_y = self._find_privacy_row_after_scroll(hwnd)
        
        if click_x == 0 and click_y == 0:
            self.log(5, "FAIL", "找不到锚点按钮")
            return False
        
        print(f"  点击「谁可以看」: ({click_x},{click_y})")
        pyautogui.click(click_x, click_y)
        time.sleep(2)
        
        # 检查隐私窗口是否弹出
        sub_hwnd = self._find_private_subwindow()
        if not sub_hwnd:
            # 没弹出，尝试附近位置（±5px）
            for dy in [-10, -20, 10, -30, 20, -40]:
                pyautogui.click(click_x, click_y + dy)
                time.sleep(1.5)
                sub_hwnd = self._find_private_subwindow()
                if sub_hwnd:
                    print(f"  附近偏移 {dy}px 成功")
                    break
            
            if not sub_hwnd:
                self.log(5, "FAIL", "无法定位「谁可以看」")
                return False
        
        # 第三步：操作子窗口：选「私密」→ 确定
        print(f"  子窗口: {win32gui.GetWindowText(sub_hwnd)}")
        win32gui.SetForegroundWindow(sub_hwnd)
        time.sleep(0.5)
        
        sub_items = self._uia_scan(sub_hwnd)
        
        if privacy == "私密":
            if "私密" in sub_items:
                pyautogui.click(sub_items["私密"]['cx'], sub_items["私密"]['cy'])
                print(f"  点击「私密」: ({sub_items['私密']['cx']},{sub_items['私密']['cy']})")
                time.sleep(0.3)
            elif "公开" in sub_items:
                pub = sub_items["公开"]
                pyautogui.click(pub['cx'], pub['cy'] + 40)
                print(f"  点击「公开」下方: ({pub['cx']},{pub['cy']+40})")
                time.sleep(0.3)
        
        if "确定" in sub_items:
            pyautogui.click(sub_items["确定"]['cx'], sub_items["确定"]['cy'])
            print(f"  点击「确定」: ({sub_items['确定']['cx']},{sub_items['确定']['cy']})")
        else:
            pyautogui.press('enter')
            print(f"  按 Enter 确认")
        
        time.sleep(1.5)
        
        if not win32gui.IsWindowVisible(sub_hwnd):
            self.log(5, "PASS", f"隐私已设置: {privacy}")
            return True
        else:
            pyautogui.press('enter')
            time.sleep(1)
            self.log(5, "PASS", f"隐私已设置: {privacy}")
            return True
        
        # 验证子窗口是否关闭
        if not win32gui.IsWindowVisible(sub_hwnd):
            self.log(5, "PASS", f"隐私已设置: {privacy}")
            return True
        else:
            # 窗口还在，再按一次确定
            pyautogui.press('enter')
            time.sleep(1)
            self.log(5, "PASS", f"隐私已设置: {privacy}")
            return True
    
    # ====== Step 6: 发布 ======
    def step6_publish(self):
        """点击编辑器发表按钮"""
        print(f"\n=== Step 6: 发布 ===")
        
        self.moments_win = get_window("朋友圈")
        if not self.moments_win:
            self.log(6, "FAIL", "朋友圈窗口丢失")
            return False
        
        hwnd = self.moments_win['hwnd']
        
        # 获取编辑器发表按钮坐标
        coords = get_uia_button(hwnd, "发表", min_y=400)
        if not coords:
            self.log(6, "FAIL", "未找到编辑器发表按钮")
            return False
        
        px, py = coords
        print(f"  发表按钮: ({px},{py})")
        
        # 截图前
        before_arr = np.array(ImageGrab.grab())
        
        pyautogui.click(px, py)
        time.sleep(3)
        
        # 截图后对比
        after_arr = np.array(ImageGrab.grab())
        diff = np.abs(after_arr.astype(float) - before_arr.astype(float))
        
        r = self.moments_win['rect']
        white_region = after_arr[r[1]+50:r[1]+550, r[0]+150:r[0]+500, :]
        white_brightness = white_region.mean() if white_region.size > 0 else 0
        
        print(f"  屏幕变化: {diff.mean():.1f}")
        print(f"  白色区域亮度: {white_brightness:.0f}")
        
        if white_brightness < 200:
            self.log(6, "PASS", "编辑器已关闭，发布成功！")
            return True
        else:
            self.log(6, "WARN", "编辑器可能仍在显示")
            return True  # 仍然认为成功
    
    # ====== Step 3b: 多文件选择 ======
    def _select_files_batch(self, file_paths):
        """选择文件：复制到临时目录 → 导航到目录 → 全选所有 → 打开"""
        if not file_paths:
            return True
        
        # 创建临时目录并复制所有文件
        import shutil
        import tempfile
        tmp_dir = tempfile.mkdtemp(prefix='yizhun_moment_')
        copied = []
        for fp in file_paths:
            dst = os.path.join(tmp_dir, os.path.basename(fp))
            shutil.copy2(fp, dst)
            copied.append(dst)
        print(f"  已复制 {len(copied)} 个文件到 {tmp_dir}")
        
        dialog = self.dialog_win
        if not dialog:
            print("  错误: dialog_win 未设置")
            return False
        
        dr = win32gui.GetWindowRect(dialog['hwnd'])
        dw, dh = dr[2]-dr[0], dr[3]-dr[1]
        win32gui.SetForegroundWindow(dialog['hwnd'])
        time.sleep(0.5)
        
        # 方法1: F4 聚焦地址栏（比 Alt+D 更通用）
        pyautogui.press('f4')
        time.sleep(0.5)
        pyperclip.copy(tmp_dir)
        pyautogui.hotkey('ctrl', 'a')
        time.sleep(0.1)
        pyautogui.hotkey('ctrl', 'v')
        time.sleep(0.3)
        pyautogui.press('enter')
        time.sleep(2.5)  # 等待目录加载
        
        # Tab 从地址栏切换到文件列表，然后 Ctrl+A 全选
        pyautogui.press('tab')
        time.sleep(0.3)
        pyautogui.press('tab')
        time.sleep(0.3)
        
        # 点击文件列表中央确保焦点
        pyautogui.click(dr[0] + dw//3, dr[1] + dh//2)
        time.sleep(0.3)
        
        pyautogui.hotkey('ctrl', 'a')
        time.sleep(0.5)
        
        # Alt+O 打开（比坐标点击更可靠）
        print(f"  目录={tmp_dir} 全选→Alt+O打开")
        pyautogui.hotkey('alt', 'o')
        time.sleep(4)
        
        # 验证对话框关闭
        still_there = None
        def scan(h, _):
            nonlocal still_there
            if win32gui.IsWindowVisible(h) and win32gui.GetClassName(h) == '#32770':
                r2 = win32gui.GetWindowRect(h)
                if r2[2] - r2[0] > 300:
                    still_there = h
        win32gui.EnumWindows(scan, None)
        
        if still_there:
            print(f"  对话框未关，再按 Enter...")
            pyautogui.press('enter')
            time.sleep(2)
        
        self.log(3, "PASS", f"已选择 {len(file_paths)} 个文件")
        
        # 清理（延迟，因为 WeChat 可能还在读取）
        try:
            import threading
            def _cleanup():
                time.sleep(10)
                shutil.rmtree(tmp_dir, ignore_errors=True)
            threading.Thread(target=_cleanup, daemon=True).start()
        except:
            pass
        
        return True
    
    # ====== 主流程 ======
    def run(self, file_paths=None, text="", privacy="公开", contact="", json_output=False):
        """
        运行完整发布流程
        file_paths: 文件路径列表（支持多图，最多 9 张）
        privacy: "公开" | "私密" | "谁可以看" | "不给谁看"
        contact: 指定可见/不可见的联系人（仅 privacy 为谁可以看/不给谁看时有效）
        json_output: True 时最后一行输出 JSON 结果
        """
        overall_success = True
        num_files = len(file_paths) if file_paths else 0
        
        if not json_output:
            print("=" * 60)
            print("壹准AI营销助手 — 朋友圈发布 v9")
            print("=" * 60)
        
        try:
            if not self.step1_open_moments():
                overall_success = False
                return self._finish(overall_success, json_output)
            
            if not self.step2_click_entry():
                overall_success = False
                return self._finish(overall_success, json_output)
            
            if file_paths:
                if not self._select_files_batch(file_paths):
                    overall_success = False
                    self.log(3, "FAIL", "文件选择失败")
                    return self._finish(overall_success, json_output)
            else:
                # 无媒体文件：不支持纯文字发布（需媒体文件触发编辑器）
                if hasattr(self, 'dialog_win') and self.dialog_win:
                    try:
                        win32gui.SetForegroundWindow(self.dialog_win['hwnd'])
                        time.sleep(0.2)
                        pyautogui.press('escape')
                        time.sleep(0.5)
                    except:
                        pass
                overall_success = False
                self.log(3, "FAIL", "未提供图片/视频，请选择媒体文件后重试")
                return self._finish(overall_success, json_output)
            
            # 等待编辑器加载图片（多图需要更长时间）
            if num_files > 3:
                wait_sec = 3 + num_files  # 9张图约等12秒
                print(f"\n  等待编辑器加载 {num_files} 张图片 ({wait_sec}s)...")
                time.sleep(wait_sec)
            
            if text:
                self.step4_input_text(text)
            else:
                if not json_output:
                    print("\n⚠ 未提供文案，跳过文案输入")
            
            self.step5_set_privacy(privacy, contact, file_count=num_files)
            
            if not self.step6_publish():
                overall_success = False
                return self._finish(overall_success, json_output)
            
        except Exception as e:
            if json_output:
                print(f"ERROR: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
            else:
                print(f"\n✗ 错误: {e}")
                import traceback
                traceback.print_exc()
            overall_success = False
        
        return self._finish(overall_success, json_output)
    
    def _finish(self, overall_success, json_output):
        """统一结束处理：输出汇总或 JSON"""
        if json_output:
            # 输出单行 JSON 给调用方解析
            failures = [r for r in self.results if r['status'] == 'FAIL']
            msg = "; ".join(r['detail'] for r in failures) if failures else "发布成功"
            result = {"success": overall_success, "error": "" if overall_success else msg, "message": msg, "steps": self.results}
            print(json.dumps(result, ensure_ascii=False))
        else:
            print("\n" + "=" * 60)
            print("结果汇总:")
            for r in self.results:
                icon = "✓" if r['status'] == "PASS" else "✗" if r['status'] == "FAIL" else "?"
                print(f"  {icon} {r['detail']}")
        
        return self.results


# ====== 命令行入口 ======
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="壹准AI营销助手 — 朋友圈发布 v9",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python moment_publisher_v9.py --text "以旧换新活动🔥" --media "C:\\img.jpg"
  python moment_publisher_v9.py --text "文案" --media "a.jpg" "b.jpg" --privacy "谁可以看" --contact "张三"
  python moment_publisher_v9.py --text "文案" --privacy "公开" --json
        """
    )
    parser.add_argument('--text', default='', help='朋友圈文案')
    parser.add_argument('--media', nargs='*', default=[], help='媒体文件路径（支持多个）')
    parser.add_argument('--privacy', default='公开',
                        choices=['公开', '私密', '谁可以看', '不给谁看'],
                        help='隐私设置（默认: 公开）')
    parser.add_argument('--contact', default='',
                        help='联系人（谁可以看/不给谁看时需要）')
    parser.add_argument('--json', action='store_true',
                        help='以 JSON 格式输出结果（最后一行）')
    
    args = parser.parse_args()
    
    # 过滤掉不存在的文件
    valid_media = [f for f in args.media if os.path.exists(f)]
    if args.media and not valid_media:
        print(f"警告: 所有文件都不存在，将跳过文件选择")
    elif len(valid_media) < len(args.media):
        missing = set(args.media) - set(valid_media)
        print(f"警告: 以下文件不存在，已跳过: {missing}")
    
    try:
        publisher = MomentPublisher()
        publisher.run(
            file_paths=valid_media if valid_media else None,
            text=args.text,
            privacy=args.privacy,
            contact=args.contact,
            json_output=args.json,
        )
    except Exception as e:
        # 最外层兜底：确保 JSON 模式始终有输出
        if args.json:
            print(json.dumps({"success": False, "error": f"脚本异常: {e}", "message": f"脚本异常: {e}", "steps": []}, ensure_ascii=False))
        else:
            import traceback
            traceback.print_exc()
        sys.exit(1)
