# -*- coding: utf-8 -*-
"""
dsh-workbuddy-account-care 行为流程图生成器。

为什么生成而不是手画：图中每个判断都能在源码里指到行号，改代码之后重跑一遍
就得到一致的新图，不会再出现「图上一个样、代码另一个样」。

用法（Windows，用 DSH 自带 python）：
    python docs/diagrams/draw_flow.py
输出：
    docs/diagrams/flow-overview.png   主流程：探测 → 发布 → 门控 → 动作
    docs/diagrams/flow-buttons.png    按钮组合决策树（含三种退化）
    docs/diagrams/flow-defect.png     「后台还在跑却只给 关闭插件/知道了」的代码级路径
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))

FONT_CJK = r"C:\Windows\Fonts\msyh.ttc"
FONT_CJK_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_MONO = r"C:\Windows\Fonts\consola.ttf"

BG = "#FFFFFF"
INK = "#0F172A"
INK_2 = "#475569"
INK_3 = "#64748B"
ARROW = "#94A3B8"
CODE_BG = "#0F172A"
CODE_INK = "#E2E8F0"

BLUE = "#2563EB"
VIOLET = "#7C3AED"
TEAL = "#0E7490"
ROSE = "#BE123C"
AMBER = "#B45309"
GRAY = "#94A3B8"

BAND = {
    "blue": ("#F4F8FF", "#DCE7FB"),
    "violet": ("#F8F5FF", "#E7DDFB"),
    "teal": ("#F2FBFC", "#CFEDF2"),
    "rose": ("#FFF6F8", "#F8D9E1"),
}

LH = 1.42


class Canvas:
    """逻辑坐标系（宽 W 高 H），实际按 S 倍超采样落盘。"""

    def __init__(self, w: int, h: int, scale: int = 2):
        self.W, self.H, self.S = w, h, scale
        self.img = Image.new("RGB", (int(w * scale), int(h * scale)), BG)
        self.d = ImageDraw.Draw(self.img)
        self._fonts: dict[tuple, ImageFont.FreeTypeFont] = {}

    # ---------------- 文本 ----------------
    def font(self, size: int, bold: bool = False, mono: bool = False):
        key = (size, bold, mono)
        if key not in self._fonts:
            if mono:
                path = FONT_MONO if os.path.exists(FONT_MONO) else FONT_CJK
                bold = False
            else:
                path = FONT_CJK_BOLD if bold else FONT_CJK
            self._fonts[key] = ImageFont.truetype(path, int(size * self.S))
        return self._fonts[key]

    def wrap(self, content, f, maxw):
        if maxw is None:
            return str(content).split("\n")
        out: list[str] = []
        for para in str(content).split("\n"):
            if para == "":
                out.append("")
                continue
            line = ""
            for ch in para:
                if line == "" or self.d.textlength(line + ch, font=f) / self.S <= maxw:
                    line += ch
                else:
                    out.append(line)
                    line = ch
            out.append(line)
        return out

    def text(self, xy, content, size=16, bold=False, fill=INK, anchor="la", mono=False, maxw=None):
        f = self.font(size, bold, mono)
        x, y = xy
        for i, line in enumerate(self.wrap(content, f, maxw)):
            self.d.text((x * self.S, (y + i * size * LH) * self.S), line, font=f, fill=fill, anchor=anchor)
        return len(self.wrap(content, f, maxw))

    def height(self, content, size, bold=False, maxw=None, mono=False):
        return len(self.wrap(content, self.font(size, bold, mono), maxw)) * size * LH

    # ---------------- 图元 ----------------
    def rbox(self, x, y, w, h, r=12, fill="#FFFFFF", outline=INK_3, width=2, dash=False):
        s = self.S
        box = [x * s, y * s, (x + w) * s, (y + h) * s]
        self.d.rounded_rectangle(box, radius=r * s, fill=fill)
        if width <= 0:
            return
        if not dash:
            self.d.rounded_rectangle(box, radius=r * s, outline=outline, width=int(width * s))
            return
        seg, gap = 7, 5

        def dline(p1, p2):
            (x1, y1), (x2, y2) = p1, p2
            length = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
            if length == 0:
                return
            ux, uy = (x2 - x1) / length, (y2 - y1) / length
            t = 0.0
            while t < length:
                e = min(t + seg, length)
                self.d.line([(x1 + ux * t) * s, (y1 + uy * t) * s, (x1 + ux * e) * s, (y1 + uy * e) * s],
                            fill=outline, width=int(width * s))
                t = e + gap

        dline((x + r, y), (x + w - r, y))
        dline((x + r, y + h), (x + w - r, y + h))
        dline((x, y + r), (x, y + h - r))
        dline((x + w, y + r), (x + w, y + h - r))
        for cx, cy, a0 in ((x + r, y + r, 180), (x + w - r, y + r, 270),
                           (x + w - r, y + h - r, 0), (x + r, y + h - r, 90)):
            self.d.arc([(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s],
                       start=a0, end=a0 + 90, fill=outline, width=int(width * s))

    def node(self, x, y, w, title, body=None, accent=BLUE, tag=None,
             title_size=17, body_size=14, min_h=0):
        """自动测高的流程框，返回 (rect, bottom_y)。"""
        pad = 18
        inner = w - 2 * pad
        h = 12 + 10
        if tag:
            h += self.height(tag, 12, True, inner) + 2
        h += self.height(title, title_size, True, inner) + 4
        if body:
            h += self.height(body, body_size, False, inner)
        h += 12
        h = max(h, min_h)
        self.rbox(x, y, w, h, r=12, fill="#FFFFFF", outline=accent, width=2)
        self.d.rounded_rectangle([x * self.S, y * self.S, (x + 4) * self.S, (y + h) * self.S],
                                 radius=2 * self.S, fill=accent)
        ty = y + 12
        if tag:
            ty += self.text((x + pad, ty), tag, 12, True, accent, maxw=inner) * 12 * LH + 2
        ty += self.text((x + pad, ty), title, title_size, True, INK, maxw=inner) * title_size * LH + 4
        if body:
            self.text((x + pad, ty), body, body_size, False, INK_2, maxw=inner)
        return (x, y, w, h), y + h

    def diamond(self, cx, cy, hw, hh, label, sub=None):
        s = self.S
        self.d.polygon([(cx * s, (cy - hh) * s), ((cx + hw) * s, cy * s),
                        (cx * s, (cy + hh) * s), ((cx - hw) * s, cy * s)],
                       fill="#FFFBEB", outline=AMBER, width=int(2 * s))
        self.text((cx, cy - (19 if sub else 8)), label, 15, True, "#7C2D12", anchor="ma", maxw=hw * 1.55)
        if sub:
            self.text((cx, cy + 4), sub, 12, False, "#92400E", anchor="ma", maxw=hw * 1.5)

    def arrow(self, pts, label=None, color=ARROW, width=2, dash=False):
        s = self.S
        flat = list(pts)
        if flat and not isinstance(flat[0], (tuple, list)):
            flat = [(flat[i], flat[i + 1]) for i in range(0, len(flat) - 1, 2)]
        pts = flat
        assert len(pts) >= 2, pts
        if dash:
            for a, b in zip(pts, pts[1:]):
                self._dashed(a, b, color, width)
        else:
            self.d.line([(x * s, y * s) for x, y in pts], fill=color, width=int(width * s), joint="curve")
        (x1, y1), (x2, y2) = pts[-2], pts[-1]
        dx, dy = x2 - x1, y2 - y1
        n = max((dx ** 2 + dy ** 2) ** 0.5, 1e-6)
        ux, uy = dx / n, dy / n
        L, Wd = 9.5, 4.6
        bx, by = x2 - ux * L, y2 - uy * L
        self.d.polygon([(x2 * s, y2 * s),
                        ((bx - uy * Wd) * s, (by + ux * Wd) * s),
                        ((bx + uy * Wd) * s, (by - ux * Wd) * s)], fill=color)
        if label:
            (ax, ay), (bx2, by2) = pts[0], pts[1]
            if abs(ax - bx2) < 1:
                self.text((ax + 9, (ay + by2) / 2 - 9), label, 13, True, INK_2, maxw=230)
            else:
                self.text(((ax + bx2) / 2, ay - 26), label, 13, True, INK_2, anchor="ma", maxw=230)

    def _dashed(self, a, b, color, width):
        s = self.S
        (x1, y1), (x2, y2) = a, b
        length = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
        if length == 0:
            return
        ux, uy = (x2 - x1) / length, (y2 - y1) / length
        t, seg, gap = 0.0, 7, 5
        while t < length:
            e = min(t + seg, length)
            self.d.line([(x1 + ux * t) * s, (y1 + uy * t) * s, (x1 + ux * e) * s, (y1 + uy * e) * s],
                        fill=color, width=int(width * s))
            t = e + gap

    def band(self, x, y, w, h, tab, accent, tone):
        fill, stroke = BAND[tone]
        self.d.rounded_rectangle([x * self.S, y * self.S, (x + w) * self.S, (y + h) * self.S],
                                 radius=18 * self.S, fill=fill, outline=stroke, width=2 * self.S)
        tw = self.d.textlength(tab, font=self.font(19, True)) / self.S
        self.d.rounded_rectangle([(x + 18) * self.S, (y + 14) * self.S,
                                  (x + 18 + tw + 28) * self.S, (y + 48) * self.S],
                                 radius=8 * self.S, fill=accent)
        self.text((x + 32, y + 20), tab, 19, True, "#FFFFFF")

    def note(self, x, y, w, title, body, accent=INK_3, fill="#FFFFFF", body_size=13, min_h=0):
        pad = 16
        inner = w - 2 * pad
        h = 12 + 10
        if title:
            h += self.height(title, 14, True, inner) + 4
        if body:
            h += self.height(body, body_size, False, inner)
        h += 12
        h = max(h, min_h)
        self.rbox(x, y, w, h, r=10, fill=fill, outline=accent, width=1, dash=True)
        ty = y + 12
        if title:
            ty += self.text((x + pad, ty), title, 14, True, accent, maxw=inner) * 14 * LH + 4
        if body:
            self.text((x + pad, ty), body, body_size, False, INK_2, maxw=inner)
        return (x, y, w, h), y + h

    def code(self, x, y, w, lines, size=10):
        h = 16 + len(lines) * size * 1.55
        self.rbox(x, y, w, h, r=8, fill=CODE_BG, outline=CODE_BG, width=0)
        for i, line in enumerate(lines):
            self.text((x + 12, y + 8 + i * size * 1.55), line, size, False, CODE_INK, mono=True)
        return y + h

    def save(self, name):
        path = os.path.join(HERE, name)
        # 这些图都是纯色块 + 抗锯齿文字，256 色量化后肉眼看不出差别，
        # 体积却降到 1/3 —— 图要随 npm 包发布，别让它把包撑到 MB 级。
        out = self.img.quantize(colors=256, method=Image.Quantize.MEDIANCUT,
                                dither=Image.Dither.NONE)
        out.save(path, optimize=True)
        print("wrote", os.path.basename(path), self.img.size)


# =====================================================================================
# 图 1：主流程
# =====================================================================================
def draw_overview_full():
    """真正落盘的一版：先量高，再按量到的高度画底板。"""
    W = 1480
    CX, CW = 180, 500
    SX, SW = 760, 470
    AX = CX + CW // 2

    measure = Canvas(W, 10, scale=1)

    # ---- 逐段累加，先算出 y 坐标 ----
    TOP = 118
    y = TOP + 66
    lay = {}

    def node_h(title, body=None, w=CW, tag=None):
        pad = 18
        inner = w - 2 * pad
        h = 22
        if tag:
            h += measure.height(tag, 12, True, inner) + 2
        h += measure.height(title, 17, True, inner) + 4
        if body:
            h += measure.height(body, 14, False, inner)
        return h + 12

    # ①
    lay["n1"] = (y, node_h("定时到点，派生 watch.mjs",
                           "启动后 3s 首次 ｜ plugin-manager/changed 后 1s 补跑 ｜ 目标未就绪时 15s × 4 重试",
                           tag="每 3 分钟"))
    y += lay["n1"][1]
    lay["d1"] = y + 58
    y = lay["d1"] + 58 + 26
    lay["n2"] = (y, node_h("探 5 个平台取版本",
                           "3 个判定平台 + 2 个仅记录；每平台取「接口 productVersion」与「文件名版本」的高者"))
    y += lay["n2"][1] + 26
    lay["n3"] = (y, node_h("三平台再取高 = 判定版本",
                           "与 state.json 的 baseline.version 做字符串比较（官方回退到旧版同样算「变了」）"))
    y += lay["n3"][1]
    lay["d2"] = y + 58
    lay["d3"] = lay["d2"] + 58 + 90 + 58
    y = lay["d3"] + 58 + 40
    lay["n4"] = (y, node_h("写红牌 guard.json",
                           "level=danger · title=WB 更新了 · pendingDisable=true\n"
                           "actions=[soft, hard, ack] · revision + 1",
                           tag="唯一的停用触发点"))
    band1 = (TOP, lay["n4"][0] + lay["n4"][1] + 40 - TOP)

    # ②
    TOP2 = TOP + band1[1] + 26
    y = TOP2 + 66
    lay["n5"] = (y, node_h("读 guard.json", "revision · watermark · ackSuppress · upgrade · stopSessions"))
    y += lay["n5"][1]
    lay["d4"] = y + 58
    y = lay["d4"] + 58 + 26
    lay["n6"] = (y, node_h("发布 watermark + withLiveActions",
                           "宿主拿不到 retainedBy.mainView，它的 busy 只是偏保守的近似；\n"
                           "真正决定按钮的是浏览器那半"))
    y += lay["n6"][1] + 26
    lay["n7"] = (y, node_h("执行一次性指令（按 revision 幂等）",
                           "stopSessions → 软结束会话　｜　upgrade.status=pending → 进入升级流程"))
    band2 = (TOP2, lay["n7"][0] + lay["n7"][1] + 40 - TOP2)

    # ③
    TOP3 = TOP2 + band2[1] + 26
    y = TOP3 + 66
    lay["n8"] = (y, node_h("拉 /state",
                           "watermark · bundleEnabled · revision；拿不到就保留上一份，网络抖一下不会闪掉"))
    y += lay["n8"][1]
    lay["d5"] = y + 58
    y = lay["d5"] + 58 + 26
    lay["n9"] = (y, node_h("autoActions 实时算按钮组合",
                           "订阅 sessions.list，会话一停立刻重算；宿主那份 actions 只作降级兜底"))
    y += lay["n9"][1] + 44
    lay["tri"] = y
    y += 128 + 44
    lay["fan"] = y
    lay["act"] = y + 28
    band3 = (TOP3, lay["act"] - TOP3)

    # ④
    TOP4 = lay["act"]
    y = TOP4 + 66
    lay["a"] = y
    act_h = 214
    band4 = (TOP4, 66 + act_h + 42)

    H = int(round(TOP4 + band4[1] + 56))

    # ---- 正式绘制 ----
    c = Canvas(W, H, scale=2)
    c.text((56, 26), "dsh-workbuddy-account-care 行为流程", 32, True, INK)
    c.text((56, 76),
           "三段轮询：脚本每 3 分钟一轮 → 宿主每 2 秒读一次 guard.json → 浏览器每 5 秒拉一次 /state"
           "　｜　虚线框 = 不动作 / 已结束　｜　棱形 = 判断",
           15, False, INK_3, maxw=1360)

    # ①
    c.band(40, band1[0], 1400, band1[1], "① 探测　scripts/watch.mjs　每 3 分钟派生一次子进程", BLUE, "blue")
    n1, b1 = c.node(CX, lay["n1"][0], CW, "定时到点，派生 watch.mjs",
                    "启动后 3s 首次 ｜ plugin-manager/changed 后 1s 补跑 ｜ 目标未就绪时 15s × 4 重试",
                    BLUE, tag="每 3 分钟")
    c.arrow([AX, b1, AX, lay["d1"] - 58])
    c.diamond(AX, lay["d1"], 182, 58, "connect 装了吗？", "dsh-connect-workbuddy")
    c.arrow([AX + 182, lay["d1"], SX, lay["d1"]], label="否")
    c.note(SX, lay["d1"] - 32, SW, "整轮静默跳过",
           "不写基线、不挂水印、不碰 profile，只留一行日志。", accent=GRAY, fill="#FAFAFA")
    c.arrow([AX, lay["d1"] + 58, AX, lay["n2"][0]], label="是")
    n2, b2 = c.node(CX, lay["n2"][0], CW, "探 5 个平台取版本",
                    "3 个判定平台 + 2 个仅记录；每平台取「接口 productVersion」与「文件名版本」的高者",
                    BLUE)
    c.arrow([AX, b2, AX, lay["n3"][0]])
    n3, b3 = c.node(CX, lay["n3"][0], CW, "三平台再取高 = 判定版本",
                    "与 state.json 的 baseline.version 做字符串比较（官方回退到旧版同样算「变了」）", BLUE)
    c.arrow([AX, b3, AX, lay["d2"] - 58])
    c.diamond(AX, lay["d2"], 182, 58, "判定版本 ≠ 基线？")
    c.arrow([AX + 182, lay["d2"], SX, lay["d2"]], label="否（无变化）")
    c.note(SX, lay["d2"] - 38, SW, "静默",
           "只写一行日志。判定平台任一路都取不到版本时，本轮不判定、也不推进基线。",
           accent=GRAY, fill="#FAFAFA")
    c.arrow([AX, lay["d2"] + 58, AX, lay["d3"] - 58], label="是")
    c.diamond(AX, lay["d3"], 182, 58, "connect 也动过？", "版本 ≠ 基线里记的那一版")
    c.arrow([AX + 182, lay["d3"], SX, lay["d3"]], label="是")
    c.note(SX, lay["d3"] - 32, SW, "视为作者已适配",
           "WB 变了但 connect 也换过版本 → 只记一行日志，不报警。", accent=GRAY, fill="#FAFAFA")
    c.arrow([AX, lay["d3"] + 58, AX, lay["n4"][0]], label="否")
    n4, b4 = c.node(CX, lay["n4"][0], CW, "写红牌 guard.json",
                    "level=danger · title=WB 更新了 · pendingDisable=true\n"
                    "actions=[soft, hard, ack] · revision + 1",
                    ROSE, tag="唯一的停用触发点")
    c.note(SX, lay["n4"][0] - 8, SW, "autoDisable: true（无人值守）",
           "走旧行为：脚本当场停用 bundle 并下发 stopSessions 指令，不等人选。默认是 false。",
           accent=ROSE, fill="#FFF7F9")

    # ②
    c.band(40, band2[0], 1400, band2[1], "② 发布　index.js　每 2 秒读一次 guard.json（脚本退出时立刻同步）",
           VIOLET, "violet")
    c.arrow([AX, b4, AX, lay["n5"][0]])
    n5, b5 = c.node(CX, lay["n5"][0], CW, "读 guard.json",
                    "revision · watermark · ackSuppress · upgrade · stopSessions", VIOLET)
    c.arrow([AX, b5, AX, lay["d4"] - 58])
    c.diamond(AX, lay["d4"], 202, 58, "ackedRevision == revision", "且 ackSuppress 为 true")
    c.arrow([AX + 202, lay["d4"], SX, lay["d4"]], label="是")
    c.note(SX, lay["d4"] - 32, SW, "本 revision 不再下发",
           "刷新、重启都不再出现 —— 这是升级通知的语义。", accent=GRAY, fill="#FAFAFA")
    c.arrow([AX, lay["d4"] + 58, AX, lay["n6"][0]], label="否")
    n6, b6 = c.node(CX, lay["n6"][0], CW, "发布 watermark + withLiveActions",
                    "宿主拿不到 retainedBy.mainView，它的 busy 只是偏保守的近似；\n"
                    "真正决定按钮的是浏览器那半", VIOLET)
    c.arrow([AX, b6, AX, lay["n7"][0]])
    n7, b7 = c.node(CX, lay["n7"][0], CW, "执行一次性指令（按 revision 幂等）",
                    "stopSessions → 软结束会话　｜　upgrade.status=pending → 进入升级流程", VIOLET)
    c.note(SX, lay["n7"][0] - 48, SW, "Desktop 且升级时有 wb 会话在跑",
           "宿主先挂 warning 确认卡（现在升级 / 稍后），点「现在升级」才暂停会话、装包、自动发「继续」。",
           accent=VIOLET, fill="#FAF7FF")

    # ③
    c.band(40, band3[0], 1400, band3[1], "③ 门控与按钮　client.js　每 5 秒拉 /state（仅在标签页可见时）",
           TEAL, "teal")
    c.arrow([AX, b7, AX, lay["n8"][0]])
    n8, b8 = c.node(CX, lay["n8"][0], CW, "拉 /state",
                    "watermark · bundleEnabled · revision；拿不到就保留上一份，网络抖一下不会闪掉", TEAL)
    c.arrow([AX, b8, AX, lay["d5"] - 58])
    c.diamond(AX, lay["d5"], 192, 58, "门控 gateOpen？")
    c.arrow([AX + 192, lay["d5"], SX, lay["d5"]], label="否 → 不渲染")
    c.note(SX, lay["d5"] - 74, SW, "四种门控条件（client.js:393-397）",
           "· isUpgradeCard / isUpgradeGate → 恒显示\n"
           "· bundleEnabled === false（插件已关）→ 不显示\n"
           "· pendingDisable === true（等你决定）→ 无条件显示\n"
           "· 已处理（handledBy）→ 跟随 provider：running || selected",
           accent=TEAL, fill="#F7FDFE")
    c.arrow([AX, lay["d5"] + 58, AX, lay["n9"][0]], label="是")
    n9, b9 = c.node(CX, lay["n9"][0], CW, "autoActions 实时算按钮组合",
                    "订阅 sessions.list，会话一停立刻重算；宿主那份 actions 只作降级兜底", TEAL)

    tri = lay["tri"]
    boxes = [
        (110, ROSE, "有后台 wb 会话在跑", "软结束 · 硬结束 · 知道了", "hasBackground：排掉主视图那个会话"),
        (545, AMBER, "只有前台选中 wb，后台没跑", "只有 知道了", "需求第 17 行：这里不要关闭插件"),
        (980, GRAY, "插件已经被关掉", "只有 知道了", "bundleEnabled === false → 不给「关闭插件」"),
    ]
    centers = [bx + 195 for bx, *_ in boxes]
    bus = tri - 32
    c.arrow([AX, b9, AX, bus])
    c.arrow([centers[0], bus, centers[-1], bus])
    for (bx, accent, title, buttons, sub), cx in zip(boxes, centers):
        c.arrow([cx, bus, cx, tri])
        c.rbox(bx, tri, 390, 128, r=12, fill="#FFFFFF", outline=accent, width=2)
        c.text((bx + 18, tri + 12), title, 15, True, INK, maxw=354)
        c.text((bx + 18, tri + 52), buttons, 17, True, accent, maxw=354)
        c.text((bx + 18, tri + 92), sub, 12, False, INK_3, maxw=354)

    # ④
    c.band(40, band4[0], 1400, band4[1], "④ 动作与落盘　index.js handleAction / runAction", ROSE, "rose")
    ay = lay["a"]
    for bx, _, _, _, _ in boxes:
        c.arrow([bx + 195, tri + 128, bx + 195, ay])

    c.rbox(110, ay, 330, act_h, r=12, fill="#FFFFFF", outline=ROSE, width=2)
    c.text((128, ay + 14), "软结束", 19, True, ROSE)
    c.text((128, ay + 52), "插队一条暂停消息 + cancel 当前轮\n→ 等会话空闲（≤ 120s）\n→ 停用 bundle",
           14, False, INK_2, maxw=294)

    c.rbox(470, ay, 330, act_h, r=12, fill="#FFFFFF", outline=ROSE, width=2)
    c.text((488, ay + 14), "硬结束 / 关闭插件", 19, True, ROSE)
    c.text((488, ay + 52), "立刻停用：从 dsh.profile.bundles 摘掉\n备份 → 写 → 回读校验，失败回滚\n失败则水印保持待确认",
           14, False, INK_2, maxw=294)
    c.text((488, ay + 170), "同一动作，只是文案不同", 12, True, INK_3, maxw=294)

    c.rbox(830, ay, 330, act_h, r=12, fill="#FFFFFF", outline=ROSE, width=2)
    c.text((848, ay + 14), "知道了", 19, True, ROSE)
    c.text((848, ay + 52), "POST ack{revision, suppress}\n落盘 ackedRevision / ackSuppress\nsuppress=false → 1.8s 后重现",
           14, False, INK_2, maxw=294)

    c.rbox(1195, ay, 215, act_h, r=12, fill="#FFF7F9", outline=ROSE, width=1, dash=True)
    c.text((1211, ay + 14), "停用成功后", 15, True, ROSE, maxw=183)
    c.text((1211, ay + 46), "水印转「已处理」\n\npendingDisable=false\nhandledBy = 动作名\nactions=[close, ack]",
           13, False, INK_2, maxw=183)

    c.text((56, H - 44),
           "读图要点：① 只有「WB 版本变了且 connect 没动过」才产生红牌；② 宿主只负责下发，按钮组合在浏览器里算；"
           "③ 点「知道了」的结局由客户端判断后随 ack 带回宿主（ackSuppress）。",
           14, False, INK_3, maxw=1360)

    c.save("flow-overview.png")


# =====================================================================================
# 图 2：按钮组合决策树
# =====================================================================================


# =====================================================================================
# 图 2：按钮组合决策树
# =====================================================================================
def draw_buttons():
    """按钮组合决策树：前两级是竖直判定，后两阶段落成 2×2 矩阵。"""
    c = Canvas(1400, 1180, scale=2)
    c.text((48, 26), "按钮组合决策树", 28, True, INK)
    c.text((48, 70),
           "同一张水印出现什么按钮，取决于三件事：水印处于哪个阶段、插件开没开、此刻有没有后台 wb 会话在跑。"
           "这棵树在 client.js 的 autoActions 里，订阅 sessions，会话一变就重算。",
           15, False, INK_3, maxw=1300)

    MX, RX = 300, 700
    RW = 640

    # ① 升级类
    c.diamond(MX, 200, 200, 56, "升级类水印？", "dismissible / untilRestart / upgradeGate")
    c.arrow([MX, 256, MX, 300], label="是")
    c.rbox(80, 300, 620, 88, r=10, fill="#FFFFFF", outline=GRAY, width=2)
    c.text((100, 312), "保留宿主给的 actions，与有没有会话无关", 15, True, INK)
    c.text((100, 344), "升级通知 → [ack]　　升级确认卡 → [upgrade-now, upgrade-later]",
           13, False, INK_2, maxw=580)

    # ② 插件已关
    c.arrow([MX - 200, 200, MX - 230, 200])
    c.arrow([MX - 230, 200, MX - 230, 470])
    c.arrow([MX - 230, 470, MX - 200, 470], label="否")
    c.diamond(MX, 470, 200, 56, "插件已关？", "bundleEnabled === false")
    c.arrow([MX + 200, 470, RX, 470], label="是")
    c.rbox(RX, 428, RW, 84, r=10, fill="#FFFFFF", outline=GRAY, width=2)
    c.text((RX + 18, 440), "只有 [ack]", 16, True, GRAY)
    c.text((RX + 18, 470), "「关闭插件」已是空动作，不摆这个按钮", 13, False, INK_3, maxw=RW - 36)

    # ③ 阶段：还在等你决定吗
    c.arrow([MX, 526, MX, 594], label="否")
    c.diamond(MX, 650, 210, 56, "还在等你决定？", "pendingDisable === true")

    # 3.1 是 → 矩阵第 1 行
    c.arrow([MX + 210, 650, RX - 130, 650, RX - 130, 630], label="是")
    # 3.2 否（已处理）→ 矩阵第 2 行
    c.arrow([MX, 706, MX, 790, RX - 130, 790], label="否")

    # ---- 2×2 矩阵：后两个阶段只差「有没有后台会话」这一问 ----
    TAG_W, COL_W, GAP = 150, 306, 18
    tag_x = RX - 130
    col1 = tag_x + TAG_W + 10
    col2 = col1 + COL_W + GAP

    c.text((col1, 530), "后台 wb 会话在跑", 14, True, ROSE)
    c.text((col2, 530), "没有后台会话", 14, True, AMBER)

    rows = [
        (560, "待决定", ROSE, "pendingDisable", "#FFF7F9",
         ("软结束 · 硬结束 · 知道了", "用户决定怎么掐断", ROSE),
         ("只有 知道了", "需求第 17 行：这里不要关闭插件", AMBER)),
        (720, "已处理", AMBER, "handledBy 存在", "#FFFBF2",
         ("只有 知道了", "强提醒，需求第 23-24 行", ROSE),
         ("关闭插件 · 知道了", "你自己开回来的，就该能再关掉", BLUE)),
    ]
    for y, tag, accent, sub, fill, left, right in rows:
        c.rbox(tag_x, y, TAG_W, 140, r=10, fill=fill, outline=accent, width=2)
        c.text((tag_x + 14, y + 20), tag, 17, True, accent, maxw=TAG_W - 28)
        c.text((tag_x + 14, y + 54), sub, 11, False, INK_3, maxw=TAG_W - 28)
        for x, (title, body, tone) in ((col1, left), (col2, right)):
            c.rbox(x, y, COL_W, 140, r=10, fill="#FFFFFF", outline=tone, width=2)
            c.text((x + 16, y + 20), title, 16, True, tone, maxw=COL_W - 32)
            c.text((x + 16, y + 66), body, 13, False, INK_2, maxw=COL_W - 32)

    c.note(60, 900, 640, "这棵树修掉了什么（2026-11-17）",
           "① 待决定 + 没有后台会话：原先给 [close, ack]，把「关插件」摆成一个一键就能按掉的按钮；"
           "现在只给 [ack]——需求第 17 行「这里不要关闭插件」。\n"
           "② hasBackground 原先被 guarded() 的一次 TypeError 清零，第 1 行于是整行退化成第 2 行的答案。",
           accent=ROSE, fill="#FFF7F9")

    c.text((60, 1096),
           "注：「关闭插件」与「硬结束」在 handleAction 里归一到同一条 runAction，不插暂停消息、不等空闲"
           "——所以在有后台任务时点它，就是一次硬停用。"
           "另外 disableCurrentBundle 现在有 30s 超时，重复点也不会把 actionInFlight 卡死。",
           13, False, INK_3, maxw=1300)

    c.save("flow-buttons.png")


# =====================================================================================
# 图 3：缺陷路径
# =====================================================================================
def draw_defect():
    c = Canvas(1380, 1210, scale=2)
    c.text((48, 26), "两个已修的缺陷：后台在跑却只给「关闭插件」／点了关不掉", 27, True, INK)
    c.text((48, 70),
           "2026-11-17 用户实测两次反馈。左：按钮组合退化，点下去就是硬停用。右：「关闭插件」判成功判反了，"
           "重复点也出不来。两条都已修 + 补了回归用例。",
           15, False, INK_3, maxw=1300)

    x, w = 60, 620
    y = 126
    steps = [
        ("触发", "WB 客户端版本变了，connect 没跟上。此时后台还有 wb 会话在跑——"
                 "本该给「软结束 / 硬结束 / 知道了」。", ROSE),
        ("脚本侧", "watch.mjs 写下 pendingDisable=true 的红牌，actions=['soft','hard','ack'] 只是初值；"
                   "真正的组合由宿主与浏览器按实时状态改写。", BLUE),
        ("宿主侧", "index.js 的 withLiveActions 算一份镜像；poll 每 2 秒重算，"
                   "所以「后台有没有会话」一变，按钮就该跟着变。", VIOLET),
        ("客户端", "client.js 的 autoActions 订阅 sessions.list，是更灵敏的那一份；"
                   "它算出来的结果覆盖宿主值。", TEAL),
    ]
    for tag, body, accent in steps:
        h = 18 + c.height(body, 14, maxw=w - 150) + 16
        c.rbox(x, y, w, h, r=10, fill="#FFFFFF", outline=accent, width=2)
        c.text((x + 16, y + 13), tag, 14, True, accent)
        c.text((x + 116, y + 11), body, 14, False, INK, maxw=w - 136)
        c.arrow([x + 40, y + h, x + 40, y + h + 22])
        y += h + 22

    fy = y + 14
    c.text((x, fy - 4), "按钮为什么算错？两条路径，任一条都够 ——", 17, True, INK)
    fy += 32

    lx, rx, cw = x, x + 320, 300

    # ---- 路径 A ----
    CARD_H = 340
    c.rbox(lx, fy, cw, CARD_H, r=12, fill="#FFF7F9", outline=ROSE, width=2)
    c.text((lx + 16, fy + 12), "路径 A｜hasBackground 被清零", 15, True, ROSE)
    c.text((lx + 16, fy + 42), "client.js:304（改前）", 12, False, INK_3)
    b = c.code(lx + 16, fy + 60, cw - 32, [
        "const pick = selection?.next",
        "           ?? selection?.lastUsed",
        "return pick !== undefined &&",
        "     GUARDED.includes(pick.provider)",
    ])
    c.text((lx + 16, b + 10),
           "新会话的 next 与 lastUsed 都是 null：pick 是 null——不等于 undefined，"
           "取 .provider 直接抛 TypeError。read() 的 catch 又把 running 与 selected 一起清零，"
           "于是「后台有任务」永远算不出来。",
           12, False, INK, maxw=cw - 32)
    c.text((lx + 16, b + 118), "修法：加一个 pick !== null。宿主侧 index.js:611 "
                               "写的一直是 if (current && ...)，两边不对称就是这处漏改。",
           12, True, ROSE, maxw=cw - 32)

    # ---- 路径 B ----
    c.rbox(rx, fy, cw, CARD_H, r=12, fill="#FFFBF2", outline=AMBER, width=2)
    c.text((rx + 16, fy + 12), "路径 B｜关闭插件判成功判反", 15, True, AMBER)
    c.text((rx + 16, fy + 42), "index.js:897-898（改前）", 12, False, INK_3)
    b = c.code(rx + 16, fy + 60, cw - 32, [
        "const disabledOk = disabled.ok",
        "  && (disabled.result?.changed === true",
        "   || disabled.result",
        "        ?.result?.changed === true)",
    ])
    c.text((rx + 16, b + 10),
           "--disable 是幂等的：插件已经关了就返回 { changed:false, reason:'already-disabled' }。"
           "只认 changed===true，于是「本来就已经关了」被判成失败——水印停在待确认，再点还是同样结果。",
           12, False, INK, maxw=cw - 32)
    c.text((rx + 16, b + 118), "修法：already-disabled 也算成功。另给 disableCurrentBundle "
                               "加 30s 超时，子进程卡住时不再把 actionInFlight 永久占住。",
           12, True, AMBER, maxw=cw - 32)

    ay = fy + CARD_H
    c.arrow([lx + cw // 2, ay, lx + cw // 2, ay + 22])
    c.arrow([rx + cw // 2, ay, rx + cw // 2, ay + 22])
    c.arrow([lx + cw // 2, ay + 22, rx + cw // 2, ay + 22])

    ry = ay + 36
    c.rbox(x, ry, w, 140, r=12, fill="#FFFFFF", outline=ROSE, width=2)
    c.text((x + 18, ry + 12), "症状长这样", 17, True, ROSE)
    c.text((x + 18, ry + 48),
           "① 后台有 wb 会话在跑，卡片却只有「关闭插件 / 知道了」——点下去是硬停用，那一轮请求当场失败。",
           13, False, INK, maxw=w - 36)
    c.text((x + 18, ry + 88),
           "② 点「关闭插件」没反应、也关不掉——重复点只会拿到同一份 already-disabled，永远走不出待确认。",
           13, False, INK, maxw=w - 36)
    c.arrow([x + w // 2, ay + 22, x + w // 2, ry])

    # ---- 修了什么 ----
    px, pw = 720, 620
    tips = [
        ("1", "client.js:304 guarded()：pick !== null 也判掉。新增 test/client-guarded.test.mjs，"
              "从源码里抽出这段函数求值——把旧写法放回去，用例立刻红 2 条。"),
        ("2", "client.js:624-640 autoActions：待决定 + 没有后台会话 → 只给 [ack]。"
              "「关闭插件」不再是一个一键就能按掉的按钮（需求第 17 行）。"),
        ("3", "index.js:1360-1390 withLiveActions：同步成同样的矩阵。"
              "没有 sessions 服务时宿主那份就是最终答案，两边必须一起改。"),
        ("4", "index.js:918-935 disabledOk：already-disabled 也算成功，"
              "其余失败（回滚 / manifest 坏 / spawn 失败）照旧保留水印。"),
        ("5", "index.js:766-793 disableCurrentBundle：加 30s 超时，卡住时 kill 并按失败返回，"
              "用户至少能再点一次，不会永远卡在 409 busy。"),
    ]
    # 先量高度再画框：否则面板底部会留一大片空白
    need = 56
    for _, body in tips:
        need += 13 * LH * c.height(body, 13, False, pw - 64) + 30
    panel_h = max(need, CARD_H + 36 + 140)
    c.rbox(px, fy, pw, panel_h, r=12, fill="#F8FAFC", outline="#CBD5E1", width=2)
    c.text((px + 20, fy + 14), "已改的地方（2026-11-17）", 17, True, INK)
    ty = fy + 56
    for num, body in tips:
        c.d.text(((px + 22) * c.S, ty * c.S), num, font=c.font(13, True), fill=ROSE)
        n = c.text((px + 42, ty), body, 13, False, INK_2, maxw=pw - 64)
        ty += 13 * LH * n + 30

    bottom = max(ry + 140, ty - 10)
    c.text((48, bottom + 34),
           "验证：npm test 全绿（58 通过，新增 actions-matrix 8 条 + client-guarded 9 条 + uses-workbuddy 2 条）。"
           "端到端复现：临时 profile 上连点两次 close —— 第一次 changed=true，第二次 already-disabled，"
           "两次都 disabledOk=true、水印都转成已处理。",
           13, False, INK_3, maxw=1300)

    c.save("flow-defect.png")



if __name__ == "__main__":
    draw_overview_full()
    draw_buttons()
    draw_defect()
