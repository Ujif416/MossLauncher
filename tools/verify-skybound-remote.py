from pathlib import Path
import subprocess, urllib.request, json, os

repo = Path(__file__).resolve().parents[1] / 'exports' / 'Create-Aeronautics-Skybound'
url = 'https://github.com/Ujif416/Create-Aeronautics-Skybound.git'
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
remote = subprocess.check_output(['git', 'ls-remote', url, 'refs/heads/main'], text=True).split()[0]
assert head == remote, 'Remote branch differs from local commit'
credential = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\nusername=Ujif416\n\n', text=True, capture_output=True, env=os.environ | {'GIT_TERMINAL_PROMPT':'0','GCM_INTERACTIVE':'never'}, check=True)
fields = dict(line.split('=',1) for line in credential.stdout.splitlines() if '=' in line)
headers = {'User-Agent': 'MossLauncher-pack-verification', 'Authorization': 'Bearer ' + fields['password']}
req = urllib.request.Request(f'https://api.github.com/repos/Ujif416/Create-Aeronautics-Skybound/git/trees/{head}?recursive=1', headers=headers)
with urllib.request.urlopen(req, timeout=60) as response: tree = json.load(response)
assert not tree.get('truncated'), 'Remote tree was truncated'
actual = {x['path']: x['sha'] for x in tree['tree'] if x['type'] == 'blob'}
expected = {}
for row in subprocess.check_output(['git', 'ls-tree', '-rz', 'HEAD'], cwd=repo).split(b'\0'):
    if not row: continue
    metadata, path = row.split(b'\t', 1)
    expected[path.decode('utf-8')] = metadata.split()[2].decode('ascii')
assert actual == expected, 'Remote tree differs from prepared files'
req = urllib.request.Request('https://codeload.github.com/Ujif416/Create-Aeronautics-Skybound/zip/refs/heads/main', method='HEAD', headers={'User-Agent':'MossLauncher-pack-verification'})
with urllib.request.urlopen(req, timeout=60) as response:
    assert response.status == 200
    archive_status = response.status
print(json.dumps({'commit':head, 'remoteFilesVerified':len(actual), 'codeloadStatus':archive_status}))
