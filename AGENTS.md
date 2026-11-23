# Incremental fieldnotes updates

Use these instructions after the first collection. Keep raw inputs, private state, and generated builds local.

## Layout

- `.fieldnotes/raw/<snapshot>-<source>.jsonl` — private raw snapshots, one per source and run.
- `.fieldnotes/public-id-seed` — private HMAC seed for public archive IDs.
- `.fieldnotes/labels.sqlite` — cached Jev labels.
- `dist/` — generated site. Never hand-edit it.

`collect` refuses to write to an existing path. Never reuse or overwrite a prior snapshot.

## 1. Collect a fresh snapshot per source

Run one `collect` per source into a new dated file. Adapters are read-only; they do not modify agent history.

```sh
SNAP=$(date +%F-%H%M%S)
mkdir -p .fieldnotes/raw

python3 pipeline/fieldnotes.py collect --codex "$HOME/.codex" \
  --out ".fieldnotes/raw/$SNAP-codex.jsonl"

python3 pipeline/fieldnotes.py collect --claude "$HOME/.claude/projects" \
  --out ".fieldnotes/raw/$SNAP-claude.jsonl"

# Set CURSOR_DB to the local Cursor state database, for example state.vscdb.
python3 pipeline/fieldnotes.py collect --cursor "$CURSOR_DB" \
  --out ".fieldnotes/raw/$SNAP-cursor.jsonl"
```

Skip sources that do not exist. A fresh snapshot may contain old events; that is expected and handled by deduplication.

## 2. Add custom adapter output

Custom adapters must be read-only and emit normalized JSON Lines per `FORMAT.md`. Write their output into the same snapshot directory, for example `.fieldnotes/raw/$SNAP-custom.jsonl`; the input list in step 3 includes it automatically. Do not edit or rewrite a raw snapshot after collection.

Keep IDs stable and deterministic: namespace prompt IDs by app, and derive IDs from the source app, native conversation ID, and native message ID (the copied-history signature). Re-importing a copied conversation then produces the same IDs instead of a duplicate history. Do not invent random IDs or hash prompt text to force deduplication.

## 3. Build from every snapshot

Pass every saved snapshot with a separate `--input`, including the initial export and any custom adapter output. Always use the same `--private` directory. Generate the list from the snapshot directory once, so later refreshes cannot silently drop older history:

```sh
INPUTS=()
for file in .fieldnotes/raw/*.jsonl; do
  [ -f "$file" ] || continue
  INPUTS+=(--input "$file")
done
```

Review build without Jev (redacts and exports excerpts for inspection):

```sh
.venv/bin/python pipeline/fieldnotes.py build \
  "${INPUTS[@]}" \
  --private .fieldnotes \
  --timezone America/New_York \
  --pii-model fastino/gliner2-privacy-filter-PII-multi \
  --include-prompts
```

Labeled build:

```sh
.venv/bin/python pipeline/fieldnotes.py build \
  "${INPUTS[@]}" \
  --private .fieldnotes \
  --timezone America/New_York \
  --pii-model fastino/gliner2-privacy-filter-PII-multi \
  --include-prompts \
  --jev
```

For aggregate telemetry only, drop `--include-prompts`. Only write snapshot files for sources you actually collected; the loop passes every `.jsonl` in the snapshot directory, including older runs. `--pii-model` is mandatory with `--include-prompts` or `--jev`.

## 4. Deduplication

The build normalizes records by `(app, kind, id)`, merges streaming response frames for the same conversation, and aborts if prompt IDs are not globally unique. Do not pre-trim or merge snapshots by hand; pass the full set every time.

A copied conversation keeps its native IDs only when it is truly the same history. If the copy has new session or message IDs, it is a separate thread and should remain separate.

## 5. Preserve private state

- Never delete, regenerate, or commit `.fieldnotes/public-id-seed`. Public prompt and conversation IDs are HMACs of the seed; losing it breaks every published archive URL. Back it up outside the repository.
- Keep `.fieldnotes/labels.sqlite` between runs. Jev caches labels by redacted payload, model, and rubric, so unchanged inputs avoid new API calls. Changed text, `JEV_MODEL`, or rubric questions produce cache misses and new labels.
- Keep `TYPESAFE_API_KEY` in the environment only.

## 6. Rescrub before new labeling

Every build re-redacts prompt text locally; never label raw text and never reuse cleaned text from an earlier snapshot. Run the review build in step 3 first, then the `--jev` build. The labeler refuses input that still contains credential patterns. Check `withheld_texts` in `dist/metrics.json` and inspect `dist/prompts-*.json` for missed secrets or private context before enabling labeling.

## 7. Review coverage and excerpts

Before publishing, compare against the previous build:

- Snapshot date, app list, total prompts, total threads, and `cleaned_texts`/`withheld_texts`.
- New or changed excerpts in `dist/prompts-*.json`; review each one manually. Redaction can miss secrets.
- Label distribution and monthly coverage; sparse months and unsupported telemetry must stay unavailable.
- The generated Usage and Method views, which state what each source supports.

Do not publish an unreviewed excerpt. Cursor currently reports prompt activity only.

## 8. Rebuild dist atomically

Always rebuild with `build`; it stages the site in a temporary directory and renames it into place. Never copy files into `dist/`, edit `dist/` in place, or remove `dist/.fieldnotes-build`. If a build fails, fix the input and rerun the full build.

## 9. Keep private data out of Git

`.fieldnotes/`, `dist/`, `*.jsonl`, SQLite files, and `.env*` are ignored. Never force-add them, paste raw logs or credentials into tracked files, or commit generated artifacts. Commit adapter code and reviewed source changes only.
