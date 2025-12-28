# Tagger: blog hashtag generator

This folder contains a deterministic tagger for Markdown posts. It generates frontmatter `hashtags` from post content and appends them without deleting anything.

## Behaviour

* Scans blog Markdown posts under `contentDir` (or `contentGlob` if set).
* Parses YAML frontmatter via `gray-matter`.
* Generates candidate hashtags from:
  * `title` (frontmatter), or the file name as fallback
  * Markdown headings
  * existing `tags` (optional candidates only)
  * top keywords in the post body (code blocks removed)
* Normalises candidates into slugs:
  * lower-case
  * `a-z0-9` plus `-`
  * no leading `#`
* Reuses existing hashtags through a generated cache file:
  * candidates are mapped onto existing cache entries using token overlap (Jaccard similarity)
  * deterministic (no Levenshtein)
* Writes `hashtags` as an array into frontmatter only if new hashtags were added.

## Rules

* `hashtags` is always an array.
* Existing `hashtags` are never deleted.
* `tags` are never modified.
* Denylist applies only to newly generated hashtags:
  * denylisted values already present in frontmatter are kept
* Warnings:
  * if the final list is below `min` or equals `1`, a verbose warning is printed
  * warning includes "manual suggestions" that were generated but not added

## Configuration

File: `src/scripts/tagger/tagger.config.json`

Keys (all optional):

* `contentDir` (string): directory scanned by default
* `contentGlob` (string|null): if set, overrides directory scanning with an explicit glob
* `min` (number): minimum expected hashtags for a good post
* `max` (number): maximum hashtags stored in frontmatter
* `denylist` (string[]): values excluded from newly generated hashtags
* `denylistMode` ("exact" | "glob"):
  * `exact` matches a full slug
  * `glob` supports `*` and `?` patterns (case-insensitive)
* `cacheFile` (string): cache file path
* `cacheSimilarityThreshold` (number 0..1): how strongly a candidate must match to map onto a cache entry
* `verboseRemapLimit` (number): remap lines printed in `--verbose`
* `warningSuggestionLimit` (number): how many manual suggestions to print in warnings
* `candidateLimit` (number): cap candidate sources (pre-slug)
* `keywordLimit` (number): top keywords from body text (pre-slug)
* `extraWordScanLimit` (number): reserved setting

## Cache

Cache file is generated and should not be committed.

File: `src/scripts/tagger/.hashtags-cache.json`

Rebuild it any time:

* `node src/scripts/tagger/add-hashtags.ts --cache-rebuild --write`

## CLI

Dry run and verbose output:

* `node src/scripts/tagger/add-hashtags.ts --dry-run --verbose`

Write changes:

* `node src/scripts/tagger/add-hashtags.ts --write --verbose`

Process a single file:

* `node src/scripts/tagger/add-hashtags.ts --file src/content/blog/2025/example.md --dry-run --verbose`

Rebuild cache from existing frontmatter hashtags:

* `node src/scripts/tagger/add-hashtags.ts --cache-rebuild --write`
