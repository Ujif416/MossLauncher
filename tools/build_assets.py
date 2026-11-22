"""Build MossLauncher artwork only; no application code."""
from pathlib import Path
import sys, json, shutil, zipfile, math
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.asset-tools'))
import resvg_py
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'mosslauncher-complete'
OUT.mkdir(parents=True, exist_ok=True)
manifest = []
C = dict(background='#101612', surface='#1B241E', raised='#253129', border='#3B4B3E', text='#EFF3E9', muted='#A0AEA1', accent='#AAC68B', hover='#C1D6AB', pressed='#8CA970', disabled='#546056', danger='#DB8580', warning='#DEBD78', info='#8EB6D0')

def svg(w,h,body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{body}</svg>'

def rect(x,y,w,h,r,fill,stroke='none',sw=1):
    if fill == 'none' and stroke == 'none': stroke, sw = 'inherit', 1.7
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'

def path(d): return f'<path d="{d}"/>'
def circle(x,y,r): return f'<circle cx="{x}" cy="{y}" r="{r}"/>'

def save(name,w,h,body,category,description,scales=(1,2)):
    source=svg(w,h,body)
    base=OUT/name
    base.parent.mkdir(parents=True,exist_ok=True)
    base.with_suffix('.svg').write_text(source,encoding='utf-8')
    files=[str(base.with_suffix('.svg').relative_to(OUT)).replace('\\','/')]
    for scale in scales:
        dest=base.parent/(base.name+('' if scale==1 else f'@{scale}x')+'.png')
        dest.write_bytes(resvg_py.svg_to_bytes(svg_string=source,width=w*scale,height=h*scale))
        files.append(str(dest.relative_to(OUT)).replace('\\','/'))
    manifest.append(dict(name=name,width=w,height=h,category=category,description=description,files=files))

# Original 24px line icon system. Stroke 1.7px, round terminals.
I={
 'home':path('M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z'),
 'play':path('m8 4 12 8-12 8Z'),
 'pause':path('M8 5v14M16 5v14'),
 'stop':rect(5,5,14,14,2,'none'),
 'restart':path('M20 10a8 8 0 1 0-1 7M20 4v6h-6'),
 'download':path('M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'),
 'upload':path('M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5'),
 'install':path('M12 3v12m-4-4 4 4 4-4M4 7H2v14h20V7h-2'),
 'update':path('M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6M4 14a8 8 0 0 0 14 4l3-3m0 6v-6h-6'),
 'folder':path('M3 6h6l2 3h10v11H3Z'),
 'folder-open':path('M3 12V6h6l2 3h9v3M3 12h19l-3 8H2Z'),
 'file':path('M5 3h9l5 5v13H5ZM14 3v6h5M8 13h8m-8 4h6'),
 'instances':path('m12 2 9 5v10l-9 5-9-5V7Zm-9 5 9 5 9-5M12 12v10'),
 'mods':path('M4 4h6V2a2 2 0 0 1 4 0v2h6v6h2a2 2 0 0 1 0 4h-2v6h-6v-2a2 2 0 0 0-4 0v2H4v-6h2a2 2 0 0 0 0-4H4Z'),
 'resource-pack':path('M3 7h18v14H3ZM2 3h20v4H2ZM9 11h6'),
 'shader':path('m12 2 10 10-10 10L2 12ZM12 2v20M2 12h20'),
 'world':circle(12,12,9)+path('M3 12h18M12 3c-6 5-6 13 0 18 6-5 6-13 0-18Z'),
 'servers':rect(3,3,18,7,2,'none')+rect(3,14,18,7,2,'none')+path('M7 6.5h.1m0 11h.1M11 6.5h6m-6 11h6'),
 'news':rect(3,4,18,16,2,'none')+rect(6,7,5,5,1,'none')+path('M14 8h4m-4 4h4M6 16h12'),
 'settings':path('m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z')+circle(12,12,3),
 'account':circle(12,8,4)+path('M4 21v-2a8 8 0 0 1 16 0v2'),
 'accounts':circle(9,8,3)+path('M2 20v-2a7 7 0 0 1 14 0v2M16 5a3 3 0 0 1 0 6m2 3a6 6 0 0 1 4 6'),
 'login':path('M14 3h7v18h-7M3 12h12m-4-4 4 4-4 4'),
 'logout':path('M10 3H3v18h7m0-9h11m-4-4 4 4-4 4'),
 'plus':path('M12 4v16M4 12h16'),
 'minus':path('M4 12h16'),
 'close':path('m6 6 12 12M18 6 6 18'),
 'check':path('m4 12 5 5L20 6'),
 'search':circle(10.5,10.5,6.5)+path('m16 16 5 5'),
 'filter':path('M3 4h18l-7 8v7l-4 2v-9Z'),
 'sort':path('M3 6h18M3 12h12M3 18h6'),
 'grid':''.join(rect(x,y,6,6,1,'none') for x in (3,15) for y in (3,15)),
 'list':path('M9 5h12M9 12h12M9 19h12M3 5h.1M3 12h.1M3 19h.1'),
 'edit':path('m15 3 6 6-12 12H3v-6Zm-2 2 6 6'),
 'delete':path('M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7'),
 'copy':rect(8,8,13,13,2,'none')+path('M16 8V3H3v13h5'),
 'duplicate':rect(3,3,12,12,2,'none')+rect(9,9,12,12,2,'none'),
 'export':path('M14 3h7v7M21 3 10 14M10 5H3v16h16v-7'),
 'import':path('M3 3h7m-7 0v7m0-7 11 11M14 5h7v16H5v-7'),
 'external-link':path('M14 3h7v7M21 3 10 14M10 5H3v16h16v-7'),
 'link':path('m10 14 4-4M9 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-2 2'),
 'chevron-left':path('m15 5-7 7 7 7'),
 'chevron-right':path('m9 5 7 7-7 7'),
 'chevron-down':path('m5 9 7 7 7-7'),
 'chevron-up':path('m5 15 7-7 7 7'),
 'arrow-left':path('M20 12H4m7-7-7 7 7 7'),
 'arrow-right':path('M4 12h16m-7-7 7 7-7 7'),
 'more-horizontal':''.join(circle(x,12,1) for x in (5,12,19)),
 'more-vertical':''.join(circle(12,y,1) for y in (5,12,19)),
 'minimize':path('M5 17h14'),
 'maximize':rect(4,4,16,16,1,'none'),
 'restore':path('M8 8V3h13v13h-5')+rect(3,8,13,13,1,'none'),
 'fullscreen':path('M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6'),
 'info':circle(12,12,9)+path('M12 11v6m0-10h.01'),
 'help':circle(12,12,9)+path('M9 8a3 3 0 1 1 4 3c-1 1-1 1-1 3m0 3h.01'),
 'warning':path('m12 3 10 18H2ZM12 9v5m0 3h.01'),
 'error':circle(12,12,9)+path('m8 8 8 8m0-8-8 8'),
 'success':circle(12,12,9)+path('m7 12 3 3 7-7'),
 'notification':path('M5 17h14l-2-4V9a5 5 0 0 0-10 0v4ZM10 21h4'),
 'shield':path('m12 2 9 4v6c0 5-6 8-9 10-3-2-9-5-9-10V6Z')+path('m8 12 3 3 5-6'),
 'lock':rect(5,10,14,11,2,'none')+path('M8 10V7a4 4 0 0 1 8 0v3'),
 'unlock':rect(5,10,14,11,2,'none')+path('M8 10V7a4 4 0 0 1 8 0'),
 'eye':path('M2 12c5-9 15-9 20 0-5 9-15 9-20 0Z')+circle(12,12,3),
 'eye-off':path('m3 3 18 18M9 5c5-2 10 1 13 7a17 17 0 0 1-4 5M6 6a18 18 0 0 0-4 6c3 6 8 9 14 6'),
 'favorite':path('m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z'),
 'pin':path('m8 3 13 13-5 1-3 3-3-6-6-3 3-3ZM10 14l-7 7'),
 'clock':circle(12,12,9)+path('M12 6v6l4 3'),
 'calendar':rect(3,5,18,16,2,'none')+path('M7 3v4m10-4v4M3 10h18'),
 'history':path('M3 11a9 9 0 1 1 2 7M3 4v7h7M12 6v6l4 3'),
 'terminal':rect(2,4,20,16,2,'none')+path('m6 9 4 3-4 3m7 0h5'),
 'logs':path('M5 3h14v18H5ZM8 7h8M8 11h8M8 15h5'),
 'bug':rect(7,7,10,13,4,'none')+path('M9 7 7 3m8 4 2-4M3 9h4m10 0h4M3 14h4m10 0h4M4 20l3-3m10 0 3 3M12 8v12'),
 'repair':path('M14 3a6 6 0 0 0-7 8L2 16a4 4 0 0 0 6 6l5-5a6 6 0 0 0 8-7l-4 4-5-5Z'),
 'java':path('M6 12h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4ZM18 13h2a3 3 0 0 1-2 6M9 9c-4-3 4-3 0-6m5 6c-4-3 4-3 0-6'),
 'memory':rect(3,7,18,10,1,'none')+path('M6 10v4m4-4v4m4-4v4m4-4v4M6 17v4m4-4v4m4-4v4m4-4v4'),
 'cpu':rect(6,6,12,12,2,'none')+rect(9,9,6,6,1,'none')+path('M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4'),
 'monitor':rect(2,3,20,14,2,'none')+path('M12 17v4M7 21h10'),
 'language':circle(12,12,9)+path('M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z'),
 'sun':circle(12,12,4)+path('M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2'),
 'moon':path('M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z'),
 'volume':path('M3 9h4l5-5v16l-5-5H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14'),
 'mute':path('M3 9h4l5-5v16l-5-5H3Zm13 0 6 6m0-6-6 6'),
 'wifi':path('M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01'),
 'offline':path('M3 3 21 21M2 8a16 16 0 0 1 4-2m4-1a16 16 0 0 1 12 3M5 12a11 11 0 0 1 6-2m4 0a11 11 0 0 1 4 2M8 16a6 6 0 0 1 8 0M12 20h.01'),
 'cloud':path('M6 19a5 5 0 0 1-1-10 7 7 0 0 1 13-2 6 6 0 0 1 0 12Z'),
 'sync':path('M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6M4 14a8 8 0 0 0 14 4l3-3m0 6v-6h-6'),
 'save':path('M3 3h15l3 3v15H3ZM7 3v6h10V3M7 21v-8h10v8'),
 'image':rect(3,3,18,18,2,'none')+circle(8,8,2)+path('m3 17 5-5 4 4 4-6 5 7'),
 'skin':path('m8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0Z'),
 'screenshot':rect(2,6,20,15,2,'none')+path('m7 6 2-4h6l2 4')+circle(12,13,4),
 'gamepad':path('M7 7h10c4 0 7 13 3 13l-5-4H9l-5 4C0 20 3 7 7 7Z')+path('M7 10v5m-2-2.5h4m6-1.5h.1m3 3h.1'),
 'rocket':path('M9 15c-1-7 5-12 12-12 0 7-5 13-12 12ZM9 9H4l-2 6h7m6 0v5l-6 2v-7M6 18l-3 3')+circle(16,8,2),
 'leaf':path('M4 20C-2 6 9 2 21 3c0 13-5 20-17 17ZM4 20 16 8'),
 'heart':path('M12 21 3 12C-3 3 8-1 12 6c4-7 15-3 9 6Z'),
 'keyboard':rect(2,5,20,14,2,'none')+path('M5 9h.1m3 0h.1m3 0h.1m3 0h.1m3 0h.1M5 13h.1m3 0h.1m3 0h.1m3 0h.1m3 0h.1M7 16h10'),
 'mouse':rect(6,2,12,20,6,'none')+path('M12 2v7M6 10h12'),
 'storage':rect(3,4,18,16,2,'none')+path('M3 14h18M6 17h.1m3 0h.1'),
 'speed':path('M4 20a10 10 0 1 1 16 0M12 12l5-5M5 12H3m9-7V3m7 9h2')+circle(12,12,2),
 'archive':rect(3,7,18,14,2,'none')+rect(2,3,20,4,1,'none')+path('M9 11h6'),
 'check-updates':path('M20 10a8 8 0 1 0-1 7M20 4v6h-6m-6 2 3 3 5-6'),
}

def icon(body,color):
    return f'<g fill="none" stroke="{color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{body}</g>'

for name,body in I.items():
    for state,color in dict(default=C['text'],accent=C['accent'],muted=C['disabled'],dark=C['background']).items():
        save(f'icons/{state}/{name}',24,24,icon(body,color),'icon',f'{name}, {state}',(1,2,3))

for kind in ('primary','secondary','ghost','danger','icon','tab'):
    for state in ('default','hover','pressed','disabled','focus','selected'):
        w,h=(40,40) if kind=='icon' else (200,48)
        fill=C['surface']; stroke=C['border']
        if kind=='primary': fill=C[dict(default='accent',hover='hover',pressed='pressed',disabled='raised',focus='accent',selected='pressed')[state]]; stroke='none'
        elif kind=='danger': fill='#342321'; stroke=C['danger']
        elif kind=='ghost': fill='none'; stroke='none'
        if kind!='primary' and state in ('hover','pressed','selected'): fill=C['raised'] if state=='hover' else '#35452E'; stroke=C['accent'] if state=='selected' else stroke
        if kind=='danger' and state in ('hover','pressed','selected'):
            fill = '#49302D' if state=='hover' else '#542F2C'
            stroke = C['danger']
        if state=='disabled': fill='#1B211D'; stroke='#2D3730'
        body=rect(3,3,w-6,h-6,10,fill,stroke)
        if state=='focus': body+=rect(0.75,0.75,w-1.5,h-1.5,13,'none',C['accent'],1.5)
        save(f'buttons/{kind}-{state}',w,h,body,'button',f'Фон {kind}, {state}; без текста; nine-slice inset 16px')

for name,fill,stroke in [('card',C['surface'],C['border']),('card-hover',C['raised'],'#65785A'),('modal','#1B241E','#4E604E'),('tooltip','#2C392F','#586953'),('dropdown','#202B23',C['border']),('sidebar','#141C16','none'),('toast',C['surface'],C['border']),('selected','#2D3E28',C['accent'])]:
    save('panels/'+name,320,160,rect(1,1,318,158,16,fill,stroke),'panel','Панель без текста; nine-slice inset 20px')

for state in ('default','hover','focus','error','disabled'):
    stroke=dict(default=C['border'],hover='#70866D',focus=C['accent'],error=C['danger'],disabled='#2B352E')[state]
    save('controls/input-'+state,280,44,rect(1,1,278,42,9,C['surface'],stroke),'control','Фон поля ввода без текста')
for state in ('unchecked','checked','mixed','disabled'):
    fill=C['accent'] if state in ('checked','mixed') else C['surface']
    body=rect(3,3,18,18,5,fill,C['disabled'] if state=='disabled' else C['border'])
    if state=='checked': body+=icon(path('m7 12 3 3 7-7'),C['background'])
    if state=='mixed': body+=icon(path('M7 12h10'),C['background'])
    save('controls/checkbox-'+state,24,24,body,'control','Чекбокс '+state)
for state in ('off','on','disabled'):
    body=rect(2,2,44,24,12,C['accent'] if state=='on' else C['raised'])
    body+=f'<circle cx="{34 if state=="on" else 14}" cy="14" r="9" fill="{C["background"] if state=="on" else C["muted"]}"/>'
    save('controls/toggle-'+state,48,28,body,'control','Переключатель '+state)
for state in ('off','on','disabled'):
    body=f'<circle cx="12" cy="12" r="9" fill="{C["surface"]}" stroke="{C["accent"] if state=="on" else C["border"]}" stroke-width="1.5"/>'
    if state=='on': body+=f'<circle cx="12" cy="12" r="5" fill="{C["accent"]}"/>'
    save('controls/radio-'+state,24,24,body,'control','Радиокнопка '+state)
for percent in (0,25,50,75,100):
    body=rect(0,0,240,8,4,C['raised'])
    if percent: body+=rect(0,0,240*percent/100,8,4,C['accent'])
    save(f'controls/progress-{percent}',240,8,body,'control','Прогресс '+str(percent)+'%')
save('controls/slider-track',240,6,rect(0,0,240,6,3,C['raised']),'control','Трек ползунка')
save('controls/slider-fill',240,6,rect(0,0,240,6,3,C['accent']),'control','Активный трек')
save('controls/slider-thumb',24,24,f'<circle cx="12" cy="12" r="9" fill="{C["accent"]}" stroke="{C["background"]}" stroke-width="3"/>','control','Бегунок')
save('controls/scrollbar-track',8,160,rect(1,0,6,160,3,C['surface']),'control','Трек прокрутки')
save('controls/scrollbar-thumb',8,48,rect(1,0,6,48,3,C['disabled']),'control','Бегунок прокрутки')
save('controls/divider',320,1,rect(0,0,320,1,0,C['border']),'control','Разделитель')
for name,color in [('online',C['accent']),('offline',C['disabled']),('warning',C['warning']),('error',C['danger']),('info',C['info'])]:
    save('status/'+name,16,16,f'<circle cx="8" cy="8" r="5" fill="{color}"/>','status',name)
    save('panels/toast-'+name,360,88,rect(1,1,358,86,12,C['surface'],C['border'])+rect(1,14,3,60,1,color),'panel','Уведомление '+name)
for i in range(12):
    parts=''
    for j in range(12):
        a=math.radians(j*30); x=16+10*math.cos(a); y=16+10*math.sin(a)
        parts+=f'<circle cx="{x}" cy="{y}" r="1.7" fill="{C["accent"]}" opacity="{0.15+0.85*((j-i)%12)/11}"/>'
    save(f'loading/frame-{i:02}',32,32,parts,'loading',f'Кадр {i}, 80 ms',(1,2))

mark=path('M10 51V22l17 12 17-12v29H34V40l-7 5-7-5v11Z')+path('M27 31V16c-9 0-12-5-12-11 9 0 12 5 12 11 0-9 6-13 15-13 0 9-5 14-15 13')
for name,color in [('sage',C['accent']),('white',C['text']),('dark',C['background'])]:
    save('branding/mark-'+name,56,56,f'<g fill="{color}">{mark}</g>','brand','Логотип M с ростком',(1,2,4,8))
save('branding/app-icon',256,256,rect(0,0,256,256,56,C['background'])+f'<g transform="translate(32 32) scale(3.42857)" fill="{C["accent"]}">{mark}</g>','brand','Иконка приложения',(1,2,4))
with Image.open(OUT/'branding/app-icon.png') as im:
    im.save(OUT/'branding/mosslauncher.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
for name,icon_name in [('avatar','account'),('instance','instances'),('mod','mods'),('resource-pack','resource-pack'),('shader','shader'),('server','servers'),('skin','skin')]:
    body=rect(0,0,128,128,24,C['surface'])+f'<g transform="translate(28 28) scale(3)">{icon(I[icon_name],C["accent"])}</g>'
    save('placeholders/'+name,128,128,body,'placeholder',name)
for name,icon_name in [('no-instances','instances'),('no-results','search'),('no-downloads','download'),('offline','offline'),('error','repair'),('up-to-date','success')]:
    body=f'<circle cx="160" cy="100" r="72" fill="{C["surface"]}"/>'+f'<g transform="translate(124 64) scale(3)">{icon(I[icon_name],C["accent"])}</g>'
    save('empty-states/'+name,320,200,body,'empty-state',name)

for name,color in [('solid',C['background']),('surface',C['surface'])]:
    save('backgrounds/'+name,1920,1080,rect(0,0,1920,1080,0,color),'background','Сплошной фон',(1,))
save('backgrounds/left-shade',1920,1080,'<defs><linearGradient id="s"><stop stop-color="#101612" stop-opacity=".98"/><stop offset=".5" stop-color="#101612" stop-opacity=".65"/><stop offset="1" stop-color="#101612" stop-opacity="0"/></linearGradient></defs>'+rect(0,0,1920,1080,0,'url(#s)'),'background','Прозрачное затемнение слева',(1,))
save('backgrounds/modal-scrim',1920,1080,'<rect width="1920" height="1080" fill="#050A06" opacity=".75"/>','background','Подложка модального окна',(1,))
for old,new in [('mosslauncher-v2/forest-background.png','forest-mist.png'),('mosslauncher/forest-background.png','forest-sunrise.png')]:
    shutil.copy2(ROOT/'assets'/old,OUT/'backgrounds'/new)
    with Image.open(OUT/'backgrounds'/new) as im:
        manifest.append(dict(name='backgrounds/'+Path(new).stem,width=im.width,height=im.height,category='background',description='Пейзаж, созданный image_gen',files=['backgrounds/'+new]))

# Preview contact sheets, not runtime resources.
font_path='C:/Windows/Fonts/segoeui.ttf'
font=ImageFont.truetype(font_path,14)
titlefont=ImageFont.truetype(font_path,32)
def sheet(filename,items,cellw,cellh,cols):
    rows=math.ceil(len(items)/cols)
    canvas=Image.new('RGB',(cols*cellw,rows*cellh+92),C['background']); d=ImageDraw.Draw(canvas)
    d.text((24,22),'MossLauncher / '+filename,fill=C['text'],font=titlefont)
    for k,(name,imgfile) in enumerate(items):
        x=k%cols*cellw; y=k//cols*cellh+92
        with Image.open(imgfile).convert('RGBA') as im:
            im.thumbnail((cellw-24,cellh-46))
            canvas.paste(im,(x+(cellw-im.width)//2,y+8),im)
        label=name if len(name)<29 else name[:26]+'…'
        d.text((x+10,y+cellh-30),label,fill=C['muted'],font=font)
    canvas.save(OUT/(filename+'.png'))
sheet('CATALOG-ICONS',[(n,OUT/f'icons/default/{n}@3x.png') for n in I],160,120,8)
sheet('CATALOG-COMPONENTS',[(m['name'].split('/')[-1],OUT/m['files'][1]) for m in manifest if m['category'] in ('button','control','status','panel')],260,140,5)
sheet('CATALOG-BRAND',[(m['name'].split('/')[-1],OUT/m['files'][1]) for m in manifest if m['category'] in ('brand','placeholder','empty-state')],280,220,4)
(OUT/'manifest.json').write_text(json.dumps(dict(palette=C,assets=manifest),ensure_ascii=False,indent=2),encoding='utf-8')
counts={}
for m in manifest: counts[m['category']]=counts.get(m['category'],0)+1
(OUT/'README.md').write_text('''# MossLauncher — полный набор UI ассетов

Оригинальная система линейных иконок: сетка 24×24, линия 1.7 px, скруглённые окончания. Палитра тёмного леса и шалфея. Код лаунчера не добавлен.

## Использование

- icons/: каждая иконка отдельно, SVG и прозрачные PNG 24/48/72 px. Четыре цвета: default, accent, muted, dark. Для основных светло-зелёных кнопок используйте dark.
- buttons/: пустые фоны без надписей. Primary, secondary, ghost, danger, icon, tab; состояния default, hover, pressed, disabled, focus, selected. PNG 1×/2× и SVG. Nine-slice inset 16 px в базовых координатах; SVG также можно растянуть без растрирования.
- controls/: поля ввода, чекбоксы, радиокнопки, переключатели, прогресс, ползунки и прокрутка. Текст полей и значения задаются отдельно.
- panels/: карточки, меню, подсказки, модальные окна и уведомления. Nine-slice inset 20 px для основных панелей; toast-* inset 16 px.
- branding/: единый знак M с ростком, иконка приложения и многоразмерный ICO. Это окончательный самостоятельный знак набора; знаки в ранних AI-макетах отличаются.
- placeholders/: заглушки профиля, сборки, модов, ресурсов, шейдеров и серверов.
- empty-states/: пустые состояния без встроенного текста.
- loading/: 12 отдельных кадров индикатора, рекомендуемый шаг 80 ms. Статические PNG/SVG; анимацию включает приложение.
- backgrounds/: два исходных AI-пейзажа, однотонные фоны и прозрачные затемнения. Пейзажи сохранены в исходном размере 1672×941; это не 4K.
- status/: индикаторы подключения, ошибки, предупреждения и информации.

Все PNG компонентов имеют RGBA. Прозрачность там, где необходима: вне контура фигур. Полноэкранные однотонные фоны и пейзажи непрозрачны. Полный список файлов, размеров и назначений — manifest.json. CATALOG-*.png — обзорные листы, не спрайты для нарезки.

Набор покрывает основные экраны и действия Minecraft-лаунчера. Официальные логотипы сторонних сервисов и модлоадеров не включены; для них предусмотрены нейтральные заглушки. Текст иконками не запечён. В SVG нет скриптов, внешних ресурсов или шрифтов.

## Создание

Иконки и компоненты построены как точная векторная графика и растрированы resvg. Фоны ранее созданы встроенным image_gen; исходные промпты находятся в соседних mosslauncher/PROMPTS.md и mosslauncher-v2/PROMPTS.md.

## Состав

'''+''.join(f'- {k}: {v}\n' for k,v in counts.items()),encoding='utf-8')

# Validate XML, raster size and decoding for every exported entry.
import xml.etree.ElementTree as ET
for m in manifest:
    for f in m['files']:
        p=OUT/f
        if p.suffix=='.svg': ET.parse(p)
        else:
            with Image.open(p) as im:
                im.load()
                assert im.width>0 and im.height>0
zip_path=ROOT/'assets'/'MossLauncher-Complete-Assets.zip'
with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED) as z:
    for p in OUT.rglob('*'):
        if p.is_file(): z.write(p,p.relative_to(OUT.parent))
print(json.dumps(dict(icons=len(I),assets=len(manifest),files=sum(1 for p in OUT.rglob('*') if p.is_file()),categories=counts,zip=str(zip_path)),ensure_ascii=False))
