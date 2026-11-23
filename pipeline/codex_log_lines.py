"""Open retained Codex rollout logs, including compressed history."""
from contextlib import contextmanager
import subprocess

@contextmanager
def rollout_lines(path):
    if path.suffix!='.zst':
        with path.open('rb') as stream:
            yield stream
        return
    # Large migrated rollouts can be streamed without creating a decompressed copy.
    with subprocess.Popen(['zstd','-qdc','--',str(path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE) as reader:
        try:
            yield reader.stdout
        finally:
            if reader.stdout.peek(1):
                reader.terminate()  # The root is outside the retained archive.
            else:
                message=reader.stderr.read()
                if reader.wait()!=0:
                    raise RuntimeError(f'Could not read compressed Codex rollout: {message.decode(errors="replace")}')
