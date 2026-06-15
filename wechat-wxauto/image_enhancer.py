"""
图片美化与水印模块
- 自适应底色水印：分析水印区域的底色，自动选择对比度最高的颜色
- 图片美化：亮度/对比度/饱和度调整、锐化、滤镜
- 文案渲染：在图片上渲染多行文案（产品信息、价格等）
"""

import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance


# ============================================================
# 字体加载
# ============================================================

FONT_PATHS = [
    "C:/Windows/Fonts/msyh.ttc",      # 微软雅黑
    "C:/Windows/Fonts/msyhbd.ttc",    # 微软雅黑粗体
    "C:/Windows/Fonts/simhei.ttf",    # 黑体
    "C:/Windows/Fonts/simsun.ttc",    # 宋体
]

def load_font(size=36):
    """加载中文字体，按优先级尝试"""
    for fp in FONT_PATHS:
        if os.path.exists(fp):
            return ImageFont.truetype(fp, size=size)
    return ImageFont.load_default()


# ============================================================
# 底色分析 — 核心：自适应水印颜色
# ============================================================

def get_region_color(img, x, y, w, h):
    """获取图片指定区域的平均颜色"""
    region = img.crop((x, y, x + w, y + h))
    arr = np.array(region)
    # 取平均
    avg = arr.mean(axis=(0, 1))
    return tuple(int(v) for v in avg[:3])  # (R, G, B)


def luminance(r, g, b):
    """计算亮度 (0-255)，人眼感知加权"""
    return 0.299 * r + 0.587 * g + 0.114 * b


def best_contrast_color(bg_color):
    """
    根据底色计算最佳对比色
    策略：
    - 底色亮 → 深色文字 + 浅色半透明底框
    - 底色暗 → 亮色文字 + 深色半透明底框
    - 底色中等 → 进一步判断，选对比度更大的
    """
    r, g, b = bg_color
    lum = luminance(r, g, b)

    if lum > 160:
        # 亮底色：深色文字
        return {
            "text": (30, 30, 30, 255),       # 深灰文字
            "bg": (255, 255, 255, 160),      # 白色半透明底框
            "stroke": (255, 255, 255, 120),  # 描边（可选）
        }
    elif lum < 80:
        # 暗底色：亮色文字
        return {
            "text": (255, 255, 255, 255),    # 白色文字
            "bg": (0, 0, 0, 160),            # 黑色半透明底框
            "stroke": (0, 0, 0, 100),
        }
    else:
        # 中等亮度：比较与黑白哪个对比度更大
        contrast_white = abs(lum - 255)
        contrast_black = abs(lum - 0)
        if contrast_white > contrast_black:
            return {
                "text": (255, 255, 255, 255),
                "bg": (0, 0, 0, 160),
                "stroke": (0, 0, 0, 100),
            }
        else:
            return {
                "text": (30, 30, 30, 255),
                "bg": (255, 255, 255, 160),
                "stroke": (255, 255, 255, 120),
            }


# ============================================================
# 水印 — 多位置 + 自适应颜色
# ============================================================

WATERMARK_POSITIONS = {
    "bottom-right": "右下角",
    "bottom-left": "左下角",
    "top-right": "右上角",
    "top-left": "左上角",
    "center": "居中平铺",
    "diagonal": "对角线平铺",
}


def apply_watermark(image_path, output_path, watermark_text,
                    position="bottom-right", font_size_ratio=0.06):
    """
    给图片添加自适应颜色水印

    参数:
        image_path: 原图路径
        output_path: 输出路径
        watermark_text: 水印文字
        position: 位置（见 WATERMARK_POSITIONS）
        font_size_ratio: 字体大小相对于图片短边的比例
    """
    img = Image.open(image_path).convert("RGBA")
    w, h = img.size
    short_side = min(w, h)

    font_size = max(16, int(short_side * font_size_ratio))
    font = load_font(font_size)

    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    bbox = draw.textbbox((0, 0), watermark_text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    padding = 10

    margin = 20  # 边距

    # 计算水印位置
    if position == "bottom-right":
        x = w - tw - margin
        y = h - th - margin
    elif position == "bottom-left":
        x = margin
        y = h - th - margin
    elif position == "top-right":
        x = w - tw - margin
        y = margin
    elif position == "top-left":
        x = margin
        y = margin
    elif position in ("center", "diagonal"):
        # 平铺模式
        spacing_x = tw + 80
        spacing_y = th + 60
        for row_y in range(0, h + spacing_y, spacing_y):
            for col_x in range(0, w + spacing_x, spacing_x):
                if position == "diagonal":
                    offset = (row_y // spacing_y) * (spacing_x // 3)
                    col_x = (col_x + offset) % (w + spacing_x)
                # 每个水印实例根据所在区域底色自适应
                rx = min(max(col_x, 0), w - tw - padding)
                ry = min(max(row_y, 0), h - th - padding)
                _draw_watermark_instance(draw, font, watermark_text, rx, ry, tw, th, padding, img)
        # 平铺模式直接合成返回
        result = Image.alpha_composite(img, overlay)
        result.convert("RGB").save(output_path, quality=95)
        return output_path
    else:
        x = w - tw - margin
        y = h - th - margin

    # 单实例水印
    _draw_watermark_instance(draw, font, watermark_text, x, y, tw, th, padding, img)

    result = Image.alpha_composite(img, overlay)
    result.convert("RGB").save(output_path, quality=95)
    return output_path


def _draw_watermark_instance(draw, font, text, x, y, tw, th, padding, img):
    """绘制单个水印实例（自适应颜色）"""
    # 分析水印区域底色
    rx = max(0, x - padding)
    ry = max(0, y - padding)
    rw = min(tw + 2 * padding, img.width - rx)
    rh = min(th + 2 * padding, img.height - ry)

    bg_color = get_region_color(img, rx, ry, rw, rh)
    colors = best_contrast_color(bg_color)

    # 半透明底框
    draw.rectangle(
        [x - padding, y - padding, x + tw + padding, y + th + padding],
        fill=colors["bg"],
        outline=None
    )
    # 文字
    draw.text((x, y), text, font=font, fill=colors["text"])


# ============================================================
# 图片美化
# ============================================================

def enhance_image(image_path, output_path,
                  brightness=1.1, contrast=1.15, saturation=1.2,
                  sharpness=1.3, blur_radius=0, auto_white_balance=False):
    """
    图片美化

    参数:
        brightness: 亮度系数 (0.0-2.0, 1.0=原值)
        contrast: 对比度系数
        saturation: 饱和度系数
        sharpness: 锐度系数
        blur_radius: 模糊半径 (0=不模糊)
        auto_white_balance: 自动白平衡
    """
    img = Image.open(image_path).convert("RGB")

    if auto_white_balance:
        img = _auto_white_balance(img)

    if brightness != 1.0:
        img = ImageEnhance.Brightness(img).enhance(brightness)
    if contrast != 1.0:
        img = ImageEnhance.Contrast(img).enhance(contrast)
    if saturation != 1.0:
        img = ImageEnhance.Color(img).enhance(saturation)
    if sharpness != 1.0:
        img = ImageEnhance.Sharpness(img).enhance(sharpness)
    if blur_radius > 0:
        img = img.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    img.save(output_path, quality=95)
    return output_path


def _auto_white_balance(img):
    """简易自动白平衡：假设最亮区域是白色"""
    arr = np.array(img, dtype=np.float32)
    # 取每个通道的 99 分位数作为白点
    r_max = np.percentile(arr[:, :, 0], 99)
    g_max = np.percentile(arr[:, :, 1], 99)
    b_max = np.percentile(arr[:, :, 2], 99)
    avg_max = (r_max + g_max + b_max) / 3

    if avg_max > 0:
        arr[:, :, 0] = np.clip(arr[:, :, 0] * (avg_max / max(r_max, 1)), 0, 255)
        arr[:, :, 1] = np.clip(arr[:, :, 1] * (avg_max / max(g_max, 1)), 0, 255)
        arr[:, :, 2] = np.clip(arr[:, :, 2] * (avg_max / max(b_max, 1)), 0, 255)

    return Image.fromarray(arr.astype(np.uint8))


# ============================================================
# 文案渲染 — 产品信息卡片
# ============================================================

def render_text_card(image_path, output_path, text_lines,
                     position="bottom", font_size_ratio=0.05,
                     card_style="gradient"):
    """
    在图片上渲染文案卡片

    参数:
        text_lines: ["iPhone 15 Pro", "国行 256GB", "¥7999"]
        position: "bottom" / "top"
        card_style: "gradient" / "solid"
    """
    img = Image.open(image_path).convert("RGBA")
    w, h = img.size
    short_side = min(w, h)
    font_size = max(18, int(short_side * font_size_ratio))
    font = load_font(font_size)

    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    line_height = font_size + 12
    card_height = len(text_lines) * line_height + 40
    card_margin = 20

    # 分析卡片区域的底色
    if position == "bottom":
        card_y = h - card_height - 10
    else:
        card_y = 10

    # 检测底色
    bg_color = get_region_color(img, 0, card_y, w, card_height)
    colors = best_contrast_color(bg_color)

    # 卡片背景
    if card_style == "gradient":
        # 渐变：从半透明到更透明
        for i in range(card_height):
            alpha = int(180 - (i / card_height) * 60)
            draw.line(
                [(0, card_y + i), (w, card_y + i)],
                fill=(0, 0, 0, alpha)
            )
    else:
        draw.rectangle(
            [0, card_y, w, card_y + card_height],
            fill=colors["bg"]
        )

    # 渲染文字行
    text_y = card_y + 20
    for line in text_lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        tw = bbox[2] - bbox[0]
        tx = (w - tw) // 2
        draw.text((tx, text_y), line, font=font, fill=colors["text"])
        text_y += line_height

    result = Image.alpha_composite(img, overlay)
    result.convert("RGB").save(output_path, quality=95)
    return output_path


# ============================================================
# 一键处理：美化 + 文案 + 水印
# ============================================================

def process_image(image_path, output_name,
                  text_lines=None, watermark=None,
                  enhance=False, position="bottom-right",
                  brightness=1.1, contrast=1.15, saturation=1.2):
    """
    一键处理图片：美化 + 文案 + 水印

    返回: {"success": True, "output": path} 或 {"success": False, "error": msg}
    """
    try:
        output_dir = os.path.dirname(os.path.abspath(__file__))
        output_dir = os.path.join(output_dir, "output")
        os.makedirs(output_dir, exist_ok=True)

        temp_path = os.path.join(output_dir, f"_temp_{output_name}")
        final_path = os.path.join(output_dir, output_name)

        current = image_path

        # 步骤1: 美化
        if enhance:
            enhance_image(current, temp_path,
                          brightness=brightness, contrast=contrast, saturation=saturation)
            current = temp_path

        # 步骤2: 文案卡片
        if text_lines:
            card_temp = os.path.join(output_dir, f"_card_{output_name}")
            render_text_card(current, card_temp, text_lines)
            current = card_temp

        # 步骤3: 水印
        if watermark:
            apply_watermark(current, final_path, watermark, position=position)
        else:
            # 直接复制到最终路径
            Image.open(current).save(final_path, quality=95)

        # 清理临时文件
        for f in [temp_path, os.path.join(output_dir, f"_card_{output_name}")]:
            if os.path.exists(f) and f != final_path:
                os.remove(f)

        return {"success": True, "output": final_path}

    except Exception as e:
        return {"success": False, "error": str(e)}


# ============================================================
# 命令行测试
# ============================================================

if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1:
        action = sys.argv[1]
        image_path = sys.argv[2]

        if action == "watermark":
            output = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "output", "watermark_test.png"
            )
            apply_watermark(image_path, output, "壹准", position="diagonal")
            print(f"水印完成: {output}")

        elif action == "enhance":
            output = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "output", "enhanced_test.png"
            )
            enhance_image(image_path, output)
            print(f"美化完成: {output}")

        elif action == "card":
            output = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "output", "card_test.png"
            )
            render_text_card(image_path, output, ["iPhone 15 Pro", "国行 256GB 黑色", "¥7999"])
            print(f"文案完成: {output}")

        elif action == "all":
            output = process_image(
                image_path, "final_test.png",
                text_lines=["iPhone 15 Pro", "¥7999"],
                watermark="壹准",
                enhance=True
            )
            print(output)
    else:
        print("用法:")
        print("  python image_enhancer.py watermark <图片路径>")
        print("  python image_enhancer.py enhance <图片路径>")
        print("  python image_enhancer.py card <图片路径>")
        print("  python image_enhancer.py all <图片路径>")
