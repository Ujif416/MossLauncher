"""Compose a static home-screen design using the exported MossLauncher assets."""
from pathlib import Path
import sys, base64, json, zipfile
from io import BytesIO
from xml.sax.saxutils import escape
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.asset-tools'))
from PIL import Image
import resvg_py
A=ROOT/'assets/mosslauncher-complete'
OUT=A/'screens'
OUT.mkdir(exist_ok=True)
parts=[]
def raw(s): parts.append(s)
def text(x,y,s,size=16,color='#EFF3E9',weight=400):
    raw(f'<text x="{x}" y="{y}" fill="{color}" font-family="Segoe UI" font-size="{size}" font-weight="{weight}">{escape(s)}</text>')
def line(x,y,x2,y2,color='#303E33'):
    raw(f'<path d="M{x} {y}H{x2}" stroke="{color}"/>' if y==y2 else f'<path d="M{x} {y}L{x2} {y2}" stroke="{color}"/>')
def image(path,x,y,w,h):
    p=A/path
    mime='image/svg+xml' if p.suffix=='.svg' else 'image/png'
    data=base64.b64encode(p.read_bytes()).decode()
    raw(f'<image x="{x}" y="{y}" width="{w}" height="{h}" href="data:{mime};base64,{data}"/>')
def panel(path,x,y,w,h,inset=20):
    # Preserve the original corner radii with nine-slice raster composition at 2x.
    src=Image.open(A/path).convert('RGBA'); scale=2
    dst=Image.new('RGBA',(w*scale,h*scale)); b=inset*scale
    sx=[0,b,src.width-b,src.width]; sy=[0,b,src.height-b,src.height]
    dx=[0,b,w*scale-b,w*scale]; dy=[0,b,h*scale-b,h*scale]
    for j in range(3):
        for i in range(3):
            tile=src.crop((sx[i],sy[j],sx[i+1],sy[j+1]))
            tile=tile.resize((dx[i+1]-dx[i],dy[j+1]-dy[j]),Image.Resampling.LANCZOS)
            dst.paste(tile,(dx[i],dy[j]))
    bfr=BytesIO(); dst.save(bfr,format='PNG')
    raw(f'<image x="{x}" y="{y}" width="{w}" height="{h}" href="data:image/png;base64,{base64.b64encode(bfr.getvalue()).decode()}"/>')
def icon(name,x,y,size=24,color='default'): image(f'icons/{color}/{name}.svg',x,y,size,size)
def pill(x,y,label,icon_name):
    panel('buttons/secondary-default@2x.png',x,y,144,40,16)
    icon(icon_name,x+13,y+10,20,'accent'); text(x+43,y+26,label,14)

raw('<rect width="1600" height="1000" fill="#101612"/>')
raw('<rect width="240" height="1000" fill="#141C16"/>')
line(240,0,240,1000)
image('branding/mark-sage.svg',20,19,44,44)
text(76,48,'MossLauncher',21,weight=600)
text(28,105,'ЛАУНЧЕР',11,'#718574',600)
nav=[('Главная','home'),('Мои сборки','instances'),('Моды и ресурсы','mods'),('Загрузки','download'),('Серверы','servers')]
for i,(label,ic) in enumerate(nav):
    y=124+i*56
    if i==0: panel('buttons/tab-selected@2x.png',16,y,208,46,16)
    icon(ic,30,y+11,22,'accent' if i==0 else 'default')
    text(66,y+29,label,15,'#EFF3E9' if i==0 else '#A0AEA1',600 if i==0 else 400)
line(24,432,216,432)
text(28,467,'БЫСТРЫЙ ДОСТУП',11,'#718574',600)
icon('folder-open',29,490,20,'muted'); text(61,506,'Папка игры',14,'#A0AEA1')
icon('logs',29,535,20,'muted'); text(61,551,'Журнал запуска',14,'#A0AEA1')
icon('help',29,828,20,'muted'); text(61,844,'Помощь',14,'#A0AEA1')
icon('settings',29,873,20,'muted'); text(61,889,'Настройки',14,'#A0AEA1')
line(24,921,216,921)
image('status/online.svg',26,947,14,14); text(47,959,'Всё готово к игре',12,'#A0AEA1')

text(272,43,'Главная',16,weight=600)
text(1158,43,'Player',14)
image('placeholders/avatar.svg',1233,17,32,32)
icon('chevron-down',1276,25,16,'muted')
line(1320,18,1320,48)
icon('minimize',1350,23,20,'muted'); icon('maximize',1410,23,20,'muted'); icon('close',1470,23,20,'muted')
line(240,66,1600,66)
text(280,112,'ТВОЙ СЛЕДУЮЩИЙ МИР',11,'#A0AEA1',600)
text(280,153,'С возвращением, Player',30,weight=600)
text(280,184,'Выбери сборку и продолжи своё приключение.',15,'#A0AEA1')
pill(1408,125,'Обновить','update')

# Hero uses the exact mist landscape from the current asset pack.
raw('<defs><clipPath id="hero"><rect x="280" y="214" width="1272" height="422" rx="18"/></clipPath><linearGradient id="shade"><stop stop-color="#101612" stop-opacity=".97"/><stop offset=".45" stop-color="#101612" stop-opacity=".67"/><stop offset="1" stop-color="#101612" stop-opacity="0"/></linearGradient></defs>')
raw('<g clip-path="url(#hero)">')
image('backgrounds/forest-mist.png',280,67,1272,716)
raw('<rect x="280" y="214" width="1272" height="422" fill="url(#shade)"/>')
raw('</g><rect x="280.5" y="214.5" width="1271" height="421" rx="18" fill="none" stroke="#3B4B3E"/>')
image('status/online.svg',312,247,14,14); text(335,259,'ГОТОВО К ЗАПУСКУ',11,'#AAC68B',600)
text(312,330,'Твой мир.',46,weight=600)
text(312,386,'Твои правила.',46,weight=600)
text(314,424,'Новые истории начинаются с одного блока.',16,'#C1CDBF')
panel('buttons/primary-default@2x.png',310,474,226,62,16)
icon('play',339,493,24,'dark'); text(383,514,'Играть',22,'#101612',600)
panel('buttons/secondary-default@2x.png',548,480,224,50,16)
text(565,512,'Vanilla · 1.21',15); icon('chevron-down',737,495,20,'muted')
icon('monitor',314,568,16,'muted'); text(339,581,'Java Edition',12,'#A0AEA1')
text(450,581,'•',12,'#718574'); text(468,581,'4 ГБ памяти',12,'#A0AEA1')

text(280,688,'Мои сборки',22,weight=600)
icon('plus',1390,669,20,'accent'); text(1420,685,'Создать',14,'#AAC68B')
for x,label,sub,tag,selected in [(280,'Vanilla','Чистый Minecraft','1.21',True),(710,'Моя сборка','Твоя коллекция модов','Fabric',False)]:
    panel('panels/card@2x.png',x,710,414,132,20)
    image('placeholders/instance.svg',x+20,734,64,64)
    text(x+102,750,label,19,weight=600)
    text(x+102,776,sub,13,'#A0AEA1')
    text(x+102,806,tag,12,'#AAC68B')
    icon('more-horizontal',x+369,731,22,'muted')
    if selected:
        image('status/online.svg',x+333,797,12,12); text(x+351,808,'Выбрана',11,'#A0AEA1')
panel('panels/card@2x.png',1140,710,412,132,20)
icon('news',1162,734,24,'accent')
text(1200,754,'Новости MossLauncher',18,weight=600)
text(1162,790,'Сборки, обновления и всё важное',14,'#A0AEA1')
text(1162,813,'для твоего следующего запуска.',14,'#A0AEA1')
icon('chevron-right',1506,736,20,'muted')
line(280,882,1552,882)
icon('shield',282,906,18,'accent'); text(311,921,'Файлы сборки проверены',13,'#A0AEA1')
icon('folder-open',1226,906,18,'muted'); text(1257,921,'Открыть папку игры',13,'#A0AEA1')
text(282,974,'MossLauncher',11,'#718574'); text(1396,974,'JAVA EDITION',11,'#718574',600)
doc=f'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">'+''.join(parts)+'</svg>'
(OUT/'home-screen.svg').write_text(doc,encoding='utf-8')
for scale in (1,2):
    dest=OUT/('home-screen'+('@2x' if scale==2 else '')+'.png')
    dest.write_bytes(resvg_py.svg_to_bytes(svg_string=doc,width=1600*scale,height=1000*scale))
    with Image.open(dest) as im: im.verify()
manifest_path=A/'manifest.json'
m=json.loads(manifest_path.read_text(encoding='utf-8'))
m['assets']=[item for item in m['assets'] if item['name']!='screens/home-screen']
m['assets'].append(dict(name='screens/home-screen',width=1600,height=1000,category='screen',description='Статический макет главного экрана из текущих ассетов. Названия сборок, профиль и статусы — демонстрационные.',files=['screens/home-screen.svg','screens/home-screen.png','screens/home-screen@2x.png']))
manifest_path.write_text(json.dumps(m,ensure_ascii=False,indent=2),encoding='utf-8')
readme=A/'README.md'; content=readme.read_text(encoding='utf-8')
addition='\n## Главный экран\n\nscreens/home-screen.png — макет 1600×1000, home-screen@2x.png — 3200×2000. home-screen.svg — самостоятельная композиция со встроенными ассетами; для текста используется Segoe UI. Создан из текущего набора: иконки, логотип, кнопки, панели, заглушки и forest-mist.png. Данные профиля, сборки и статусы демонстрационные. Это статический визуальный макет.\n'
if '## Главный экран' not in content: readme.write_text(content+addition,encoding='utf-8')
with zipfile.ZipFile(ROOT/'assets/MossLauncher-Complete-Assets.zip','w',zipfile.ZIP_DEFLATED) as z:
    for p in A.rglob('*'):
        if p.is_file(): z.write(p,p.relative_to(A.parent))
print('Saved home screen: 1600x1000 + 3200x2000 PNG, SVG; updated manifest, README and ZIP.')
