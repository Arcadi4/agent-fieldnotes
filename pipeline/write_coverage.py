"""Write the public, aggregate coverage summary consumed by the Method view."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--unavailable', action='append', default=[])
    options = parser.parse_args()
    source = json.loads(options.input.read_text())
    options.out.parent.mkdir(parents=True, exist_ok=True)
    options.out.write_text(json.dumps({'apps': source['coverage'], 'unavailable': options.unavailable},
                                      separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
