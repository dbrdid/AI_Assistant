# 문서 추출 테스트 파일 만들기: python3 make_fixtures.py <폴더>  (google-chrome, qpdf, python-docx, python-pptx 필요)
import sys, os
out = sys.argv[1]
import subprocess, html as H
def chrome_pdf(path, pages_html):
    body = ''.join(f'<section style="page-break-after:always">{p}</section>' for p in pages_html)
    src = path + '.html'
    open(src, 'w', encoding='utf-8').write('<html><meta charset="utf-8"><body style="font-family:Noto Sans CJK KR">' + body + '</body></html>')
    subprocess.run(['google-chrome', '--headless', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer',
                    '--print-to-pdf=' + path, 'file://' + src], check=True, capture_output=True)
    os.remove(src)
def page(p, n):
    return f'<h2>{p}쪽 제목: 정규화와 트랜잭션</h2>' + ''.join(
        f'<p>본문 {p}-{i+1}: 데이터베이스 설계에서 중복을 줄이는 방법 {H.escape("& <태그>")} 예시</p>' for i in range(n))
chrome_pdf(os.path.join(out, 'lecture.pdf'), [page(1, 3), '<div style="height:10px"></div>', page(3, 3)])
chrome_pdf(os.path.join(out, 'big.pdf'), [page(p, 25) for p in range(1, 121)])
chrome_pdf(os.path.join(out, 'scanned.pdf'), ['<div style="width:300px;height:100px;background:#000"></div>'] * 2)
fn = 'chrome'

import docx
from docx.enum.text import WD_BREAK
d = docx.Document()
d.add_heading('회의록: 스텔라 2주차', 1)
d.add_paragraph('참석: 병욱, 주원')
p = d.add_paragraph('결정: 구간은 2분'); p.add_run('\t탭 뒤 & 기호 <a>')
p2 = d.add_paragraph('줄바꿈 앞'); r = p2.add_run(); r.add_break(); p2.add_run('줄바꿈 뒤')
p3 = d.add_paragraph('다음 쪽으로'); p3.add_run().add_break(WD_BREAK.PAGE)
d.add_paragraph('2쪽 내용: 할 일 정리')
t = d.add_table(rows=2, cols=2)
t.cell(0,0).text = '담당'; t.cell(0,1).text = '마감'
t.cell(1,0).text = '병욱'; t.cell(1,1).text = '11/20'
d.save(os.path.join(out, 'meeting.docx'))

from pptx import Presentation
from pptx.util import Inches
prs = Presentation()
for i, (title, body) in enumerate([('1장 소개', '스텔라는 메모 앱'), ('2장 구조', '서버: Supabase\n기기: SQLite'), ('3장 마무리', '')]):
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = title
    if body: s.placeholders[1].text = body
    else: s.placeholders[1].text = ''
    if i == 1:
        s.notes_slide.notes_text_frame.text = '발표자 메모: 동기화 설명'
prs.save(os.path.join(out, 'slides.pptx'))
# 슬라이드 순서 바꾸기 (파일 이름 순서 ≠ 표시 순서 확인용)
prs2 = Presentation(os.path.join(out, 'slides.pptx'))
ids = prs2.slides._sldIdLst
el = list(ids); ids.remove(el[0]); ids.append(el[0])
prs2.save(os.path.join(out, 'slides_reordered.pptx'))
print('font', fn)
# 암호 PDF
subprocess.run(['qpdf', '--encrypt', 'secret', 'secret', '256', '--', os.path.join(out, 'lecture.pdf'), os.path.join(out, 'encrypted.pdf')], check=True)
