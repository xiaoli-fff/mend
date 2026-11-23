// main.ts is mend, the CLI SPEC.md specifies. It implements sections 1 to 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// Thrown for exit code 2: the message is the single stdout line.
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

// A failed edit (exit code 1): `error: <code> <path>`.
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

// A patch's lines: its text split at '\n', each with one trailing '\r'
// removed, without the empty piece after a final '\n'.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A path is safe when it is not empty, does not start with '/', holds no '\',
// and no '/'-separated segment is empty, '.' or '..'.
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

// ---------------------------------------------------------------------------
// Line model (section 3)
// ---------------------------------------------------------------------------

type LineBreak = '\n' | '\r\n';

interface FileModel {
  br: LineBreak;
  lines: string[];
  ends: boolean; // the file ends with a line break
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br: LineBreak = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const body = ends ? text.slice(0, -br.length) : text;
  return { br, lines: body.split(br), ends };
}

function writeFileText(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.ends ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function rstripWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

// The line as a tier sees it (section 5).
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return rstripWs(s);
  return rstripWs(s.replace(/^[ \t]+/, ''));
}

// ---------------------------------------------------------------------------
// Three-tier matching (section 5)
// ---------------------------------------------------------------------------

// Positions i where O matches lines[i..i+O.length-1] at the given tier.
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (O.length === 0) return pos;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

// The first tier (0, 1, 2; only 0 when strict) at which O occurs at least
// once at or after `from`, and its positions. When eofOnly, only occurrences
// ending at the file's last line count.
function firstTier(
  lines: string[],
  O: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(lines, O, t, from);
    if (eofOnly) pos = pos.filter((i) => i + O.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// A single-line anchor (V4A): the first line at or after `from` equal to the
// anchor at the first tier where one is. Returns the position, or null.
function anchorAt(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const na = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === na) return i;
    }
  }
  return null;
}

interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  raw: string; // the patch line this entry came from (for blank-line checks)
}

// Replace the matched region: O's lines at `occ` in `lines` become the
// entries' lines. Context lines are written as the file's own matched line;
// at tier 2 every other (new) line is re-indented (section 5).
function replaceRegion(
  lines: string[],
  occ: number,
  O: string[],
  entries: BodyEntry[],
  tier: number,
): string[] {
  const out: string[] = [];
  const F = O.length > 0 ? leadingWs(lines[occ]!) : '';
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  let oIdx = 0;
  for (const e of entries) {
    if (e.kind === 'ctx') {
      out.push(lines[occ + oIdx]!);
      oIdx++;
    } else if (e.kind === 'old') {
      oIdx++;
    } else {
      let t = e.text;
      if (tier === 2 && O.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(P)) {
        t = F + t.slice(P.length);
      }
      out.push(t);
    }
  }
  return [...lines.slice(0, occ), ...out, ...lines.slice(occ + O.length)];
}

// ---------------------------------------------------------------------------
// Tree (section 10)
// ---------------------------------------------------------------------------

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  snapshot(): { now: Map<string, string | null>; moves: Array<[string, string]> } {
    return {
      now: new Map(this.now),
      moves: this.moves.map(([a, b]) => [a, b] as [string, string]),
    };
  }
  restore(s: { now: Map<string, string | null>; moves: Array<[string, string]> }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.moves = s.moves.map(([a, b]) => [a, b] as [string, string]);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Format detection (section 4)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (section 9) -- the kit starter's, unchanged
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number; // old start, 1-based (A in "@@ -A[,B] +C[,D] @@")
  entries: BodyEntry[];
  backslashAfterLastCtxOrNew: boolean;
  backslashAfterLastPlus: boolean;
}

interface UnifiedSection {
  oldPath: string | null; // null = /dev/null
  newPath: string | null;
  hasDashPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

// "diff --git a/<X> b/<Y>" -> [X, Y]; null when not of that form.
function parseDiffGit(l: string): [string, string] | null {
  if (!l.startsWith('diff --git ')) return null;
  const rest = l.slice('diff --git '.length);
  const k = rest.indexOf(' b/');
  if (k < 0) return null;
  const x = rest.slice(0, k);
  const y = rest.slice(k + 3);
  if (!x.startsWith('a/') || x.length <= 2 || y.length === 0) return null;
  return [x.slice(2), y];
}

// The path of a "--- <path>" / "+++ <path>" line: text after the four
// characters, up to the first tab, surrounding spaces removed; /dev/null
// means no file; a leading a/ or b/ is removed. Returns null for /dev/null.
function parseHeaderPath(l: string): string | null {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let i = 0;
  const n = lines.length;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

  while (i < n) {
    const l = lines[i]!;

    if (l.startsWith('diff --git ')) {
      const dg = parseDiffGit(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        oldPath: dg[0],
        newPath: dg[1],
        hasDashPair: false,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(cur);
      i++;
      continue;
    }

    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const raw: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (
          b === '' ||
          b.startsWith(' ') ||
          b.startsWith('-') ||
          b.startsWith('+') ||
          b.startsWith('\\')
        ) {
          raw.push(b);
          i++;
        } else {
          break;
        }
      }
      // Empty lines at the end of a body are not part of it.
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const entries: BodyEntry[] = [];
      // The raw index of each entry (a '\' line is not an entry).
      const rawIdxOf: number[] = [];
      for (let k = 0; k < raw.length; k++) {
        const r = raw[k]!;
        if (r.startsWith('\\')) continue;
        if (r === '') entries.push({ kind: 'ctx', text: '', raw: r });
        else if (r.startsWith(' ')) entries.push({ kind: 'ctx', text: r.slice(1), raw: r });
        else if (r.startsWith('-')) entries.push({ kind: 'old', text: r.slice(1), raw: r });
        else entries.push({ kind: 'new', text: r.slice(1), raw: r });
        rawIdxOf.push(k);
      }
      let lastCtxOrNew: number | null = null;
      let lastPlus: number | null = null;
      for (let k = 0; k < entries.length; k++) {
        if (entries[k]!.kind === 'ctx' || entries[k]!.kind === 'new') lastCtxOrNew = k;
        if (entries[k]!.kind === 'new') lastPlus = k;
      }
      const bsAfter = (entryIdx: number | null): boolean => {
        if (entryIdx === null) return false;
        const ri = rawIdxOf[entryIdx]!;
        return ri + 1 < raw.length && raw[ri + 1]!.startsWith('\\');
      };
      cur.hunks.push({
        a,
        entries,
        backslashAfterLastCtxOrNew: bsAfter(lastCtxOrNew),
        backslashAfterLastPlus: bsAfter(lastPlus),
      });
      continue;
    }

    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        cur = {
          oldPath: null,
          newPath: null,
          hasDashPair: false,
          newFile: false,
          deletedFile: false,
          hunks: [],
        };
        sections.push(cur);
      }
      cur.oldPath = parseHeaderPath(l);
      cur.newPath = parseHeaderPath(lines[i + 1]!);
      cur.hasDashPair = true;
      i += 2;
      continue;
    }

    if (l.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      // Inside a section's header, not followed by a '+++ ' line.
      throw new Exit2(`error: parse ${i + 2}`);
    }

    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) {
        if (!cur.hasDashPair) cur.oldPath = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (!cur.hasDashPair) cur.newPath = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.deletedFile = true;
      }
      // index, old mode, new mode, similarity/dissimilarity index, Index:
      // and any other header line are ignored.
      i++;
      continue;
    }

    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i++;
  }

  return sections;
}

// Apply one hunk to a file model; d is the section's running length delta.
// Returns the new model and the updated delta.
function applyHunk(
  model: FileModel,
  h: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { model: FileModel; d: number } {
  const O = h.entries.filter((e) => e.kind === 'ctx' || e.kind === 'old').map((e) => e.text);
  const Nlen = h.entries.filter((e) => e.kind === 'ctx' || e.kind === 'new').length;
  let lines = model.lines;
  let ends = model.ends;
  if (O.length === 0) {
    const insertPos = Math.min(h.a + d, lines.length);
    const wasAtEnd = insertPos === lines.length;
    lines = replaceRegion(lines, insertPos, [], h.entries, 0);
    if (wasAtEnd) ends = !h.backslashAfterLastCtxOrNew;
    return { model: { br: model.br, lines, ends }, d: d + Nlen };
  }
  const found = firstTier(lines, O, strict, 0, false);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const matchedToEnd = best + O.length === lines.length;
  lines = replaceRegion(lines, best, O, h.entries, found.tier);
  if (matchedToEnd) ends = !h.backslashAfterLastCtxOrNew;
  return { model: { br: model.br, lines, ends }, d: d + (Nlen - O.length) };
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.newFile;
    if (isCreate) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      for (const h of sec.hunks) {
        for (const e of h.entries) if (e.kind === 'new') plusLines.push(e.text);
      }
      let ends = false;
      for (const h of sec.hunks) {
        if (h.entries.some((e) => e.kind === 'new')) ends = !h.backslashAfterLastPlus;
      }
      tree.now.set(p, plusLines.length === 0 ? '' : plusLines.join('\n') + (ends ? '\n' : ''));
      return;
    }
    const isDelete = newP === null || sec.deletedFile;
    if (isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      // Move.
      const oldPath = oldP!;
      const newPath = newP!;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let model = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyHunk(model, h, d, strict, oldPath);
        model = r.model;
        d = r.d;
      }
      tree.now.set(newPath, writeFileText(model));
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    // Change.
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let model = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(model, h, d, strict, p);
      model = r.model;
      d = r.d;
    }
    tree.now.set(p, writeFileText(model));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.replace(/[ \t]+$/, '') !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    // The path is the nearest line before the SEARCH line, after the
    // previous block's end, that is not blank and does not start with ```.
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    // Find '=======' after the SEARCH line; a '>>>>>>> REPLACE' or another
    // SEARCH line first means the block has no divider.
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const t = lines[j]!.replace(/[ \t]+$/, '');
      if (t === '=======') {
        eqIdx = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // Find '>>>>>>> REPLACE' after the divider.
    let endIdx = -1;
    for (let j = eqIdx + 1; j < n; j++) {
      const t = lines[j]!.replace(/[ \t]+$/, '');
      if (t === '>>>>>>> REPLACE') {
        endIdx = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({
      path,
      oldLines: lines.slice(searchIdx + 1, eqIdx),
      newLines: lines.slice(eqIdx + 1, endIdx),
    });
    prevPath = path;
    prevEnd = endIdx + 1;
    i = endIdx + 1;
  }
  return blocks;
}

function srBlockEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = parseFile(before);
    const found = firstTier(model.lines, b.oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const entries: BodyEntry[] = [
      ...b.oldLines.map((t) => ({ kind: 'old' as const, text: t, raw: t })),
      ...b.newLines.map((t) => ({ kind: 'new' as const, text: t, raw: t })),
    ];
    const lines = replaceRegion(model.lines, found.pos[0]!, b.oldLines, entries, found.tier);
    tree.now.set(p, writeFileText({ br: model.br, lines, ends: model.ends }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  entries: BodyEntry[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${first + 1}`);
  }
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const edits: Edit[] = [];
  let i = first + 1;
  const n = last; // exclusive: `last` is the End Patch line
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') ||
    l.startsWith('*** Delete File: ') ||
    l.startsWith('*** Update File: ');

  while (i < n) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < n && !isHeader(lines[j]!)) {
        raw.push(lines[j]!);
        j++;
      }
      let lastNonBlank = -1;
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) lastNonBlank = k;
      }
      const fileLines: string[] = [];
      for (let k = 0; k <= lastNonBlank; k++) {
        const m = raw[k]!;
        if (m.startsWith('+')) fileLines.push(m.slice(1));
        else if (blank(m)) fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < n && !isHeader(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < n && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      let k = j;
      while (k < n) {
        const m = lines[k]!;
        if (isHeader(m)) break;
        if (m.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${k + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          k++;
          continue;
        }
        if (m.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = m.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, entries: [], eof: false };
          firstChunk = false;
          k++;
          continue;
        }
        const isBody = m === '' || m.startsWith(' ') || m.startsWith('-') || m.startsWith('+');
        if (isBody) {
          if (cur === null) {
            if (firstChunk) {
              cur = { anchor: null, entries: [], eof: false };
              firstChunk = false;
            } else {
              throw new Exit2(`error: parse ${k + 1}`);
            }
          }
          if (m === '') cur.entries.push({ kind: 'ctx', text: '', raw: m });
          else if (m.startsWith(' ')) cur.entries.push({ kind: 'ctx', text: m.slice(1), raw: m });
          else if (m.startsWith('-')) cur.entries.push({ kind: 'old', text: m.slice(1), raw: m });
          else cur.entries.push({ kind: 'new', text: m.slice(1), raw: m });
          k++;
          continue;
        }
        if (blank(m)) {
          // A blank line that is not a body line (e.g. only tabs): ignored
          // between chunks, a parse error inside a chunk.
          if (cur === null && !firstChunk) {
            k++;
            continue;
          }
          throw new Exit2(`error: parse ${k + 1}`);
        }
        throw new Exit2(`error: parse ${k + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        if (!lastChunk.eof) {
          while (lastChunk.entries.length > 0) {
            const e = lastChunk.entries[lastChunk.entries.length - 1]!;
            if (e.kind === 'ctx' && blank(e.raw)) lastChunk.entries.pop();
            else break;
          }
        }
      }
      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = k;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: V4aChunk[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    let lines = model.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = anchorAt(lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const O = ch.entries.filter((e) => e.kind === 'ctx' || e.kind === 'old').map((e) => e.text);
      if (O.length === 0) {
        const insertPos = ch.eof ? lines.length : cursor;
        lines = replaceRegion(lines, insertPos, [], ch.entries, 0);
        cursor = insertPos + ch.entries.filter((e) => e.kind === 'new').length;
        continue;
      }
      const found = firstTier(lines, O, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const occ = found.pos[0]!;
      lines = replaceRegion(lines, occ, O, ch.entries, found.tier);
      cursor = occ + ch.entries.filter((e) => e.kind === 'ctx' || e.kind === 'new').length;
    }
    const text = writeFileText({ br: model.br, lines, ends: model.ends });
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Output rows (section 2): A / D / M / R lines, sorted by path byte order
// ---------------------------------------------------------------------------

function buildRows(tree: Tree): string[] {
  const movedFrom = new Map<string, string>();
  for (const [o, n] of tree.moves) movedFrom.set(o, n);
  const chainDest = new Map<string, string>();
  for (const [o] of tree.moves) {
    let cur = o;
    const seen = new Set<string>();
    while (movedFrom.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = movedFrom.get(cur)!;
    }
    chainDest.set(o, cur);
  }
  // R pairs: an original path moved (through a chain) to a destination that
  // did not exist before and does after, while the original no longer does.
  const rRows = new Map<string, string>();
  const covered = new Set<string>();
  for (const [o] of tree.moves) {
    const dest = chainDest.get(o)!;
    if (dest === o) continue;
    const beforeO = tree.original(o);
    const afterO = tree.now.get(o);
    const beforeD = tree.original(dest);
    const afterD = tree.now.get(dest);
    if (beforeO !== null && afterO === null && beforeD === null && afterD !== null) {
      rRows.set(o, dest);
      covered.add(dest);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    if (rRows.has(p)) {
      const dest = rRows.get(p)!;
      rows.push({ key: dest, line: `R ${p} -> ${dest}` });
      continue;
    }
    const before = tree.original(p);
    const after = tree.now.get(p)!;
    if (after === null) {
      if (before !== null) rows.push({ key: p, line: `D ${p}` });
    } else if (before === null) {
      if (!covered.has(p)) rows.push({ key: p, line: `A ${p}` });
    } else if (after !== before) {
      rows.push({ key: p, line: `M ${p}` });
    }
  }
  rows.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return rows.map((r) => r.line);
}

// ---------------------------------------------------------------------------
// CLI (section 1)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') {
      edits = jsonEdits(text, lines);
    } else if (kind === 'unified') {
      edits = parseUnified(lines).map((sec) => unifiedSectionEdit(sec, strict));
    } else if (kind === 'search-replace') {
      edits = parseSearchReplace(lines).map((b) => srBlockEdit(b, strict));
    } else {
      edits = parseV4a(lines, strict);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(snap);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows = buildRows(tree);
  if (!check) {
    for (const p of tree.now.keys()) {
      const v = tree.now.get(p)!;
      if (v === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
