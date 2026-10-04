"""
NodCut's Manim scenes. The plugin runs

    manim render nodcut_manim.py NodCutScene -r W,H --fps N ...

with NODCUT_MANIM_JOB naming a JSON file: {"template", "params", "duration" (seconds),
"result" (where to write what was rendered), "code" (custom-scene only: a .py file, which
sees DURATION as a global)}. Every scene is laid out in Manim units from the frame's size, so
one template fits 9:16, 1:1 and 16:9; nothing here needs LaTeX except the equation template.
The scene is padded with a still frame to the length asked, its real length is written to the
result file, and progress and errors go to stderr as NODCUT_PROGRESS / NODCUT_ERROR lines.
"""

import ast
import importlib.util
import json
import math
import os
import sys
import traceback

from manim import *  # noqa: F403 (the scenes use Manim's whole vocabulary)

JOB = json.loads(open(os.environ["NODCUT_MANIM_JOB"], encoding="utf-8").read())
P = JOB.get("params", {})
DURATION = float(JOB["duration"])

# `-r W,H` sets the pixels but not the frame's width in Manim units: keep the height (8 units) and
# make the width match the pixels' aspect, or a portrait frame would show a slice of a 16:9 one
config.frame_width = config.frame_height * config.pixel_width / config.pixel_height

# Manim rounds each animation to whole frames, so its clock (renderer.time) drifts from the clip;
# count the frames written instead, which is the clip's real length
FRAMES = [0]
_write_frame = SceneFileWriter.write_frame


def _counting_write_frame(self, frame, num_frames=1, *args, **kwargs):
    FRAMES[0] += num_frames
    return _write_frame(self, frame, num_frames, *args, **kwargs)


SceneFileWriter.write_frame = _counting_write_frame


def elapsed():
    """Seconds of clip written so far."""
    return FRAMES[0] / config.frame_rate


def fit(mob, width=0.84, height=0.8):
    """Shrink a mobject to fit the frame (never grow it)."""
    if mob.width > config.frame_width * width:
        mob.scale_to_fit_width(config.frame_width * width)
    if mob.height > config.frame_height * height:
        mob.scale_to_fit_height(config.frame_height * height)
    return mob


def unit():
    """A size that scales with the frame's short side (8 units on a 16:9 frame's height)."""
    return min(config.frame_width, config.frame_height) / 8


def text(s, size, color, weight=NORMAL):
    """Text of a size relative to the frame, on up to three lines when one is too wide."""
    one = Text(s, font_size=size * unit(), color=color, weight=weight)
    words = s.split()
    for lines in (2, 3):
        if one.width <= config.frame_width * 0.84 or len(words) < lines:
            break
        one = Text(balance(words, lines), font_size=size * unit(), color=color, weight=weight,
                   line_spacing=0.8)
    return one


def balance(words, lines):
    """Words split into lines of about the same number of characters."""
    target = sum(len(w) + 1 for w in words) / lines
    out, cur = [], []
    for w in words:
        if cur and len(" ".join(cur + [w])) > target and len(out) < lines - 1:
            out.append(" ".join(cur))
            cur = []
        cur.append(w)
    return "\n".join(out + [" ".join(cur)])


def times(d):
    """(intro, outro) lengths in seconds for a scene of d seconds."""
    return min(1.6, d * 0.35), min(0.5, d * 0.12)


# ── templates ─────────────────────────────────────────────────────────────────


def title(scene, p, d):
    intro, outro = times(d)
    head = fit(text(p["title"], 80, p["color"], BOLD))
    parts = [head]
    bar = Line(LEFT, RIGHT, color=p["accent"], stroke_width=8 * unit())
    bar.set(width=min(head.width, config.frame_width * 0.6))
    parts.append(bar)
    sub = None
    if p.get("subtitle"):
        sub = fit(text(p["subtitle"], 40, p["color"]))
        parts.append(sub)
    VGroup(*parts).arrange(DOWN, buff=0.35 * unit())
    scene.play(Write(head), run_time=intro)
    scene.play(GrowFromCenter(bar), *([FadeIn(sub, shift=UP * 0.2)] if sub else []), run_time=intro * 0.5)
    hold(scene, d, outro)


def equation(scene, p, d):
    intro, outro = times(d)
    eq = fit(MathTex(p["latex"], color=p["color"], font_size=96 * unit()))
    parts = [eq]
    if p.get("caption"):
        parts.append(fit(text(p["caption"], 40, p["accent"])))
    VGroup(*parts).arrange(DOWN, buff=0.5 * unit())
    scene.play(Write(eq), run_time=intro)
    if len(parts) > 1:
        scene.play(FadeIn(parts[1], shift=UP * 0.2), run_time=intro * 0.4)
    if p.get("highlight"):
        scene.play(Circumscribe(eq, color=p["accent"]), run_time=min(1.2, d * 0.2))
    hold(scene, d, outro)


SAFE = {k: getattr(math, k) for k in ("sin", "cos", "tan", "exp", "log", "sqrt", "pi", "e", "atan", "sinh", "cosh", "tanh")}
SAFE["abs"] = abs


def expression(src):
    """f(x) from an expression in x, allowing only arithmetic and SAFE names."""
    tree = ast.parse(src.replace("^", "**"), mode="eval")
    allowed = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Call, ast.Name, ast.Load, ast.Constant,
               ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd, ast.Mod)
    for node in ast.walk(tree):
        if not isinstance(node, allowed):
            raise ValueError(f"{type(node).__name__} is not allowed in an expression")
        if isinstance(node, ast.Name) and node.id != "x" and node.id not in SAFE:
            raise ValueError(f"unknown name {node.id}")
        if isinstance(node, ast.Call) and not isinstance(node.func, ast.Name):
            raise ValueError("only plain function calls")
    code = compile(tree, "<expression>", "eval")
    return lambda x: eval(code, {"__builtins__": {}}, {**SAFE, "x": x})


def function_plot(scene, p, d):
    intro, outro = times(d)
    f = expression(p["expression"])
    x0, x1 = p["xMin"], p["xMax"]
    xs = [x0 + (x1 - x0) * i / 200 for i in range(201)]
    ys = [y for y in (safe_eval(f, x) for x in xs) if y is not None]
    if not ys:
        raise ValueError("the expression has no value between xMin and xMax")
    y0, y1 = (p["yMin"], p["yMax"]) if p.get("yMin") is not None and p.get("yMax") is not None else (min(ys), max(ys))
    if y1 - y0 < 1e-9:
        y0, y1 = y0 - 1, y1 + 1
    w = config.frame_width * 0.8
    h = config.frame_height * (0.55 if p.get("label") else 0.7)
    axes = Axes(x_range=[x0, x1, (x1 - x0) / 4], y_range=[y0, y1, (y1 - y0) / 4], x_length=w, y_length=h,
                axis_config={"color": p["color"], "stroke_opacity": 0.6}, tips=False)
    graph = axes.plot(f, x_range=[x0, x1], color=p["accent"], stroke_width=6 * unit(), use_smoothing=False,
                      discontinuities=None)
    parts = [axes]
    label = None
    if p.get("label"):
        label = fit(text(p["label"], 40, p["color"]))
        VGroup(label, axes).arrange(DOWN, buff=0.4 * unit())
    scene.play(Create(axes), *([FadeIn(label)] if label else []), run_time=intro * 0.6)
    dot = Dot(graph.get_start(), color=p["accent"], radius=0.08 * unit())
    scene.add(dot)
    scene.play(Create(graph), MoveAlongPath(dot, graph), run_time=max(0.5, d - intro * 0.6 - outro - 0.5), rate_func=linear)
    hold(scene, d, outro)


def safe_eval(f, x):
    try:
        y = float(f(x))
        return y if math.isfinite(y) else None
    except (ValueError, ZeroDivisionError, OverflowError):
        return None


def bar_chart(scene, p, d):
    intro, outro = times(d)
    items = p["items"]
    top = max(abs(i["value"]) for i in items) or 1
    w = config.frame_width * 0.84
    h = config.frame_height * 0.5
    slot = w / len(items)
    bars, labels, values = VGroup(), VGroup(), VGroup()
    base_y = -h / 2
    for i, it in enumerate(items):
        x = -w / 2 + slot * (i + 0.5)
        bh = max(0.02, h * abs(it["value"]) / top)
        bar = Rectangle(width=slot * 0.62, height=bh, fill_color=p["accent"], fill_opacity=1, stroke_width=0)
        bar.move_to([x, base_y + bh / 2, 0])
        bars.add(bar)
        lab = text(it["label"], 30, p["color"])
        lab.scale_to_fit_width(min(lab.width, slot * 0.92)).next_to([x, base_y, 0], DOWN, buff=0.2 * unit())
        labels.add(lab)
        val = text(fmt(it["value"], p.get("unit", "")), 32, p["color"], BOLD)
        val.scale_to_fit_width(min(val.width, slot * 0.92)).next_to(bar, UP, buff=0.15 * unit())
        values.add(val)
    chart = VGroup(bars, labels, values)
    if p.get("title"):
        head = fit(text(p["title"], 52, p["color"], BOLD))
        VGroup(head, chart).arrange(DOWN, buff=0.5 * unit())
        scene.play(FadeIn(head, shift=DOWN * 0.2), run_time=intro * 0.4)
    else:
        chart.move_to(ORIGIN)
    fit(chart)
    scene.play(FadeIn(labels), run_time=intro * 0.3)
    scene.play(LaggedStart(*[GrowFromEdge(b, DOWN) for b in bars], lag_ratio=0.15), run_time=intro)
    scene.play(LaggedStart(*[FadeIn(v, shift=UP * 0.1) for v in values], lag_ratio=0.1), run_time=intro * 0.4)
    hold(scene, d, outro)


def fmt(v, suffix):
    s = f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}".rstrip("0")
    return s + suffix


def morph_text(scene, p, d):
    intro, outro = times(d)
    a = fit(text(p["from"], 110, p["color"], BOLD))
    b = fit(text(p["to"], 110, p["accent"], BOLD))
    scene.play(Write(a), run_time=intro * 0.7)
    scene.wait(max(0, (d - intro * 1.7 - outro) * 0.35))
    scene.play(TransformMatchingShapes(a, b), run_time=intro)
    hold(scene, d, outro)


def hold(scene, d, outro):
    """Wait until the outro, then fade everything out."""
    left = d - elapsed() - outro
    if left > 0:
        scene.wait(left)
    if scene.mobjects:
        scene.play(*[FadeOut(m) for m in scene.mobjects], run_time=outro)


TEMPLATES = {
    "title": title,
    "equation": equation,
    "function-plot": function_plot,
    "bar-chart": bar_chart,
    "morph-text": morph_text,
}


def report(scene):
    """A progress line for the plugin: the share of the clip rendered so far."""
    print(f"NODCUT_PROGRESS {min(1.0, elapsed() / DURATION):.3f}", file=sys.stderr, flush=True)


def explain(e):
    """One line for the plugin naming the error and, in custom code, its line."""
    where = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == JOB.get("code")]
    at = f" (line {where[-1].lineno}: {where[-1].line})" if where else ""
    msg = " ".join(str(e).split())[:400]
    if isinstance(e, SyntaxError):
        msg, at = e.msg, f" (line {e.lineno}: {(e.text or '').strip()})"
    print(f"NODCUT_ERROR {type(e).__name__}: {msg}{at}", file=sys.stderr, flush=True)


class Reporting:
    """Reports progress after every play and wait, and explains a failure in one line."""

    def play(self, *args, **kwargs):
        super().play(*args, **kwargs)
        report(self)

    def wait(self, *args, **kwargs):
        super().wait(*args, **kwargs)
        report(self)

    def construct(self):
        try:
            self.draw()
        except Exception as e:
            explain(e)
            raise
        finish(self)


def finish(scene):
    """Pad to the length asked and say what was rendered."""
    fps = config.frame_rate
    left = round(DURATION * fps) - FRAMES[0]
    if left > 0:
        # a wait of t seconds writes ceil(t * fps) frames; half a frame less makes it exactly `left`
        scene.wait((left - 0.5) / fps)
    writer = scene.renderer.file_writer
    with open(JOB["result"], "w", encoding="utf-8") as out:
        json.dump({"frames": FRAMES[0], "seconds": elapsed(), "hasAudio": bool(getattr(writer, "includes_sound", False))}, out)


if JOB["template"] == "custom-scene":
    sys.path.insert(0, os.path.dirname(JOB["code"]))
    spec = importlib.util.spec_from_file_location("nodcut_user_scene", JOB["code"])
    user = importlib.util.module_from_spec(spec)
    user.DURATION = DURATION  # the clip's length in seconds, for the scene to time itself by
    try:
        spec.loader.exec_module(user)
    except Exception as e:
        explain(e)
        raise SystemExit(1)
    name = P.get("sceneName")
    scenes = [v for k, v in vars(user).items() if isinstance(v, type) and issubclass(v, Scene) and v.__module__ == user.__name__]
    chosen = getattr(user, name, None) if name else (scenes[-1] if scenes else None)
    if chosen is None or not (isinstance(chosen, type) and issubclass(chosen, Scene)):
        print(f"NODCUT_ERROR NoScene: no Scene class {name or ''} in the code".replace("  ", " "), file=sys.stderr)
        raise SystemExit(1)

    class NodCutScene(Reporting, chosen):
        def draw(self):
            if P.get("background"):
                self.camera.background_color = P["background"]
            chosen.construct(self)

else:

    class NodCutScene(Reporting, Scene):
        def draw(self):
            self.camera.background_color = P["background"]
            TEMPLATES[JOB["template"]](self, P, DURATION)
