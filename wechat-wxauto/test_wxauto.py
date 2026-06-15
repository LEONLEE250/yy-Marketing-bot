"""
快速测试脚本 - 请先确保微信PC版已登录并打开
运行: C:\Python312\python.exe test_wxauto.py
"""
import sys
sys.path.insert(0, ".")

from wxauto_service import check_status, get_sessions, send_text

print("=" * 50)
print("wxauto4 快速测试")
print("=" * 50)

# 1. 检查状态
print("\n[1] 检查微信状态...")
status = check_status()
print(f"    结果: {status}")

if not status.get("online"):
    print("\n⚠️  微信未在线！请确保：")
    print("    1. 电脑微信已登录")
    print("    2. 微信主窗口未最小化到托盘")
    print("    3. 微信版本为 4.1.x")
    sys.exit(1)

# 2. 获取会话列表
print("\n[2] 获取最近会话...")
sessions = get_sessions()
if sessions.get("success"):
    for s in sessions["sessions"][:10]:
        print(f"    - {s}")

# 3. 发送测试消息给文件传输助手
print("\n[3] 发送测试消息到「文件传输助手」...")
result = send_text("文件传输助手", "wxauto4 测试消息 - 来自 WorkBuddy")
print(f"    结果: {result}")

print("\n✅ 测试完成！")
