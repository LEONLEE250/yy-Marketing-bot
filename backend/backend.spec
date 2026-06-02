# -*- mode: python ; coding: utf-8 -*-

import os

# 收集 wechat-wxauto 模块作为 data
wxa_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'wechat-wxauto')
wxa_files = []
if os.path.isdir(wxa_dir):
    for f in os.listdir(wxa_dir):
        fp = os.path.join(wxa_dir, f)
        if os.path.isfile(fp) and f.endswith('.py'):
            wxa_files.append((fp, 'wechat-wxauto'))

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[('data', 'data')] + wxa_files,
    hiddenimports=[
        'flask', 'flask_cors', 'wxauto', 'PIL', 'requests',
        'image_enhancer', 'ai_copywriter', 'wxauto_service',
        'numpy', 'PIL.Image', 'PIL.ImageDraw', 'PIL.ImageFont',
        'PIL.ImageFilter', 'PIL.ImageEnhance',
        'shutil', 'json', 'hashlib', 'base64',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
