"""Макет билетов: лист A4, 6 вертикальных билетов 66×143 мм (3 × 2), метки для бота."""
import sys
from pptx import Presentation
from pptx.util import Mm, Pt
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_LINE_DASH_STYLE
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

title, accent = sys.argv[1], RGBColor.from_string(sys.argv[2])
out = sys.argv[3]

W, H = 66, 143          # билет, мм
MX, MY = 6, 5.5         # поля листа
prs = Presentation()
prs.slide_width, prs.slide_height = Mm(210), Mm(297)
slide = prs.slides.add_slide(prs.slide_layouts[6])
INK = RGBColor(0x22, 0x22, 0x22)
GREY = RGBColor(0x88, 0x88, 0x88)


def text(x, y, w, h, s, size, bold=False, color=INK, align=PP_ALIGN.CENTER, font='Arial'):
    tb = slide.shapes.add_textbox(Mm(x), Mm(y), Mm(w), Mm(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = align
    for k, line in enumerate(s.split('\n')):
        if k:
            p = tf.add_paragraph()
            p.alignment = align
        r = p.add_run()
        r.text = line
        r.font.size, r.font.bold, r.font.color.rgb, r.font.name = Pt(size), bold, color, font
    return tb


for i in range(6):
    col, row = i % 3, i // 3
    x, y = MX + col * W, MY + row * H
    n = i + 1
    # линия реза
    cut = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Mm(x), Mm(y), Mm(W), Mm(H))
    cut.fill.background()
    cut.shadow.inherit = False
    cut.line.color.rgb = RGBColor(0xBB, 0xBB, 0xBB)
    cut.line.width = Pt(0.5)
    cut.line.dash_style = MSO_LINE_DASH_STYLE.DASH
    # цветная полоса сверху — место для оформления
    band = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Mm(x + 4), Mm(y + 4), Mm(W - 8), Mm(34))
    band.fill.solid()
    band.fill.fore_color.rgb = accent
    band.line.fill.background()
    band.shadow.inherit = False
    text(x + 6, y + 6, W - 12, 8, 'Studio MYXA', 9, color=RGBColor(0xFF, 0xFF, 0xFF))
    text(x + 6, y + 15, W - 12, 20, '{{СПЕКТАКЛЬ}}', 15, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF))
    text(x + 5, y + 42, W - 10, 7, '{{ДАТА}} · {{ВРЕМЯ}}', 12, bold=True)
    text(x + 5, y + 49, W - 10, 6, '{{ПЛОЩАДКА}}', 10, color=GREY)
    # место под QR: квадрат с меткой, бот заменит его картинкой того же размера
    q = 44
    qr = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Mm(x + (W - q) / 2), Mm(y + 60), Mm(q), Mm(q))
    qr.fill.solid()
    qr.fill.fore_color.rgb = RGBColor(0xF2, 0xF2, 0xF2)
    qr.line.fill.background()
    qr.shadow.inherit = False
    tf = qr.text_frame
    tf.paragraphs[0].alignment = PP_ALIGN.CENTER
    r = tf.paragraphs[0].add_run()
    r.text = '{{QR_%d}}' % n
    r.font.size, r.font.color.rgb = Pt(9), GREY
    text(x + 5, y + 106, W - 10, 7, '{{КОД_%d}}' % n, 13, bold=True, font='Courier New')
    text(x + 5, y + 116, W - 10, 6, '{{ТИП}} · {{ЦЕНА}} дин.', 10)
    text(x + 5, y + 126, W - 10, 10, 'Билет действителен на один вход\nСохраните до конца спектакля', 7, color=GREY)

prs.save(out)
print(out)
