"""
壹准 AI 营销助手 - Flask 后端 API
端口 5679
"""

import sys
import os
import json
import time
import hashlib
import base64
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

# 确保能导入现有模块（开发 + PyInstaller 打包均兼容）
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 开发模式：wechat-wxauto 在项目父级
_DEV_WXAUTO = os.path.join(_BASE_DIR, '..', '..', 'wechat-wxauto')
# 打包模式：backend.exe 在 resources/backend/，wechat-wxauto 在 resources/wechat-wxauto/
_EXE_DIR = os.path.dirname(os.path.abspath(sys.executable))
_PKG_WXAUTO = os.path.join(_EXE_DIR, '..', 'wechat-wxauto')
for _p in [_DEV_WXAUTO, _PKG_WXAUTO]:
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)

app = Flask(__name__)
CORS(app)

# ============================================================
# 配置管理
# ============================================================

CONFIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(CONFIG_DIR, exist_ok=True)
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.json')
SCRIPTS_FILE = os.path.join(CONFIG_DIR, 'scripts.json')
UPLOAD_DIR = os.path.join(CONFIG_DIR, 'uploads')
OUTPUT_DIR = os.path.join(CONFIG_DIR, 'output')
# wechat-wxauto 的 output 目录（取第一个存在的）
_WXAUTO_DIR = _DEV_WXAUTO if os.path.isdir(_DEV_WXAUTO) else (_PKG_WXAUTO if os.path.isdir(_PKG_WXAUTO) else None)
_WXAUTO_OUTPUT = os.path.join(_WXAUTO_DIR, 'output') if _WXAUTO_DIR else OUTPUT_DIR
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
if os.path.isdir(_WXAUTO_DIR):
    os.makedirs(_WXAUTO_OUTPUT, exist_ok=True)

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
    "watermark": {
        "text": "壹准 \u00b7 生生广场4栋11号楼",
        "position": "bottom-right",
        "adaptive_color": True
    },
    "broadcast": {
        "interval": 0.8,
        "exclude": ["微信团队", "文件传输助手"]
    },
    "app": {
        "version": "1.0.1",
        "update_channel": "github"
    }
}

DEFAULT_SCRIPTS = [
    {"id": "s1", "tag": "以旧换新", "text": "旧机换新机，折旧抵扣！现在来壹准，旧手机最高抵{金额}元。地址：生生广场4栋11号楼整栋"},
    {"id": "s2", "tag": "新品推荐", "text": "最新款{型号}到货！{亮点}，价格实惠，来壹准看看吧，生生广场4栋11号楼"},
    {"id": "s3", "tag": "促销活动", "text": "限时优惠！{活动名}进行中，{优惠内容}，今天来壹准抢先体验，名额有限！"},
    {"id": "s4", "tag": "品牌宣传", "text": "壹准 — 生生广场专业手机回收、保卖、竞拍平台，诚信经营，欢迎来访！"},
]


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
        return jsonify({"success": True, "wx_online": status.get("online", False)})
    except Exception as e:
        return jsonify({"success": True, "wx_online": False, "error": str(e)})


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
# 消息发送
# ============================================================

@app.route('/api/send/text', methods=['POST'])
def api_send_text():
    data = request.json or {}
    try:
        from wxauto_service import send_text
        result = send_text(data['to'], data['message'])
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/send/image', methods=['POST'])
def api_send_image():
    data = request.json or {}
    try:
        from wxauto_service import send_image
        result = send_image(data['to'], data['image_path'])
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/send/text-image', methods=['POST'])
def api_send_text_image():
    data = request.json or {}
    try:
        from wxauto_service import send_text_and_image
        result = send_text_and_image(data['to'], data['message'], data['image_path'])
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


# ============================================================
# 群发
# ============================================================

@app.route('/api/broadcast', methods=['POST'])
def api_broadcast():
    """统一群发入口"""
    data = request.json or {}
    targets = data.get('targets', [])
    message = data.get('message', '')
    image_path = data.get('image_path')
    mode = data.get('mode', 'manual')  # manual | keyword | all
    keywords = data.get('keywords', [])
    exclude = data.get('exclude')
    interval = data.get('interval', 0.8)

    try:
        from wxauto_service import (
            broadcast_image, smart_broadcast_text_image, broadcast_all_text_image
        )

        if mode == 'all':
            result = broadcast_all_text_image(message, image_path, exclude)
        elif mode == 'keyword' and keywords:
            result = smart_broadcast_text_image(keywords, message, image_path)
        else:
            result = broadcast_image(targets, image_path, message)

        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


# ============================================================
# 图片处理
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


@app.route('/api/image/process', methods=['POST'])
def api_process_image():
    data = request.json or {}
    image_path = data.get('image_path')
    text_lines = data.get('text_lines')
    watermark = data.get('watermark')
    position = data.get('position', 'bottom-right')
    enhance = data.get('enhance', False)
    brightness = data.get('brightness', 1.1)
    contrast = data.get('contrast', 1.15)
    saturation = data.get('saturation', 1.2)

    try:
        from image_enhancer import process_image, enhance_image, apply_watermark, render_text_card

        output_name = f"processed_{int(time.time())}.png"
        result = process_image(
            image_path, output_name,
            text_lines=text_lines,
            watermark=watermark,
            enhance=enhance,
            position=position
        )
        # 把输出复制到 OUTPUT_DIR 以便 /api/image/output/ 访问
        if result.get("success") and result.get("output"):
            src = result["output"]
            dst = os.path.join(OUTPUT_DIR, output_name)
            if os.path.exists(src) and src != dst:
                import shutil
                shutil.copy2(src, dst)
                result["output"] = dst
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/image/output/<filename>', methods=['GET'])
def api_get_image(filename):
    # 优先查找 OUTPUT_DIR
    filepath = os.path.join(OUTPUT_DIR, filename)
    if os.path.exists(filepath):
        return send_file(filepath, mimetype='image/png')
    # 也检查 wechat-wxauto output
    for d in [os.path.join(_WXAUTO_DIR, 'output') if os.path.isdir(_WXAUTO_DIR) else '',
              os.path.join(_DEV_WXAUTO, 'output') if os.path.isdir(_DEV_WXAUTO) else '']:
        if d:
            alt = os.path.join(d, filename)
            if os.path.exists(alt):
                return send_file(alt, mimetype='image/png')
    return jsonify({"success": False, "error": "File not found"}), 404


# ============================================================
# AI 文案生成
# ============================================================

@app.route('/api/copy/generate', methods=['POST'])
def api_generate_copy():
    data = request.json or {}
    context = data.get('context', '')
    style = data.get('style', '朋友圈')

    config = load_config()

    # 如果启用了 AI API，尝试调用
    if config['ai']['enabled'] and config['ai']['api_key']:
        ai_result = _call_ai_api(config['ai'], context, style)
        if ai_result:
            return jsonify({"success": True, "copy": ai_result, "source": "ai"})

    # 降级：使用话术库
    if config['fallback']['use_scripts']:
        scripts = load_scripts()
        matched = _match_scripts(context, scripts)
        if matched:
            return jsonify({"success": True, "copy": matched, "source": "scripts"})

    # 最终降级：本地智能生成
    try:
        from ai_copywriter import smart_generate
        copy = smart_generate(context, style)
        return jsonify({"success": True, "copy": copy, "source": "local"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


def _match_scripts(context, scripts):
    """从话术库匹配最相关的文案"""
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

    # 找匹配标签的话术
    for s in scripts:
        if s['tag'] == best_tag:
            return s['text']

    # fallback: 返回第一条
    if scripts:
        return scripts[0]['text']
    return None


def _call_ai_api(ai_config, context, style):
    """调用 OpenAI 兼容 API"""
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
                {"role": "system", "content": f"你是壹准二手手机店的营销文案助手。门店地址：生生广场4栋11号楼整栋。生成{style_guide.get(style, style_guide['朋友圈'])}"},
                {"role": "user", "content": f"根据以下内容生成一段微信群发营销文案：{context}"}
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
    # 密文显示 API Key
    if config['ai'].get('api_key'):
        config['ai']['api_key_masked'] = mask_key(config['ai']['api_key'])
    return jsonify({"success": True, "config": config})


@app.route('/api/config', methods=['PUT'])
def api_update_config():
    data = request.json or {}
    config = load_config()

    for section in ['ai', 'fallback', 'watermark', 'broadcast', 'app']:
        if section in data:
            config[section].update(data[section])

    save_config(config)
    return jsonify({"success": True, "config": config})


# ============================================================
# 更新检查
# ============================================================

@app.route('/api/update/check', methods=['GET'])
def api_check_update():
    """检查 GitHub Release 是否有新版本"""
    config = load_config()
    current_ver = config['app'].get('version', '1.0.0')

    try:
        import urllib.request
        url = "https://api.github.com/repos/LEONLEE250/yizhun-wechat-bot/releases/latest"
        req = urllib.request.Request(url, headers={"User-Agent": "YizhunApp/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            release = json.loads(resp.read().decode('utf-8'))
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
        return jsonify({"success": True, "has_update": False, "error": str(e), "current": current_ver})


def _compare_versions(v1, v2):
    try:
        parts1 = [int(x) for x in v1.split('.')]
        parts2 = [int(x) for x in v2.split('.')]
        for a, b in zip(parts1, parts2):
            if a > b: return 1
            if a < b: return -1
        return len(parts1) - len(parts2)
    except Exception:
        return 0


# ============================================================
# 健康检查
# ============================================================

@app.route('/api/health', methods=['GET'])
def api_health():
    return jsonify({"status": "ok", "version": "1.0.1"})


# ============================================================
# 启动
# ============================================================

if __name__ == '__main__':
    print("=" * 50)
    print("  壹准 AI 营销助手 - 后端服务")
    print("  http://localhost:5679")
    print("=" * 50)
    app.run(host='127.0.0.1', port=5679, debug=False)
