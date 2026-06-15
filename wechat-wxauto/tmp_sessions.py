# -*- coding: utf-8 -*-
import sys
sys.path.insert(0, r'C:\Users\EDY\WorkBuddy\2026-05-28-14-09-05\wechat-wxauto')
from wxauto_service import get_wx

wx = get_wx()
sessions = wx.GetSession()
print(f'共 {len(sessions)} 个会话:')
for i, s in enumerate(sessions):
    print(f'  [{i}] type={type(s).__name__}  str={str(s)}  repr={repr(s)}')
    if hasattr(s, '__dict__'):
        print(f'       attrs={s.__dict__}')
