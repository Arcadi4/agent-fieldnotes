"""Label redacted payloads with TypeSafe Jev through OpenRouter Decisions."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
MODEL = 'typesafe/jev-1.14'


def credential(path):
    data = json.loads(Path(path).read_text())
    for entry in data.get('credentials', []):
        if entry.get('provider') == 'openrouter':
            value = entry.get('credential', {})
            key = value.get('key') or value.get('apiKey') or value.get('token')
            if key:
                return key
    raise RuntimeError('No OpenRouter credential in the private auth export')


def label(item, key):
    body = json.dumps({'model': MODEL,
                       'state': item['state'],
                       'questions': item['questions']}, separators=(',', ':')).encode()
    request = Request(ENDPOINT, data=body, headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    for attempt in range(4):
        try:
            with urlopen(request, timeout=90) as response:
                result = json.load(response)
            answers = result.get('answers') or {}
            return {name: answer['choice'] for name, answer in answers.items()}
        except HTTPError as error:
            if error.code not in {429, 500, 502, 503, 504} or attempt == 3:
                raise RuntimeError(f'Jev HTTP {error.code}') from None
        except (URLError, TimeoutError):
            if attempt == 3:
                raise RuntimeError('Jev request failed') from None
        time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pending', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--key-file', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=24)
    parser.add_argument('--limit', type=int)
    options = parser.parse_args()
    pending = json.loads(options.pending.read_text())
    items = [(kind, key, value) for kind, group in pending.items() for key, value in group.items()]
    if options.limit:
        items = items[:options.limit]
    key = credential(options.key_file)
    labels = json.loads(options.out.read_text()) if options.out.exists() else {}
    todo = [(kind, cache_key, value) for kind, cache_key, value in items if cache_key not in labels]
    failed = {}
    started = time.time()
    with ThreadPoolExecutor(max_workers=options.workers) as pool:
        futures = {pool.submit(label, value, key): (cache_key, value)
                   for _, cache_key, value in todo}
        for done, future in enumerate(as_completed(futures), 1):
            cache_key, value = futures[future]
            try:
                labels[cache_key] = future.result()
            except Exception as error:
                failed[cache_key] = str(error)[:120]
            if done % 1000 == 0:
                print(f'labeled {done}/{len(todo)}', flush=True)
    options.out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = options.out.with_suffix('.tmp')
    with open(tmp, 'w', opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        json.dump(labels, stream, separators=(',', ':'))
    os.replace(tmp, options.out)
    print(f'Labeled {len(todo) - len(failed)} payloads in {time.time() - started:.0f}s; '
          f'failed {len(failed)}; total cached {len(labels)}.')
    if failed:
        print('first failures:', list(failed.items())[:3])


if __name__ == '__main__':
    main()
