"""
壹准 AI 营销助手 - Flask 后端 API v1.2.2
端口 5680
"""

import sys
import os
import json
import time
import threading
import traceback
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_DEV_WXAUTO = os.path.abspath(os.path.join(_BASE_DIR, '..', '..', 'wechat-wxauto'))
_PROJECT_WXAUTO = os.path.abspath(os.path.join(_BASE_DIR, '..', 'wechat-wxauto'))
_EXE_DIR = os.path.dirname(os.path.abspath(sys.executable))
_PKG_WXAUTO = os.path.abspath(os.path.join(_EXE_DIR, '..', 'wechat-wxauto'))
for _p in [_DEV_WXAUTO, _PROJECT_WXAUTO, _PKG_WXAUTO]:
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)

app = Flask(__name__)
CORS(app)

# ── 应用标识 ──────────────────────────────────────────
APP_VERSION = "2.0.1"
APP_CHANNEL = "preview"
APP_PORT = 5680
APP_STARTED_AT = time.time()
APP_INSTANCE_ID = f"v1.2.2-{int(APP_STARTED_AT)}-{os.getpid()}"

# ============================================================
# 配置管理
# ============================================================

# Preview 使用独立数据目录，不污染正式版
# 打包 (frozen) 模式：持久化到 %APPDATA%，避免每次重启丢失配置
# 开发模式：本地 data_preview/ 目录
_PREVIEW_DATA_ROOT = os.environ.get('YIZHUN_PREVIEW_DATA_DIR', '')
if not _PREVIEW_DATA_ROOT:
    if getattr(sys, 'frozen', False):
        _PREVIEW_DATA_ROOT = os.path.join(
            os.environ.get('APPDATA', os.path.expanduser('~')),
            'yizhun-wechat-bot-preview'
        )
    else:
        _PREVIEW_DATA_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data_preview')
CONFIG_DIR = _PREVIEW_DATA_ROOT
os.makedirs(CONFIG_DIR, exist_ok=True)
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.json')
SCRIPTS_FILE = os.path.join(CONFIG_DIR, 'scripts.json')
UPLOAD_DIR = os.path.join(CONFIG_DIR, 'uploads')
OUTPUT_DIR = os.path.join(CONFIG_DIR, 'output')
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

DEFAULT_CONFIG = {
    "ai": {
        "enabled": False,
        "api_url": "https://api.openai.com/v1",
        "api_key": "",
        "model": "gpt-4o-mini",
        "tested": False
    },
    "fallback": {
        "use_scripts": True,
        "allow_manual": True
    },
    "broadcast": {
        "interval": 0.8,
        "exclude": ["微信团队", "文件传输助手"]
    },
    "app": {
        "version": APP_VERSION,
        "update_channel": "github"
    }
}

DEFAULT_SCRIPTS = []


def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    save_config(DEFAULT_CONFIG)
    return DEFAULT_CONFIG.copy()


def save_config(cfg):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def load_scripts():
    if os.path.exists(SCRIPTS_FILE):
        with open(SCRIPTS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    save_scripts(DEFAULT_SCRIPTS)
    return DEFAULT_SCRIPTS.copy()


def save_scripts(scripts):
    with open(SCRIPTS_FILE, 'w', encoding='utf-8') as f:
        json.dump(scripts, f, ensure_ascii=False, indent=2)


def mask_key(key):
    if not key:
        return ""
    return key[:3] + "\u2022" * 12 + key[-4:] if len(key) > 7 else "\u2022" * 8


# ============================================================
# 状态检查
# ============================================================

@app.route('/api/status', methods=['GET'])
def api_status():
    try:
        from wxauto_service import check_status
        status = check_status()
        return jsonify({
            "success": True,
            "wx_online": status.get("online", False),
            "info": status.get("info", "未知状态")
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "wx_online": False,
            "info": f"微信状态读取失败: {str(e)}"
        })


# ============================================================
# 会话管理
# ============================================================

@app.route('/api/sessions', methods=['GET'])
def api_sessions():
    try:
        from wxauto_service import get_sessions
        result = get_sessions()
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/sessions/match', methods=['POST'])
def api_match_sessions():
    data = request.json or {}
    keywords = data.get('keywords', [])
    try:
        from wxauto_service import match_sessions
        result = match_sessions(keywords)
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


# ============================================================
# 图片上传
# ============================================================

@app.route('/api/image/upload', methods=['POST'])
def api_upload_image():
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "No file provided"})
    file = request.files['file']
    if file.filename == '':
        return jsonify({"success": False, "error": "Empty filename"})
    filename = f"{int(time.time())}_{file.filename}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)
    return jsonify({"success": True, "path": filepath, "filename": filename})


@app.route('/api/image/output/<filename>', methods=['GET'])
def api_get_image(filename):
    filepath = os.path.join(OUTPUT_DIR, filename)
    if os.path.exists(filepath):
        return send_file(filepath, mimetype='image/png')
    return jsonify({"success": False, "error": "File not found"}), 404


# ============================================================
# 群发
# ============================================================

@app.route('/api/broadcast', methods=['POST'])
def api_broadcast():
    """统一群发入口 — 支持纯文本/图文/视频"""
    data = request.json or {}
    targets = data.get('targets', [])
    message = data.get('message', '')
    image_path = data.get('image_path')
    video_path = data.get('video_path')
    interval = data.get('interval', 0.8)
    send_mode = data.get('send_mode', 'default')

    if not targets:
        return jsonify({"success": False, "error": "请提供收件人列表"})

    if not message and not image_path and not video_path:
        return jsonify({"success": False, "error": "请至少输入发送内容或上传文件"})

    try:
        from wxauto_service import broadcast_image, broadcast_text

        prefer_manual = send_mode == 'manual_only'
        if image_path and os.path.isfile(image_path):
            result = broadcast_image(targets, image_path, message, interval, prefer_manual=prefer_manual)
        elif video_path and os.path.isfile(video_path):
            result = broadcast_image(targets, video_path, message, interval, prefer_manual=prefer_manual)
        else:
            result = broadcast_text(targets, message, interval, prefer_manual=prefer_manual)

        result['send_mode'] = send_mode
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


# ============================================================
# 定时发送
# ============================================================

@app.route('/api/broadcast/schedule', methods=['POST'])
def api_schedule_broadcast():
    """创建定时群发任务"""
    data = request.json or {}
    targets = data.get('targets', [])
    message = data.get('message', '')
    image_path = data.get('image_path')
    scheduled_at = data.get('scheduled_at', '')

    if not targets:
        return jsonify({"success": False, "error": "请提供收件人列表"})
    if not message and not image_path:
        return jsonify({"success": False, "error": "请至少输入发送内容或上传图片"})
    if not scheduled_at:
        return jsonify({"success": False, "error": "请设置定时时间"})

    try:
        from wxauto_service import schedule_broadcast
        result = schedule_broadcast(targets, message, scheduled_at, image_path)
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/broadcast/schedule', methods=['GET'])
def api_get_scheduled_tasks():
    try:
        from wxauto_service import get_scheduled_tasks
        result = get_scheduled_tasks()
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/broadcast/schedule/<task_id>', methods=['DELETE'])
def api_cancel_scheduled_task(task_id):
    try:
        from wxauto_service import cancel_scheduled_task
        result = cancel_scheduled_task(task_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


# ============================================================
# AI 文案生成
# ============================================================

@app.route('/api/copy/generate', methods=['POST'])
def api_generate_copy():
    data = request.json or {}
    context = data.get('context', '')
    style = data.get('style', '朋友圈')

    config = load_config()

    if config['ai']['enabled'] and config['ai']['api_key']:
        ai_result = _call_ai_api(config['ai'], context, style)
        if ai_result:
            return jsonify({"success": True, "copy": ai_result, "source": "ai"})

    if config['fallback']['use_scripts']:
        scripts = load_scripts()
        matched = _match_scripts(context, scripts)
        if matched:
            return jsonify({"success": True, "copy": matched, "source": "scripts"})

    try:
        from ai_copywriter import smart_generate
        copy = smart_generate(context, style)
        return jsonify({"success": True, "copy": copy, "source": "local"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


def _match_scripts(context, scripts):
    scene_map = {
        "以旧换新": ["以旧换新", "换新机", "回收", "旧手机", "抵扣", "折价"],
        "新品推荐": ["新到", "到货", "新机", "新品", "上新", "推荐", "型号"],
        "促销活动": ["促销", "特价", "打折", "清仓", "限时", "活动", "优惠"],
        "品牌宣传": ["品牌", "宣传", "介绍", "壹准", "门店", "开业"],
    }

    best_tag = "品牌宣传"
    best_score = 0
    for tag, keywords in scene_map.items():
        score = sum(1 for kw in keywords if kw in context)
        if score > best_score:
            best_score = score
            best_tag = tag

    for s in scripts:
        if s['tag'] == best_tag:
            return s['text']

    if scripts:
        return scripts[0]['text']
    return None


def _call_ai_api(ai_config, context, style):
    try:
        import urllib.request
        api_url = ai_config['api_url'].rstrip('/') + '/chat/completions'
        api_key = ai_config['api_key']
        model = ai_config.get('model', 'gpt-4o-mini')

        style_guide = {
            "朋友圈": "用亲切的口吻，带emoji，适合发朋友圈，要有互动感",
            "营销": "热情促销风格，突出优惠和限时，制造紧迫感",
            "简洁": "极简风格，一句话说完，最多两句话",
            "专业": "正式专业风格，像产品说明书，突出规格参数",
        }

        payload = json.dumps({
            "model": model,
            "messages": [
                {"role": "system",
                 "content": f"你是壹准二手手机店的营销文案助手。根据用户提供的内容，生成一段适合微信营销的文案。风格要求：{style_guide.get(style, style_guide['朋友圈'])}。不要强行添加地址或门店信息，除非用户明确要求。"},
                {"role": "user", "content": f"根据以下内容生成营销文案：{context}"}
            ],
            "max_tokens": 300,
            "temperature": 0.8
        }).encode('utf-8')

        req = urllib.request.Request(api_url, data=payload, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        })

        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            return result['choices'][0]['message']['content'].strip()
    except Exception:
        return None


@app.route('/api/copy/test-api', methods=['POST'])
def api_test_ai():
    data = request.json or {}
    api_config = {
        "api_url": data.get('api_url', ''),
        "api_key": data.get('api_key', ''),
        "model": data.get('model', 'gpt-4o-mini'),
    }
    result = _call_ai_api(api_config, "测试连接", "简洁")
    if result:
        return jsonify({"success": True, "message": "连接正常"})
    return jsonify({"success": False, "error": "连接失败，请检查 API Key 和地址"})


# ============================================================
# 话术库 CRUD
# ============================================================

@app.route('/api/scripts', methods=['GET'])
def api_get_scripts():
    scripts = load_scripts()
    return jsonify({"success": True, "scripts": scripts})


@app.route('/api/scripts', methods=['POST'])
def api_add_script():
    data = request.json or {}
    tag = data.get('tag', '').strip()
    text = data.get('text', '').strip()
    if not tag or not text:
        return jsonify({"success": False, "error": "标签和内容不能为空"})

    scripts = load_scripts()
    new_id = f"s{int(time.time())}"
    scripts.append({"id": new_id, "tag": tag, "text": text})
    save_scripts(scripts)
    return jsonify({"success": True, "script": {"id": new_id, "tag": tag, "text": text}})


@app.route('/api/scripts/<script_id>', methods=['PUT'])
def api_update_script(script_id):
    data = request.json or {}
    scripts = load_scripts()
    for s in scripts:
        if s['id'] == script_id:
            if 'tag' in data:
                s['tag'] = data['tag'].strip()
            if 'text' in data:
                s['text'] = data['text'].strip()
            save_scripts(scripts)
            return jsonify({"success": True, "script": s})
    return jsonify({"success": False, "error": "话术不存在"}), 404


@app.route('/api/scripts/<script_id>', methods=['DELETE'])
def api_delete_script(script_id):
    scripts = load_scripts()
    scripts = [s for s in scripts if s['id'] != script_id]
    save_scripts(scripts)
    return jsonify({"success": True})


# ============================================================
# 配置管理
# ============================================================

@app.route('/api/config', methods=['GET'])
def api_get_config():
    config = load_config()
    if config['ai'].get('api_key'):
        config['ai']['api_key_masked'] = mask_key(config['ai']['api_key'])
    return jsonify({"success": True, "config": config})


@app.route('/api/config', methods=['PUT'])
def api_update_config():
    data = request.json or {}
    config = load_config()

    for section in ['ai', 'fallback', 'broadcast', 'app']:
        if section in data:
            section_data = data[section]
            cleaned = {k: v for k, v in section_data.items() if v is not None and v != ''}
            config[section].update(cleaned)

    save_config(config)
    return jsonify({"success": True, "config": config})


# ============================================================
# 更新检查
# ============================================================

@app.route('/api/update/check', methods=['GET'])
def api_check_update():
    current_ver = APP_VERSION

    try:
        import urllib.request
        import ssl
        url = "https://api.github.com/repos/LEONLEE250/yy-Marketing-bot/releases/latest"
        req = urllib.request.Request(url, headers={
            "User-Agent": "YizhunApp/1.0",
            "Accept": "application/vnd.github.v3+json"
        })

        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            body = resp.read().decode('utf-8')
            release = json.loads(body)
            latest_ver = release.get('tag_name', 'v0.0.0').lstrip('v')
            download_url = None
            for asset in release.get('assets', []):
                if asset['name'].endswith('.exe'):
                    download_url = asset['browser_download_url']
                    break
            has_update = _compare_versions(latest_ver, current_ver) > 0
            return jsonify({
                "success": True,
                "current": current_ver,
                "latest": latest_ver,
                "has_update": has_update,
                "download_url": download_url,
                "release_notes": release.get('body', '')
            })
    except Exception as e:
        return jsonify({
            "success": False,
            "has_update": False,
            "error": str(e),
            "current": current_ver
        })


def _compare_versions(v1, v2):
    """比较版本号。支持 1.2.0 / 1.1.5-preview 等带后缀的格式。"""
    def _clean(v):
        v = v.lstrip('v')
        for sep in ('-', '+', '_'):
            if sep in v:
                v = v.split(sep)[0]
                break
        return [int(x) for x in v.split('.')]
    try:
        p1 = _clean(v1)
        p2 = _clean(v2)
        for a, b in zip(p1, p2):
            if a > b: return 1
            if a < b: return -1
        return len(p1) - len(p2)
    except Exception:
        return 0


# ============================================================
# 健康检查
# ============================================================

@app.route('/api/health', methods=['GET'])
def api_health():
    """健康检查 + 实例自检信息"""
    is_frozen = getattr(sys, 'frozen', False)
    backend_path = os.path.abspath(sys.executable if is_frozen else __file__)
    runtime_dir = os.path.dirname(backend_path) if is_frozen else os.path.dirname(os.path.abspath(__file__))
    return jsonify({
        "status": "ok",
        "channel": APP_CHANNEL,
        "version": APP_VERSION,
        "backend_path": backend_path,
        "runtime_dir": runtime_dir,
        "cwd": os.getcwd(),
        "config_dir": os.path.abspath(CONFIG_DIR),
        "log_dir": os.path.abspath(os.path.join(CONFIG_DIR, 'logs')),
        "pid": os.getpid(),
        "port": APP_PORT,
        "instance_id": APP_INSTANCE_ID,
        "started_at_ts": APP_STARTED_AT,
        "packaged": is_frozen,
        "capabilities": {
            "moment_publish": True,
            "moment_schedule": True,
            "moment_cancel": True,
            "moment_logs": True,
            "broadcast": True,
            "ai_copy": True,
        }
    })


@app.route('/api/runtime/diagnostics', methods=['GET'])
def api_diagnostics():
    """完整运行时诊断信息"""
    is_frozen = getattr(sys, 'frozen', False)
    backend_path = os.path.abspath(sys.executable if is_frozen else __file__)
    runtime_dir = os.path.dirname(backend_path) if is_frozen else os.path.dirname(os.path.abspath(__file__))

    moment_module_path = ''
    try:
        import wechat_moment_v2
        moment_module_path = os.path.abspath(wechat_moment_v2.__file__) if hasattr(wechat_moment_v2, '__file__') else '(built-in)'
    except Exception:
        moment_module_path = '(not loaded)'

    registered_routes = sorted([rule.rule for rule in app.url_map.iter_rules() if rule.rule.startswith('/api/')])

    return jsonify({
        "app_version": APP_VERSION,
        "channel": APP_CHANNEL,
        "backend_path": backend_path,
        "runtime_dir": runtime_dir,
        "config_dir": os.path.abspath(CONFIG_DIR),
        "log_dir": os.path.abspath(os.path.join(CONFIG_DIR, 'logs')),
        "pid": os.getpid(),
        "port": APP_PORT,
        "instance_id": APP_INSTANCE_ID,
        "started_at_ts": APP_STARTED_AT,
        "packaged": is_frozen,
        "moment_module_path": moment_module_path,
        "registered_routes": registered_routes,
        "python_version": sys.version,
        "cwd": os.getcwd(),
    })


# ============================================================
# 优雅关闭
# ============================================================

@app.route('/api/shutdown', methods=['POST'])
def api_shutdown():
    """优雅关闭后端服务"""
    import threading

    def _do_shutdown():
        time.sleep(0.3)
        os._exit(0)

    t = threading.Thread(target=_do_shutdown, daemon=True)
    t.start()
    return jsonify({"success": True, "message": "shutting down"})


# ============================================================
# 朋友圈
# ============================================================

@app.route('/api/moment/publish', methods=['POST'])
def api_publish_moment():
    """发布朋友圈（文字/图片/视频）— 在独立子进程中运行，隔离 COM"""
    data = request.json or {}
    text = data.get('text', '').strip()
    media_paths = data.get('media_paths', data.get('media_path'))
    media_type = data.get('media_type', 'image')
    scheduled_at = data.get('scheduled_at')

    has_media = bool(media_paths)
    if not text and not has_media:
        return jsonify({"success": False, "error": "请至少输入文字或上传图片/视频"})
    if len(text) > 2000:
        return jsonify({"success": False, "error": "文字过长，最多2000字"})

    if isinstance(media_paths, str):
        media_paths = [media_paths] if media_paths else []
    if media_paths is None:
        media_paths = []

    try:
        # 在子进程中运行，隔离 COM 状态，防止与群发 wxauto 互崩
        import subprocess, tempfile
        import sys as _sys

        WEIXIN_AUTO_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'wechat-wxauto')
        _py = r'C:\Python312\python.exe'
        PYTHON_EXE = _py if os.path.exists(_py) else (os.environ.get('YIZHUN_PYTHON') or os.environ.get('PYTHON') or 'python')
        if not os.path.exists(PYTHON_EXE):
            PYTHON_EXE = _sys.executable

        in_data = json.dumps({
            'text': text, 'media_paths': media_paths,
            'media_type': media_type, 'scheduled_at': scheduled_at
        }, ensure_ascii=False)

        script = (
            "import sys,os,json\n"
            f"sys.path.insert(0,{json.dumps(WEIXIN_AUTO_DIR)})\n"
            f"os.chdir({json.dumps(WEIXIN_AUTO_DIR)})\n"
            "from wechat_moment_v2 import publish,schedule\n"
            "data=json.loads(sys.stdin.read())\n"
            "fn=schedule if data.get('scheduled_at') else publish\n"
            "args=(data['text'],data['scheduled_at'],data['media_paths']) if data.get('scheduled_at') else (data['text'],data['media_paths'],data.get('media_type','image'))\n"
            "r=fn(*args)\n"
            "print(json.dumps(r,ensure_ascii=False))\n"
        )

        proc = subprocess.run(
            [PYTHON_EXE, '-c', script],
            input=in_data, capture_output=True, text=True, timeout=120,
            cwd=WEIXIN_AUTO_DIR
        )

        if proc.returncode != 0:
            err = proc.stderr.strip() or '未知错误'
            return jsonify({"success": False, "error": f"子进程异常: {err}"})

        result = json.loads(proc.stdout.strip())
        return jsonify(result)

    except subprocess.TimeoutExpired:
        return jsonify({"success": False, "error": "朋友圈发布超时（120秒），请重试"})
    except json.JSONDecodeError:
        return jsonify({"success": False, "error": "子进程输出解析失败"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/moment/schedule', methods=['GET'])
def api_get_scheduled_moments():
    """查看定时朋友圈任务"""
    try:
        from wechat_moment_v2 import get_scheduled_moments
        return jsonify({"success": True, "tasks": get_scheduled_moments()})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/moment/schedule/<task_id>', methods=['DELETE'])
def api_cancel_moment(task_id):
    """取消定时朋友圈"""
    try:
        from wechat_moment_v2 import cancel_scheduled
        return jsonify(cancel_scheduled(task_id))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


# ── 朋友圈任务管理 ──────────────────

@app.route('/api/moment/tasks', methods=['GET'])
def api_list_moment_tasks():
    """列出所有朋友圈任务"""
    try:
        from wechat_moment_v2 import get_tasks
        status = request.args.get('status')
        return jsonify(get_tasks(status))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/moment/tasks/<task_id>', methods=['GET'])
def api_get_moment_task(task_id):
    """获取单个任务详情"""
    try:
        from wechat_moment_v2 import get_task
        return jsonify(get_task(task_id))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/moment/tasks/<task_id>/logs', methods=['GET'])
def api_get_moment_task_logs(task_id):
    """获取任务事件日志"""
    try:
        from wechat_moment_v2 import get_task_logs
        limit = request.args.get('limit', 100, type=int)
        return jsonify(get_task_logs(task_id, limit))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/moment/tasks/<task_id>/cancel', methods=['POST'])
def api_cancel_moment_task(task_id):
    """取消任务（支持 pending / running 状态）"""
    try:
        from wechat_moment_v2 import cancel_scheduled
        return jsonify(cancel_scheduled(task_id))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


# ============================================================
# 启动
# ============================================================

if __name__ == '__main__':
    print("=" * 50)
    print(f"  壹准AI营销助手 - 后端服务 v{APP_VERSION}")
    print(f"  http://localhost:{APP_PORT}")
    print(f"  channel: {APP_CHANNEL}")
    print("=" * 50)
    app.run(host='127.0.0.1', port=APP_PORT, debug=False)
