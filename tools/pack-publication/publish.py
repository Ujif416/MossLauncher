"""Generate a pinned pack release. Run only in the distribution repository."""
import hashlib
import json
import pathlib
import re
import subprocess

def git(*args):
    return subprocess.check_output(['git', *args]).decode().strip()

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def publish():
    catalog_path = pathlib.Path('launcher/servers.json')
    catalog = json.loads(catalog_path.read_text('utf-8'))
    server = next(s for s in catalog['servers'] if s['id'] == 'create-skybound')
    roots = {'mods', 'config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks'}
    files, seen = [], set()
    entries = subprocess.check_output(['git', 'ls-tree', '-rz', 'HEAD', '--', 'pack/']).split(b'\0')
    for entry in entries:
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        if not metadata.startswith(b'100644 blob ') and not metadata.startswith(b'100755 blob '):
            raise ValueError('Only regular files may be published')
        full = raw_path.decode('utf-8')
        name = full.removeprefix('pack/')
        parts = name.split('/')
        if parts[0] not in roots:
            raise ValueError('Unsupported pack directory: ' + name)
        if len(name) > 230 or any(not p or p in {'.', '..'} or p.endswith(('.', ' ')) or re.search(r'[\\<>:"|?*\x00-\x1f]', p) or re.match(r'(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)', p) for p in parts):
            raise ValueError('Unsafe path: ' + name)
        if name.lower() in seen:
            raise ValueError('Duplicate path: ' + name)
        seen.add(name.lower())
        file = pathlib.Path(full)
        size = file.stat().st_size
        if size > 1024 ** 3:
            raise ValueError('File too large: ' + name)
        files.append(dict(path=name, size=size, sha256=digest(file)))
    if not files or len(files) > 20000 or sum(f['size'] for f in files) > 20 * 1024 ** 3:
        raise ValueError('Invalid pack size')
    files.sort(key=lambda f: f['path'])
    index = dict(name=server['name'], minecraft=server['minecraft'], loader=server['loader']['type'], loaderVersion=server['loader']['version'], java=server['java'], files=files)
    index_path = pathlib.Path('pack-index.json')
    index_path.write_bytes((json.dumps(index, ensure_ascii=False, indent=2) + '\n').encode())
    git('add', 'pack-index.json')
    if subprocess.call(['git', 'diff', '--cached', '--quiet']) != 0:
        git('commit', '-m', 'Update client pack index [automated]')
    # This commit already contains every payload file and the generated index.
    commit = git('rev-parse', 'HEAD')
    server['pack']['commit'] = commit
    server['pack']['indexSha256'] = digest(index_path)
    by_path = {f['path']: f for f in files}
    server['pack']['exclude'] = [f for f in server['pack'].get('exclude', []) if by_path.get(f['path'], {}).get('sha256') == f['sha256']]
    server['packRevision'] = 'auto-' + commit[:16]
    catalog['catalogRevision'] = server['packRevision']
    catalog_path.write_bytes((json.dumps(catalog, ensure_ascii=False, indent=2) + '\n').encode())
    git('add', 'launcher/servers.json')
    if subprocess.call(['git', 'diff', '--cached', '--quiet']) != 0:
        git('commit', '-m', 'Publish client pack revision [automated]')
    print('Published revision:', server['packRevision'], 'files:', len(files))

if __name__ == '__main__':
    publish()
