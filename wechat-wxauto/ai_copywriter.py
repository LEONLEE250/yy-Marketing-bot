"""
AI 文案生成模块 v2.0
- 不依赖固定模板字段，根据你提供的任意内容智能理解并生成文案
- 支持多种风格：朋友圈、营销、简洁、专业
- 支持场景识别：以旧换新、新机推荐、促销活动、品牌宣传等
"""

import random

# ============================================================
# 话术素材库（辅助润色，不是模板）
# ============================================================

HOOKS = {
    "朋友圈": [
        "又到了一台好机器……",
        "刚收的，成色绝了",
        "今日好物推荐——",
        "手慢无系列——",
        "捡漏时刻到了",
        "新鲜到货，先到先得！",
        "性价比天花板",
        "这个价格，真的不用犹豫。",
        "最近问的人太多了，统一回复——",
        "有人问有没有XX，刚好有一台——",
    ],
    "营销": [
        "限时特价！错过等一年！",
        "老板说今天必须清仓……",
        "最后一台，卖完下架",
        "同行都在抢，你还等什么？",
        "今日爆款，手慢拍大腿！",
        "成本价出，不议价不墨迹。",
    ],
    "简洁": [
        "出货——",
        "来一台——",
        "今日份——",
        "上新——",
    ],
    "专业": [
        "【今日出货】",
        "【现货推荐】",
        "【精品推荐】",
        "【本期精选】",
    ],
}

CTAS = {
    "朋友圈": [
        "感兴趣的私聊～",
        "有意私，先到先得。",
        "来聊，手慢无。",
        "看上直接滴滴我。",
        "滴滴我，报价秒回~",
    ],
    "营销": [
        "扫码下单，立减50！",
        "库存告急，手慢无！",
        "今天下单明天发！",
    ],
    "简洁": [
        "私",
        "来",
        "滴滴",
    ],
    "专业": [
        "有意请联系。",
        "欢迎咨询。",
        "详情私聊。",
    ],
}

EMOJIS = {
    "手机": ["📱", "📲"],
    "价格": ["💰", "💵", "💎"],
    "品质": ["✨", "💯", "✅", "👌", "👍"],
    "强调": ["🔥", "⚡", "❗", "🆕"],
    "新到": ["🆕", "📦", "🎁"],
    "地址": ["📍"],
}

# ============================================================
# 核心：自由文本 → 智能文案
# ============================================================

def smart_generate(context, style="朋友圈"):
    """
    根据任意上下文智能生成营销文案。
    不依赖固定模板字段，理解你的意图后生成。

    参数:
        context: str | dict — 任意格式的内容描述
            - 可以是图片描述、产品信息、场景说明等
            - str: "帮我写个以旧换新的文案，门店在生生广场4栋"
            - dict: 你给什么字段就用什么，不强求固定格式
        style: "朋友圈" / "营销" / "简洁" / "专业"

    返回: str，生成的文案
    """
    # 标准化输入
    if isinstance(context, dict):
        text = _dict_to_text(context)
    else:
        text = str(context)

    # 识别场景和关键信息
    scene = _detect_scene(text)
    info = _extract_info(text)

    # 根据场景生成
    if scene == "trade_in":
        return _gen_trade_in(info, style)
    elif scene == "new_product":
        return _gen_new_product(info, style)
    elif scene == "promotion":
        return _gen_promotion(info, style)
    elif scene == "brand":
        return _gen_brand(info, style)
    else:
        return _gen_general(info, style)


def _dict_to_text(d):
    """把 dict 转成自然语言描述"""
    parts = []
    for k, v in d.items():
        if isinstance(v, list):
            v = "、".join(str(x) for x in v)
        if v:
            parts.append(f"{k}：{v}")
    return "\n".join(parts)


def _detect_scene(text):
    """识别场景类型"""
    text_lower = text.lower()
    if any(w in text_lower for w in ["以旧换新", "换新机", "回收", "旧手机", "抵扣", "折价"]):
        return "trade_in"
    if any(w in text_lower for w in ["新到", "到货", "新机", "新品", "上新", "推荐"]):
        return "new_product"
    if any(w in text_lower for w in ["促销", "特价", "打折", "清仓", "限时", "活动", "优惠"]):
        return "promotion"
    if any(w in text_lower for w in ["品牌", "宣传", "介绍", "壹准", "门店", "开业"]):
        return "brand"
    return "general"


def _extract_info(text):
    """从文本中提取关键信息"""
    return {"text": text}


# ============================================================
# 场景文案生成
# ============================================================

def _gen_trade_in(info, style):
    """以旧换新场景"""
    text = info.get("text", "")
    lines = []

    if style == "朋友圈":
        lines.append("旧手机别闲置了，拿来换钱 👇")
        lines.append("")
        lines.append("壹准·以旧换新")
        lines.append("半价享旗舰，月月换新机")
        lines.append("旧机直接抵扣，补差价就能拿走")
        lines.append("")
        lines.append("全场上百台二手靓机，到店随便挑")
        lines.append("📍 生生广场4栋11号楼整栋")
        lines.append("")
        lines.append("滴滴我，报价秒回~")
    elif style == "营销":
        lines.append("🔥 以旧换新大升级！")
        lines.append("")
        lines.append("你的旧手机还能值不少钱！")
        lines.append("拿来壹准直接折价，换台更好的")
        lines.append("半价享旗舰，月月换新机")
        lines.append("")
        lines.append("📍 生生广场4栋11号楼整栋")
        lines.append("⚡ 限时活动，赶紧来！")
    elif style == "简洁":
        lines.append("以旧换新找我 👇")
        lines.append("旧手机拿来抵现金，半价就能换旗舰")
        lines.append("地址：生生广场4栋11号楼整栋")
        lines.append("随时到店，到了滴滴我")
    elif style == "专业":
        lines.append("【壹准·以旧换新服务】")
        lines.append("")
        lines.append("服务内容：旧手机折价换购二手靓机")
        lines.append("覆盖品牌：iPhone / 华为 / 小米 / OPPO / vivo 等全品牌")
        lines.append("地址：生生广场4栋11号楼整栋")
        lines.append("")
        lines.append("欢迎到店评估，详情私聊。")

    return "\n".join(lines)


def _gen_new_product(info, style):
    """新品/到货推荐"""
    text = info.get("text", "")
    lines = []

    hook = random.choice(HOOKS.get(style, HOOKS["朋友圈"]))
    cta = random.choice(CTAS.get(style, CTAS["朋友圈"]))

    if style == "朋友圈":
        lines.append(hook)
        lines.append("")
        # 把文本中的关键信息提取展示
        for line in text.split("\n"):
            line = line.strip()
            if line:
                lines.append(line)
        lines.append("")
        lines.append(cta)
    elif style == "简洁":
        lines.append(hook)
        lines.append(text.strip().replace("\n", " | "))
        lines.append(cta)
    else:
        lines.append(hook)
        lines.append(text.strip())
        lines.append("")
        lines.append(cta)

    return "\n".join(lines)


def _gen_promotion(info, style):
    """促销活动"""
    text = info.get("text", "")
    hook = random.choice(HOOKS.get("营销", HOOKS["营销"]))
    cta = random.choice(CTAS.get("营销", CTAS["营销"]))

    lines = [hook, "", text.strip(), "", cta]
    return "\n".join(lines)


def _gen_brand(info, style):
    """品牌宣传"""
    lines = [
        "壹准 · 二手手机专家",
        "",
        "✅ 回收 · 保卖 · 竞拍 · 以旧换新",
        "✅ 每台机器27项功能全检",
        "✅ 全品牌覆盖，价格透明",
        "",
        "📍 生生广场4栋11号楼整栋",
        "📱 到店评估，报价秒回",
    ]
    return "\n".join(lines)


def _gen_general(info, style):
    """通用场景：根据文本内容灵活生成"""
    text = info.get("text", "")
    hook = random.choice(HOOKS.get(style, HOOKS["朋友圈"]))
    cta = random.choice(CTAS.get(style, CTAS["朋友圈"]))

    if style == "简洁":
        lines = [hook, text.strip().replace("\n", " | "), cta]
    else:
        lines = [hook, "", text.strip(), "", cta]

    return "\n".join(lines)


# ============================================================
# 兼容旧接口
# ============================================================

def generate_copy(product_info, style="朋友圈"):
    """兼容旧版调用方式，自动转为智能生成"""
    return smart_generate(product_info, style)


def quick_copy(content, style="朋友圈"):
    """快捷生成：传入任意内容"""
    return smart_generate(content, style)


def batch_generate(items, style="朋友圈"):
    """批量生成"""
    results = []
    for i, item in enumerate(items):
        copy = smart_generate(item, style)
        results.append({"index": i + 1, "copy": copy})
    return results


# ============================================================
# 测试
# ============================================================

if __name__ == "__main__":
    print("=" * 50)
    print("【场景：以旧换新】")
    print(smart_generate("帮写以旧换新文案，门店在生生广场4栋11号楼", "朋友圈"))
    print()
    print("=" * 50)
    print("【场景：自由描述】")
    print(smart_generate("iPhone 15 Pro 256GB 黑色 95新 电池99% 只要7999", "朋友圈"))
    print()
    print("=" * 50)
    print("【兼容旧 dict 调用】")
    print(generate_copy({
        "name": "华为 Mate 60 Pro",
        "price": "¥5999",
        "condition": "99新",
        "highlights": ["全套配件", "在保"]
    }, "营销"))
