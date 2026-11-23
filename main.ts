// mend: apply an AI-written edit, in one of four formats, to a tree of text files.
//
// My own implementation of the kit's SPEC.md (version 1), written from the
// specification alone. Node 22 and its standard library only; run as
// `node main.ts [options] [PATCH]` with the working directory as the root of
// the tree. Every file is changed or nothing is.
//
// When MAKEFUN_ENV_URL is set, the run is a trial: control passes to the
// kit's runner.ts beside this file, which reads the trial's checks from the
// env, runs this CLI on each one, and posts what it did.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch that cannot be read in its format: exit 2, `error: parse <line>`. */
class ParseErr {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit that failed: exit 1, `error: <code> <path>`. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty tail piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  const parts = p.split('/');
  for (const s of parts) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/* ------------------------------------------------------------------ */
/* Files as lines                                                      */
/* ------------------------------------------------------------------ */

interface FileModel {
  br: string;
  lines: string[];
  finalBr: boolean;
}

/** Split a file's text at its own line break (CRLF when its first line feed
 *  follows a carriage return, LF otherwise). */
function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBr = false;
  if (text.endsWith(br)) {
    parts.pop();
    finalBr = true;
  }
  return { br, lines: parts, finalBr };
}

/** Write a file model back: its own break, a final one exactly when it had
 *  one; a file of no lines is written empty. */
function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBr ? m.br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function matchesAt(o: string[], f: string[], start: number, tier: number): boolean {
  if (start < 0 || start + o.length > f.length) return false;
  for (let k = 0; k < o.length; k++) {
    if (normLine(f[start + k]!, tier) !== normLine(o[k]!, tier)) return false;
  }
  return true;
}

/** Every position at or after `from` where O occurs at this tier. */
function occurrencesAt(o: string[], f: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= f.length; i++) {
    if (matchesAt(o, f, i, tier)) pos.push(i);
  }
  return pos;
}

/** The first tier (0, 1, 2; 0 only with --strict) at which O occurs at least
 *  once at or after `from`, with its positions. */
function firstTierWith(
  o: string[],
  f: string[],
  from: number,
  strict: boolean,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(o, f, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: either a context line paired with an O line (ctx is the
 *  O index), or an added line (ctx is -1). */
interface NItem {
  text: string;
  ctx: number;
}

/** Build the replacement segment: context lines are the file's own matched
 *  lines; at tier 2 every other non-blank line is re-indented from the old
 *  block's indent to the file's. */
function buildSegment(
  n: NItem[],
  fileLines: string[],
  start: number,
  tier: number,
  oFirst: string,
  fileFirst: string,
): string[] {
  const out: string[] = [];
  const p = leadingWs(oFirst);
  const f = leadingWs(fileFirst);
  for (const item of n) {
    if (item.ctx >= 0) {
      out.push(fileLines[start + item.ctx]!);
      continue;
    }
    let t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) {
      t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The tree as the edits leave it                                      */
/* ------------------------------------------------------------------ */

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

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
}

interface Edit {
  run(tree: Tree): void;
  move?: { from: string; to: string };
}

/* ------------------------------------------------------------------ */
/* Hunk and chunk bodies (unified hunks, V4A chunks)                   */
/* ------------------------------------------------------------------ */

interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** A `\` line follows this body line in the patch. */
  markAfter: boolean;
}

interface HunkLike {
  /** The hunk header's old start (unified only; unused for V4A chunks). */
  A: number;
  items: BodyItem[];
}

/** Split a body into its old lines O and its new lines N (context lines
 *  paired with their O index). */
function splitBody(items: BodyItem[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const oi = o.length;
      o.push(it.text);
      n.push({ text: '', ctx: oi });
    } else if (it.kind === 'del') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last context or added line. */
function lastRelevantMark(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'add') return it.markAfter;
  }
  return false;
}

/** Apply a section's unified hunks in order to a file model. `d` tracks the
 *  running difference between new and old line counts. Throws EditFail. */
function applyHunks(model: FileModel, hunks: HunkLike[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = splitBody(hunk.items);
    if (o.length === 0) {
      let pos = hunk.A + d;
      if (pos < 0) pos = 0;
      if (pos > model.lines.length) pos = model.lines.length;
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...n.map((it) => it.text));
      if (atEnd && lastRelevantMark(hunk.items)) model.finalBr = false;
      d += n.length;
      continue;
    }
    const found = firstTierWith(o, model.lines, 0, strict);
    if (found === null) throw new EditFail('no-match', failPath);
    const target = hunk.A - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const atEnd = pos + o.length === model.lines.length;
    const seg = buildSegment(n, model.lines, pos, found.tier, o[0]!, model.lines[pos]!);
    model.lines.splice(pos, o.length, ...seg);
    if (atEnd && lastRelevantMark(hunk.items)) model.finalBr = false;
    d += n.length - o.length;
  }
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Section {
  diffA: string | null;
  diffB: string | null;
  headerOld: string | null;
  headerNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: HunkLike[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripAB(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A `--- ` / `+++ ` header path: text after the four characters, up to the
 *  first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const startSection = (s: Section): void => {
    if (cur !== null) sections.push(cur);
    cur = s;
    inHeader = true;
  };
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      startSection({
        diffA: m[1]!,
        diffB: m[2]!,
        headerOld: null,
        headerNew: null,
        renameOld: null,
        renameNew: null,
        newFile: false,
        delFile: false,
        hunks: [],
      });
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseErr(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      const A = parseInt(m[1]!, 10);
      i++;
      const raw: string[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          raw.push(l);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const items: BodyItem[] = [];
      for (const l of raw) {
        if (l.startsWith('\\')) {
          if (items.length > 0) items[items.length - 1]!.markAfter = true;
          continue;
        }
        if (l === '') items.push({ kind: 'ctx', text: '', markAfter: false });
        else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1), markAfter: false });
        else if (l[0] === '-') items.push({ kind: 'del', text: l.slice(1), markAfter: false });
        else items.push({ kind: 'add', text: l.slice(1), markAfter: false });
      }
      cur.hunks.push({ A, items });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.headerOld = stripAB(headerPath(line));
          cur.headerNew = stripAB(headerPath(lines[i + 1]!));
          i += 2;
          continue;
        }
        throw new ParseErr(i + 2);
      }
      if (line.startsWith('+++ ')) {
        cur.headerNew = stripAB(headerPath(line));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection({
        diffA: null,
        diffB: null,
        headerOld: stripAB(headerPath(line)),
        headerNew: stripAB(headerPath(lines[i + 1]!)),
        renameOld: null,
        renameNew: null,
        newFile: false,
        delFile: false,
        hunks: [],
      });
      i += 2;
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.headerOld ?? sec.renameOld ?? sec.diffA ?? '';
  const newPath = sec.headerNew ?? sec.renameNew ?? sec.diffB ?? '';
  const isCreate = oldPath === '/dev/null' || sec.newFile;
  const isDelete = newPath === '/dev/null' || sec.delFile;
  if (isCreate) {
    const target = newPath;
    return {
      run(tree: Tree): void {
        if (!isSafePath(target)) throw new EditFail('unsafe', target);
        if (tree.get(target) !== null) throw new EditFail('exists', target);
        const plus: string[] = [];
        let markLast = false;
        for (const h of sec.hunks) {
          for (const it of h.items) {
            if (it.kind === 'add') {
              plus.push(it.text);
              markLast = it.markAfter;
            }
          }
        }
        tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (markLast ? '' : '\n'));
      },
    };
  }
  if (isDelete) {
    const target = oldPath;
    return {
      run(tree: Tree): void {
        if (!isSafePath(target)) throw new EditFail('unsafe', target);
        if (tree.get(target) === null) throw new EditFail('missing', target);
        tree.now.set(target, null);
      },
    };
  }
  if (oldPath !== newPath) {
    const edit: Edit = {
      move: { from: oldPath, to: newPath },
      run(tree: Tree): void {
        if (!isSafePath(oldPath)) throw new EditFail('unsafe', oldPath);
        if (!isSafePath(newPath)) throw new EditFail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new EditFail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new EditFail('exists', newPath);
        const model = splitFile(before);
        applyHunks(model, sec.hunks, strict, oldPath);
        tree.now.set(newPath, joinFile(model));
        tree.now.set(oldPath, null);
      },
    };
    return edit;
  }
  const target = oldPath;
  return {
    run(tree: Tree): void {
      if (!isSafePath(target)) throw new EditFail('unsafe', target);
      const before = tree.get(target);
      if (before === null) throw new EditFail('missing', target);
      const model = splitFile(before);
      applyHunks(model, sec.hunks, strict, target);
      tree.now.set(target, joinFile(model));
    },
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let j = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j < 0) break;
    let path: string | null = null;
    for (let k = j - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(j + 1);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let k = j + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (eq < 0 && t === '=======') eq = k;
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseErr(j + 1);
    if (eq < 0 || eq > rep) throw new ParseErr(j + 1);
    const oldLines = lines.slice(j + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return {
    run(tree: Tree): void {
      if (!isSafePath(path)) throw new EditFail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new EditFail('missing', path);
      const model = splitFile(before);
      const found = firstTierWith(oldLines, model.lines, 0, strict);
      if (found === null) throw new EditFail('no-match', path);
      if (found.pos.length > 1) throw new EditFail('ambiguous', path);
      const pos = found.pos[0]!;
      const seg = buildSegment(
        newLines.map((t) => ({ text: t, ctx: -1 })),
        model.lines,
        pos,
        found.tier,
        oldLines[0]!,
        model.lines[pos]!,
      );
      model.lines.splice(pos, oldLines.length, ...seg);
      tree.now.set(path, joinFile(model));
    },
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const body = lines.slice(first + 1, last);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = 0;
  while (i < body.length) {
    if (isBlank(body[i]!)) {
      i++;
      continue;
    }
    const line = body[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new ParseErr(first + 1 + i + 1);
    }
    const sectionLineNo = first + 1 + i + 1;
    i++;
    const contentStart = i;
    while (i < body.length && !isSectionStart(body[i]!)) i++;
    const content = body.slice(contentStart, i);
    while (content.length > 0 && isBlank(content[content.length - 1]!)) content.pop();
    const lineNo = (k: number): number => first + 1 + contentStart + k + 1;
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < content.length; k++) {
        const l = content[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new ParseErr(lineNo(k));
      }
      edits.push({
        run(tree: Tree): void {
          if (!isSafePath(path)) throw new EditFail('unsafe', path);
          if (tree.get(path) !== null) throw new EditFail('exists', path);
          tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
        },
      });
    } else if (kind === 'delete') {
      for (let k = 0; k < content.length; k++) {
        if (!isBlank(content[k]!)) throw new ParseErr(lineNo(k));
      }
      edits.push({
        run(tree: Tree): void {
          if (!isSafePath(path)) throw new EditFail('unsafe', path);
          if (tree.get(path) === null) throw new EditFail('missing', path);
          tree.now.set(path, null);
        },
      });
    } else {
      let k = 0;
      while (k < content.length && isBlank(content[k]!)) k++;
      let moveTo: string | null = null;
      if (k < content.length && content[k]!.startsWith('*** Move to: ')) {
        moveTo = content[k]!.slice(13).trim();
        k++;
        while (k < content.length && isBlank(content[k]!)) k++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let seenChunk = false;
      for (; k < content.length; k++) {
        const l = content[k]!;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
          chunks.push(cur);
          seenChunk = true;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new ParseErr(lineNo(k));
          cur.eof = true;
          cur = null;
          continue;
        }
        if (isBlank(l) && cur === null) continue;
        if (cur === null) {
          if (seenChunk) throw new ParseErr(lineNo(k));
          cur = { anchor: null, eof: false, items: [] };
          chunks.push(cur);
          seenChunk = true;
        }
        if (l === '') cur.items.push({ kind: 'ctx', text: '', markAfter: false });
        else if (l[0] === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1), markAfter: false });
        else if (l[0] === '-') cur.items.push({ kind: 'del', text: l.slice(1), markAfter: false });
        else if (l[0] === '+') cur.items.push({ kind: 'add', text: l.slice(1), markAfter: false });
        else throw new ParseErr(lineNo(k));
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(sectionLineNo);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  const edit: Edit = {
    run(tree: Tree): void {
      if (!isSafePath(path)) throw new EditFail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new EditFail('missing', path);
      if (moveTo !== null) {
        if (!isSafePath(moveTo)) throw new EditFail('unsafe', moveTo);
        if (tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
      }
      const model = splitFile(before);
      let cursor = 0;
      for (const chunk of chunks) {
        const { o, n } = splitBody(chunk.items);
        if (chunk.anchor !== null) {
          const anchor = chunk.anchor;
          let foundAt = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            for (let j = cursor; j < model.lines.length; j++) {
              if (normLine(model.lines[j]!, t) === normLine(anchor, t)) {
                foundAt = j;
                break;
              }
            }
            if (foundAt >= 0) break;
          }
          if (foundAt < 0) throw new EditFail('no-match', path);
          cursor = foundAt + 1;
        }
        if (chunk.eof) {
          if (o.length === 0) {
            model.lines.splice(model.lines.length, 0, ...n.map((it) => it.text));
            cursor = model.lines.length;
          } else {
            const start = model.lines.length - o.length;
            if (start < cursor) throw new EditFail('no-match', path);
            const tiers = strict ? [0] : [0, 1, 2];
            let tierFound = -1;
            for (const t of tiers) {
              if (matchesAt(o, model.lines, start, t)) {
                tierFound = t;
                break;
              }
            }
            if (tierFound < 0) throw new EditFail('no-match', path);
            const seg = buildSegment(n, model.lines, start, tierFound, o[0]!, model.lines[start]!);
            model.lines.splice(start, o.length, ...seg);
            cursor = start + seg.length;
          }
          continue;
        }
        if (o.length === 0) {
          const pos = Math.min(cursor, model.lines.length);
          model.lines.splice(pos, 0, ...n.map((it) => it.text));
          cursor = pos + n.length;
          continue;
        }
        const found = firstTierWith(o, model.lines, cursor, strict);
        if (found === null) throw new EditFail('no-match', path);
        const pos = found.pos[0]!;
        const seg = buildSegment(n, model.lines, pos, found.tier, o[0]!, model.lines[pos]!);
        model.lines.splice(pos, o.length, ...seg);
        cursor = pos + seg.length;
      }
      const out = joinFile(model);
      if (moveTo !== null) {
        tree.now.set(moveTo, out);
        tree.now.set(path, null);
      } else {
        tree.now.set(path, out);
      }
    },
  };
  if (moveTo !== null) edit.move = { from: path, to: moveTo };
  return edit;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return {
      run(tree: Tree): void {
        if (!isSafePath(p)) throw new EditFail('unsafe', p);
        if (tree.get(p) !== null) throw new EditFail('exists', p);
        tree.now.set(p, text);
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      run(tree: Tree): void {
        if (!isSafePath(p)) throw new EditFail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new EditFail('missing', p);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = toLf(before);
        const old = toLf(oldStr);
        let count = 0;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
        if (count === 0) throw new EditFail('no-match', p);
        if (count > 1) throw new EditFail('ambiguous', p);
        const at = t.indexOf(old);
        const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
        tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return {
      run(tree: Tree): void {
        if (!isSafePath(p)) throw new EditFail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new EditFail('missing', p);
        const model = splitFile(before);
        if (lineNo < 0 || lineNo > model.lines.length) throw new EditFail('no-match', p);
        model.lines.splice(lineNo, 0, ...add);
        tree.now.set(p, joinFile(model));
      },
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseErr(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseErr(first + 1);
      edits.push(e);
    }
    return edits;
  }
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!;
    if (isBlank(l)) continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new ParseErr(k + 1);
    }
    const e = jsonEdit(v);
    if (e === null) throw new ParseErr(k + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4), the run, and the output       */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0]!;
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file === null ? 0 : file, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.run(tree);
      if (edit.move !== undefined) moves.push(edit.move);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const keys = [...tree.now.keys()].sort(byteCompare);
  for (const p of keys) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) rows.push({ key: p, text: `A ${p}` });
    else if (now === null) rows.push({ key: p, text: `D ${p}` });
    else rows.push({ key: p, text: `M ${p}` });
  }
  for (const mv of moves) {
    const di = rows.findIndex((r) => r.key === mv.from && r.text.startsWith('D '));
    const ai = rows.findIndex((r) => r.key === mv.to && r.text.startsWith('A '));
    if (di >= 0 && ai >= 0) {
      rows.splice(Math.max(di, ai), 1);
      rows.splice(Math.min(di, ai), 1);
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
    }
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of keys) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
