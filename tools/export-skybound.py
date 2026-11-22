from pathlib import Path
import shutil, hashlib, json, re

source = Path(r'H:\Apps\Modrinth App\profiles\Create Aeronautics - Skybound')
dest = Path(__file__).resolve().parents[1] / 'exports' / 'Create-Aeronautics-Skybound'
pack = dest / 'pack'
allowed = ['mods', 'config', 'defaultconfigs', 'kubejs', 'datapacks', 'moonlight-global-datapacks', 'resourcepacks', 'shaderpacks']
excluded = ['config/jei/world/', 'config/fancymenu/user_variables.db', 'config/resourceful-config-web.json', 'config/sodium-fingerprint.json', 'kubejs/config/web_server.json', 'config/skinrestorer/mojang_profile_cache.json', 'config/voicechat/username-cache.json']
records = []
for folder in allowed:
    for file in sorted((source / folder).rglob('*')):
        if not file.is_file(): continue
        rel = file.relative_to(source).as_posix()
        if '.bak' in file.name or file.suffix in ['.log', '.tmp', '.old', '.db'] or any(rel.startswith(x) for x in excluded): continue
        target = pack / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)
        records.append({'path': rel, 'size': target.stat().st_size, 'sha256': hashlib.file_digest(target.open('rb'), 'sha256').hexdigest()})
manifest = {'name': 'Create Aeronautics - Skybound', 'minecraft': '1.21.1', 'loader': 'neoforge', 'loaderVersion': '21.1.259', 'java': 21, 'files': records}
(dest / 'pack-index.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
(dest / '.gitattributes').write_text('* -text\n/README.md text eol=lf\n/Install-MossPack.ps1 text eol=crlf\n/pack-index.json text eol=lf\n', encoding='utf-8')
print(json.dumps({'destination': str(dest), 'files': len(records), 'bytes': sum(r['size'] for r in records), 'oversize': [r['path'] for r in records if r['size'] >= 100*1024*1024]}))
# Report suspicious populated credential fields without printing their values.
suspects = []
for f in (pack/'config').rglob('*'):
    if not f.is_file() or f.stat().st_size > 2_000_000: continue
    try: content = f.read_text(encoding='utf-8')
    except (UnicodeError, OSError): continue
    for line in content.splitlines():
        if re.search(r'(?i)["\s](?:auth|token|password|secret|api_?key|webhook)["\s]*[:=]\s*"[^"\s]+"', line):
            suspects.append(f.relative_to(pack).as_posix()); break
print(json.dumps({'credential_fields_to_review': suspects}))
