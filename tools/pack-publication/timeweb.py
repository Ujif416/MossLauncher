"""Publish verified, deduplicated objects first and the public catalog last."""
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3
from botocore.config import Config

BUCKET = '16ea7843-721c-40d2-8233-7e888b857134'


def publish():
    if not all(os.environ.get(name) for name in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY')):
        raise SystemExit('Configure TWC_ACCESS_KEY_ID and TWC_SECRET_ACCESS_KEY in GitHub Actions.')
    s3 = boto3.client('s3', endpoint_url='https://s3.twcstorage.ru', region_name='ru-1',
                      config=Config(s3={'addressing_style': 'path'}, request_checksum_calculation='when_required'))
    catalog = Path('launcher/servers.json').read_bytes()
    server = next(s for s in json.loads(catalog)['servers'] if s['id'] == 'create-skybound')
    pack = server['pack']
    index = Path('pack-index.json').read_bytes()
    if hashlib.sha256(index).hexdigest() != pack['indexSha256']:
        raise ValueError('Catalog and pack index differ')
    existing = {}
    pages = s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix='objects/')
    for page in pages:
        existing.update({obj['Key']: obj['Size'] for obj in page.get('Contents', [])})

    def upload(entry):
        key = 'objects/' + entry['sha256']
        if existing.get(key) == entry['size']:
            return
        data = (Path('pack') / entry['path']).read_bytes()
        if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('Invalid pack file: ' + entry['path'])
        s3.put_object(Bucket=BUCKET, Key=key, Body=data)

    entries = {item['sha256']: item for item in json.loads(index)['files']}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for _ in pool.map(upload, entries.values()):
            pass
    s3.put_object(Bucket=BUCKET, Key=pack['commit'] + '/pack-index.json', Body=index,
                  ContentType='application/json')
    for asset in Path('release').iterdir():
        s3.upload_file(str(asset), BUCKET, 'launcher/releases/1.0.15/' + asset.name)
    s3.put_object(Bucket=BUCKET, Key='launcher/servers.json', Body=catalog,
                  ContentType='application/json', CacheControl='no-cache')
    print('Published', server['packRevision'], 'with', len(entries), 'unique files')


if __name__ == '__main__':
    publish()
