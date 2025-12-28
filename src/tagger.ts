#!/usr/bin/env node
/* eslint-disable no-console */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import fg from 'fast-glob';
import matter from 'gray-matter';
import yaml from 'js-yaml';

type UnknownRecord = Record<string, unknown>;

type DenylistMode = 'exact' | 'glob';

type TaggerConfigFile = {
  /**
   * Directory scanned by default (when --file is not used).
   */
  contentDir?: string;

  /**
   * Glob pattern override.
   * If set, this is used directly instead of combining contentDir with a recursive markdown glob.
   * Example: "src/content/blog/**\\/*.md"
   */
  contentGlob?: string;

  /**
   * Minimum expected hashtags. If the final list is below this, a verbose warning is printed.
   */
  min?: number;

  /**
   * Maximum stored hashtags in frontmatter.
   */
  max?: number;

  /**
   * Denylist entries. Interpreted based on denylistMode.
   */
  denylist?: string[];

  /**
   * Denylist interpretation mode:
   * - "exact": exact slug match (case-insensitive by slug normalisation)
   * - "glob": simple glob patterns such as "astro-*" or "*-js"
   */
  denylistMode?: DenylistMode;

  /**
   * Cache path for reusable hashtag vocabulary.
   */
  cacheFile?: string;

  /**
   * Similarity threshold (0..1) to map candidate to existing cache entry.
   */
  cacheSimilarityThreshold?: number;

  /**
   * How many remap lines to print in verbose mode.
   */
  verboseRemapLimit?: number;

  /**
   * How many "manual suggestions" to print in low-richness warnings.
   */
  warningSuggestionLimit?: number;

  /**
   * Maximum number of candidate sources to consider (pre-slug).
   */
  candidateLimit?: number;

  /**
   * Top keyword budget from body text (pre-slug).
   */
  keywordLimit?: number;

  /**
   * Maximum number of body words considered for extra suggestions.
   */
  extraWordScanLimit?: number;
};

type RequiredTaggerConfig = {
  contentDir: string;
  contentGlob: string | null;
  min: number;
  max: number;
  denylist: string[];
  denylistMode: DenylistMode;
  cacheFile: string;
  cacheSimilarityThreshold: number;
  verboseRemapLimit: number;
  warningSuggestionLimit: number;
  candidateLimit: number;
  keywordLimit: number;
  extraWordScanLimit: number;
};

type CacheFile = {
  version: 1;
  updatedAt: string;
  hashtags: string[];
};

type CliConfig = {
  configFile: string;
  singleFile: string | null;
  dryRun: boolean;
  write: boolean;
  verbose: boolean;
  cacheRebuild: boolean;
};

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'like',
  'may',
  'might',
  'more',
  'most',
  'not',
  'of',
  'on',
  'or',
  'our',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'this',
  'those',
  'to',
  'too',
  'up',
  'use',
  'using',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

function printHelp(): void {
  const msg = `
Usage:
  node src/scripts/tagger/add-hashtags.ts [options]

Options:
  --config <path>         Config JSON (default: src/scripts/tagger/tagger.config.json)
  --file <path>           Process a single markdown file only

  --dry-run               Show changes, do not write files (default: true)
  --write                 Write changes to files

  --cache-rebuild         Rebuild cache from existing frontmatter hashtags (no post edits)
  --verbose               Verbose logging (recommended)
  --help                  Show this help
`;
  console.log(msg.trim());
}

function parseArgs(argv: string[]): CliConfig {
  const cfg: CliConfig = {
    configFile: 'src/scripts/tagger/tagger.config.json',
    singleFile: null,
    dryRun: true,
    write: false,
    verbose: false,
    cacheRebuild: false,
  };

  const getValue = (i: number): string => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`Missing value for ${argv[i] ?? '(unknown)'}`);
    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '--help') {
      printHelp();
      process.exit(0);
    }
    if (a === '--config') cfg.configFile = getValue(i);
    else if (a === '--file') cfg.singleFile = getValue(i);
    else if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--write') {
      cfg.write = true;
      cfg.dryRun = false;
    } else if (a === '--cache-rebuild') cfg.cacheRebuild = true;
    else if (a === '--verbose') cfg.verbose = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
  }

  return cfg;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function uniqueStable(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}

function slugifyHashtag(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .trim()
    .replace(/^#+/g, '')
    .replace(/['"]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!cleaned) return null;
  if (cleaned.length < 2) return null;
  if (STOPWORDS.has(cleaned)) return null;

  return cleaned;
}

function stripCodeBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

function extractHeadings(markdown: string): string[] {
  const lines = markdown.split('\n');
  const headings: string[] = [];
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m && m[2]) headings.push(m[2]);
  }
  return headings;
}

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length >= 3)
    .filter((w) => !STOPWORDS.has(w));
}

function topKeywords(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const w of extractWords(text)) counts.set(w, (counts.get(w) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([w]) => w);
}

function tokeniseSlug(slug: string): Set<string> {
  return new Set(slug.split('-').filter(Boolean));
}

function mapToCache(
  candidate: string,
  cache: string[],
  threshold: number
): { mapped: string; score: number; from: string | null } {
  const candTokens = tokeniseSlug(candidate);
  if (candTokens.size === 0) return { mapped: candidate, score: 0, from: null };

  let best = candidate;
  let bestScore = 0;

  for (const existing of cache) {
    if (existing === candidate) return { mapped: existing, score: 1, from: existing };

    const exTokens = tokeniseSlug(existing);
    if (exTokens.size === 0) continue;

    let inter = 0;
    for (const t of candTokens) if (exTokens.has(t)) inter += 1;

    const union = candTokens.size + exTokens.size - inter;
    const score = union === 0 ? 0 : inter / union;

    if (score > bestScore) {
      bestScore = score;
      best = existing;
    }
  }

  if (bestScore >= threshold) return { mapped: best, score: bestScore, from: best };
  return { mapped: candidate, score: bestScore, from: null };
}

function toYamlFrontmatter(data: UnknownRecord): string {
  const dumped = yaml.dump(data, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  return `---\n${dumped}---\n`;
}

function getTitleFromFrontmatter(fm: UnknownRecord): string | null {
  const title = fm['title'];
  if (typeof title === 'string' && title.trim()) return title.trim();
  return null;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to read JSON: ${filePath}: ${msg}`);
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function clampNumber(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

async function loadConfig(cfgPath: string): Promise<RequiredTaggerConfig> {
  const raw = await readJsonFile<TaggerConfigFile>(cfgPath);
  const defaults: RequiredTaggerConfig = {
    contentDir: 'src/content/blog',
    contentGlob: null,
    min: 3,
    max: 12,
    denylist: [],
    denylistMode: 'exact',
    cacheFile: 'src/scripts/tagger/.hashtags-cache.json',
    cacheSimilarityThreshold: 0.6,
    verboseRemapLimit: 25,
    warningSuggestionLimit: 10,
    candidateLimit: 500,
    keywordLimit: 30,
    extraWordScanLimit: 300,
  };

  if (!raw) return defaults;

  const contentDir =
    typeof raw.contentDir === 'string' && raw.contentDir.trim() ? raw.contentDir.trim() : defaults.contentDir;

  const contentGlob =
    typeof raw.contentGlob === 'string' && raw.contentGlob.trim() ? raw.contentGlob.trim() : defaults.contentGlob;

  const denylist = isStringArray(raw.denylist)
    ? raw.denylist.map((s) => slugifyHashtag(s)).filter((s): s is string => !!s)
    : [];

  const denylistMode: DenylistMode =
    raw.denylistMode === 'glob' || raw.denylistMode === 'exact' ? raw.denylistMode : defaults.denylistMode;

  const min = typeof raw.min === 'number' && Number.isFinite(raw.min) ? raw.min : defaults.min;
  const max = typeof raw.max === 'number' && Number.isFinite(raw.max) ? raw.max : defaults.max;

  const cacheFile = typeof raw.cacheFile === 'string' && raw.cacheFile.trim() ? raw.cacheFile.trim() : defaults.cacheFile;

  const cacheSimilarityThreshold =
    typeof raw.cacheSimilarityThreshold === 'number' && Number.isFinite(raw.cacheSimilarityThreshold)
      ? clampNumber(raw.cacheSimilarityThreshold, 0, 1)
      : defaults.cacheSimilarityThreshold;

  const verboseRemapLimit =
    typeof raw.verboseRemapLimit === 'number' && Number.isFinite(raw.verboseRemapLimit) ? raw.verboseRemapLimit : defaults.verboseRemapLimit;

  const warningSuggestionLimit =
    typeof raw.warningSuggestionLimit === 'number' && Number.isFinite(raw.warningSuggestionLimit)
      ? raw.warningSuggestionLimit
      : defaults.warningSuggestionLimit;

  const candidateLimit =
    typeof raw.candidateLimit === 'number' && Number.isFinite(raw.candidateLimit) ? raw.candidateLimit : defaults.candidateLimit;

  const keywordLimit =
    typeof raw.keywordLimit === 'number' && Number.isFinite(raw.keywordLimit) ? raw.keywordLimit : defaults.keywordLimit;

  const extraWordScanLimit =
    typeof raw.extraWordScanLimit === 'number' && Number.isFinite(raw.extraWordScanLimit)
      ? raw.extraWordScanLimit
      : defaults.extraWordScanLimit;

  if (min < 1) throw new Error(`Config min must be >= 1 (got ${min})`);
  if (max < min) throw new Error(`Config max must be >= min (got ${max})`);

  return {
    contentDir,
    contentGlob,
    min,
    max,
    denylist,
    denylistMode,
    cacheFile,
    cacheSimilarityThreshold,
    verboseRemapLimit,
    warningSuggestionLimit,
    candidateLimit,
    keywordLimit,
    extraWordScanLimit,
  };
}

async function resolveFiles(cfg: CliConfig, conf: RequiredTaggerConfig): Promise<string[]> {
  if (cfg.singleFile) return [cfg.singleFile];

  if (conf.contentGlob) return fg(conf.contentGlob, { dot: false, onlyFiles: true });

  const pattern = path.posix.join(conf.contentDir.replace(/\\/g, '/'), '**/*.md');
  return fg(pattern, { dot: false, onlyFiles: true });
}

async function scanExistingHashtags(files: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(f, 'utf8');
      const parsed = matter(raw);
      const fm = (parsed.data ?? {}) as UnknownRecord;
      const hs = fm['hashtags'];
      if (isStringArray(hs)) {
        for (const h of hs) {
          const s = slugifyHashtag(h);
          if (s) found.push(s);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Cache scan error for ${f}: ${msg}`);
    }
  }
  return uniqueStable(found).sort((a, b) => a.localeCompare(b));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = `^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
  return new RegExp(re, 'i');
}

function filterNewWithDenylist(
  newItems: string[],
  denylist: string[],
  mode: DenylistMode
): { kept: string[]; denied: string[] } {
  if (denylist.length === 0) return { kept: newItems, denied: [] };

  if (mode === 'exact') {
    const deny = new Set(denylist);
    const kept: string[] = [];
    const denied: string[] = [];
    for (const x of newItems) {
      if (deny.has(x)) denied.push(x);
      else kept.push(x);
    }
    return { kept, denied };
  }

  const patterns = denylist.map((d) => globToRegExp(d));
  const kept: string[] = [];
  const denied: string[] = [];

  for (const x of newItems) {
    const hit = patterns.some((re) => re.test(x));
    if (hit) denied.push(x);
    else kept.push(x);
  }

  return { kept, denied };
}

async function buildCache(files: string[], cacheFilePath: string, dryRun: boolean, verbose: boolean): Promise<CacheFile> {
  const hashtags = await scanExistingHashtags(files);
  const cache: CacheFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    hashtags,
  };

  if (!dryRun) {
    await writeJsonFile(cacheFilePath, cache);
    if (verbose) console.log(`\nCache written: ${cacheFilePath} (${cache.hashtags.length} hashtags)`);
  } else {
    // Dry-run: do not write, but show exactly what would be written
    console.log(`\nDRY-RUN: Cache would be written to: ${cacheFilePath}`);
    console.log(`DRY-RUN: Cache hashtag count: ${cache.hashtags.length}`);
    console.log(`DRY-RUN: Cache payload:\n${JSON.stringify(cache, null, 2)}`);
    if (verbose && cache.hashtags.length === 0) {
      console.log('DRY-RUN: Note: empty cache is expected if no posts currently contain frontmatter "hashtags".');
    }
  }

  return cache;
}

async function loadOrCreateCache(files: string[], cacheFilePath: string, dryRun: boolean, verbose: boolean): Promise<CacheFile> {
  const existing = await readJsonFile<CacheFile>(cacheFilePath);
  if (existing?.version === 1 && Array.isArray(existing.hashtags)) return existing;
  return buildCache(files, cacheFilePath, dryRun, verbose);
}

function warnVerbose(params: {
  filePath: string;
  title: string;
  min: number;
  max: number;
  denylistMode: DenylistMode;
  denylistDenied: string[];
  existing: string[];
  added: string[];
  final: string[];
  suggestions: string[];
}): void {
  const lines: string[] = [];

  lines.push(`\nWARN: Review hashtags for ${params.filePath}`);
  lines.push(`  title: ${params.title}`);
  lines.push(`  settings: min=${params.min}, max=${params.max}, denylistMode=${params.denylistMode}`);

  lines.push(`  existing (${params.existing.length}): ${params.existing.join(', ') || '(none)'}`);
  lines.push(`  added (${params.added.length}): ${params.added.join(', ') || '(none)'}`);
  lines.push(`  final (${params.final.length}): ${params.final.join(', ') || '(none)'}`);

  if (params.denylistDenied.length > 0) {
    lines.push(`  denylisted candidates (${params.denylistDenied.length}): ${params.denylistDenied.join(', ')}`);
  }

  if (params.final.length === 1) {
    lines.push('  note: only 1 hashtag total. This is a strong signal to add manual hashtags.');
  } else if (params.final.length < params.min) {
    lines.push(`  note: only ${params.final.length} hashtags total (min is ${params.min}). Add manual hashtags.`);
  }

  if (params.suggestions.length > 0) {
    lines.push(`  manual suggestions (not added) (${params.suggestions.length}): ${params.suggestions.join(', ')}`);
  }

  console.warn(lines.join('\n'));
}

async function processFile(
  filePath: string,
  cfg: CliConfig,
  conf: RequiredTaggerConfig,
  cacheHashtags: string[]
): Promise<{ changed: boolean; added: string[]; final: string[] }> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = matter(raw);
  const fm = (parsed.data ?? {}) as UnknownRecord;

  const existingHashtagsRaw = fm['hashtags'];
  const existingHashtags = isStringArray(existingHashtagsRaw)
    ? uniqueStable(existingHashtagsRaw.map((h) => slugifyHashtag(h)).filter((h): h is string => !!h))
    : [];

  const title = getTitleFromFrontmatter(fm) ?? path.basename(filePath, path.extname(filePath));
  const headings = extractHeadings(parsed.content);

  const tags = fm['tags'];
  const tagCandidates: string[] = isStringArray(tags) ? tags : [];

  const bodyNoCode = stripCodeBlocks(parsed.content);
  const keywordCandidates = topKeywords(bodyNoCode, conf.keywordLimit);

  const rawCandidates = uniqueStable([title, ...headings, ...tagCandidates, ...keywordCandidates]).slice(0, conf.candidateLimit);

  const generatedAll = uniqueStable(
    rawCandidates.map((c) => slugifyHashtag(c)).filter((x): x is string => typeof x === 'string')
  );

  const denyRes = filterNewWithDenylist(generatedAll, conf.denylist, conf.denylistMode);
  const generated = denyRes.kept;
  const denied = denyRes.denied;

  const mappedDetails = generated.map((c) => ({
    original: c,
    ...mapToCache(c, cacheHashtags, conf.cacheSimilarityThreshold),
  }));

  const mappedNew = mappedDetails.map((d) => d.mapped);

  const combined = uniqueStable([...existingHashtags, ...mappedNew]).slice(0, conf.max);

  const existingSet = new Set(existingHashtags);
  const added = combined.filter((h) => !existingSet.has(h));

  const finalSet = new Set(combined);
  const suggestions = uniqueStable(
    generatedAll.filter((h) => !finalSet.has(h)).slice(0, conf.warningSuggestionLimit)
  );

  if (cfg.verbose) {
    console.log(`\n${filePath}`);
    console.log(`  title: ${title}`);
    console.log(`  candidates (raw): ${rawCandidates.length}`);
    console.log(`  generated (pre-denylist): ${generatedAll.length}`);
    console.log(`  denylisted: ${denied.length}`);
    console.log(`  generated (post-denylist): ${generated.length}`);

    const remaps = mappedDetails.filter((d) => d.from && d.original !== d.mapped);
    console.log(`  cache remaps: ${remaps.length} (threshold ${conf.cacheSimilarityThreshold})`);
    for (const r of remaps.slice(0, conf.verboseRemapLimit)) {
      console.log(`    ${r.original} -> ${r.mapped} (score ${r.score.toFixed(2)})`);
    }
    if (remaps.length > conf.verboseRemapLimit) console.log(`    ...and ${remaps.length - conf.verboseRemapLimit} more remaps`);
  }

  if (combined.length === 1 || combined.length < conf.min) {
    warnVerbose({
      filePath,
      title,
      min: conf.min,
      max: conf.max,
      denylistMode: conf.denylistMode,
      denylistDenied: denied.slice(0, 50),
      existing: existingHashtags,
      added,
      final: combined,
      suggestions,
    });
  }

  if (added.length === 0) return { changed: false, added: [], final: combined };

  fm['hashtags'] = combined;

  const newRaw = `${toYamlFrontmatter(fm)}${parsed.content.replace(/^\n+/, '')}\n`;
  if (newRaw === raw) return { changed: false, added: [], final: combined };

  if (!cfg.dryRun) await fs.writeFile(filePath, newRaw, 'utf8');

  return { changed: true, added, final: combined };
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const conf = await loadConfig(cfg.configFile);

  const files = await resolveFiles(cfg, conf);

  if (files.length === 0) {
    console.error('No markdown files found with given options.');
    printHelp();
    process.exit(1);
  }

  if (cfg.cacheRebuild) {
    await buildCache(files, conf.cacheFile, cfg.dryRun, cfg.verbose);
    console.log(`\nDone. Cache rebuild completed (${cfg.dryRun ? 'dry-run' : 'written'}).`);
    return;
  }

  const cache = await loadOrCreateCache(files, conf.cacheFile, cfg.dryRun, cfg.verbose);
  const cacheHashtags = cache.hashtags;

  let changed = 0;
  let skipped = 0;

  const newlyAddedToCache: string[] = [];

  for (const f of files) {
    try {
      const res = await processFile(f, cfg, conf, cacheHashtags);
      if (res.changed) changed += 1;
      else skipped += 1;

      for (const h of res.added) newlyAddedToCache.push(h);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\nError processing ${f}: ${msg}`);
    }
  }

  const mergedCache = uniqueStable([...cacheHashtags, ...newlyAddedToCache]).sort((a, b) => a.localeCompare(b));
  if (mergedCache.length !== cacheHashtags.length) {
    const updated: CacheFile = { version: 1, updatedAt: new Date().toISOString(), hashtags: mergedCache };
    if (!cfg.dryRun) await writeJsonFile(conf.cacheFile, updated);
    if (cfg.verbose) console.log(`\nCache ${cfg.dryRun ? 'would be updated' : 'updated'}: ${conf.cacheFile} (${updated.hashtags.length} hashtags)`);
  }

  console.log(`\nDone. Files processed: ${files.length}, changed: ${changed}, skipped: ${skipped}`);
  if (cfg.dryRun) console.log('Dry run only. Re-run with --write to apply changes.');
}

void main();
