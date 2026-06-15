# -*- mode: python ; coding: utf-8 -*-

import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, collect_dynamic_libs
import comtypes

# 自动检测项目根目录（本地开发可能在父目录运行，CI中CWD就是项目根）
_spec_dir = Path.cwd()
if (_spec_dir / 'backend' / 'app.py').exists():
    _project_dir = _spec_dir
elif (_spec_dir / 'yizhun-wechat-bot' / 'backend' / 'app.py').exists():
    _project_dir = _spec_dir / 'yizhun-wechat-bot'
elif (_spec_dir / 'yizhun-wechat-bot-v1.1-dev' / 'backend' / 'app.py').exists():
    _project_dir = _spec_dir / 'yizhun-wechat-bot-v1.1-dev'
else:
    _project_dir = _spec_dir
_backend_dir = _project_dir / 'backend'
wxa_dir = os.path.abspath(os.path.join(str(_project_dir), 'wechat-wxauto'))
wxa_files = []
if os.path.isdir(wxa_dir):
    for f in os.listdir(wxa_dir):
        fp = os.path.join(wxa_dir, f)
        if os.path.isfile(fp) and f.endswith('.py'):
            wxa_files.append((fp, 'wechat-wxauto'))

comtypes_gen_project_dir = os.path.join(wxa_dir, 'comtypes_gen')
comtypes_gen_project_datas = []
if os.path.isdir(comtypes_gen_project_dir):
    for f in os.listdir(comtypes_gen_project_dir):
        fp = os.path.join(comtypes_gen_project_dir, f)
        if os.path.isfile(fp) and f.endswith('.py'):
            comtypes_gen_project_datas.append((fp, 'wechat-wxauto/comtypes_gen'))

wxauto4_hiddenimports = collect_submodules('wxauto4')
wxauto4_datas = collect_data_files('wxauto4')
wxauto4_binaries = collect_dynamic_libs('wxauto4')
comtypes_hiddenimports = collect_submodules('comtypes')
comtypes_datas = collect_data_files('comtypes')
comtypes_gen_dir = os.path.join(os.path.dirname(comtypes.__file__), 'gen')
comtypes_gen_datas = [(comtypes_gen_dir, 'comtypes/gen')] if os.path.isdir(comtypes_gen_dir) else []

a = Analysis(
    [str(_backend_dir / 'app.py')],
    pathex=[str(_backend_dir), wxa_dir],
    binaries=wxauto4_binaries,
    datas=[('data', 'data'), ('data_preview', 'data_preview')] + wxa_files + comtypes_gen_project_datas + wxauto4_datas + comtypes_datas + comtypes_gen_datas,
    hiddenimports=[
        'flask', 'flask_cors', 'PIL', 'requests',
        'image_enhancer', 'ai_copywriter', 'wxauto_service', 'wechat_moment', 'wechat_moment_v2',
        'numpy', 'PIL.Image', 'PIL.ImageDraw', 'PIL.ImageFont',
        'PIL.ImageFilter', 'PIL.ImageEnhance',
        'shutil', 'json', 'hashlib', 'base64',
        'comtypes', 'comtypes.client', 'comtypes.gen', 'comtypes.gen.UIAutomationClient'
    ] + wxauto4_hiddenimports + comtypes_hiddenimports,
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
