import type { NameEntry, NameRule } from '../shared/types';
import { indexOfRun, type Label } from './labels';

/** Fought this many times (with the target frame showing it) without it ever losing HP, a name is treated as harmless. */
const STRIKES_TO_IGNORE = 3;
/** Clicked this many times without the target frame ever showing anything, an overhead name is something that can't be targeted. */
const BLANKS_TO_IGNORE = 2;
/** ...and given another chance after this long (it may just have been out of reach). */
const BLANK_EXPIRY_MS = 60 * 60_000;
/** An overhead name that's this much of a known one (and at least this many glyphs) is that name, partly hidden. */
const PART_SHARE = 0.5;
const MIN_PART_GLYPHS = 3;
/** Most overhead names remembered; the least confirmed are dropped first. */
const MAX_LABELS = 2000;
/** Keys of rules on an overhead name (rather than a target-frame name), carried over from older versions. */
const LABEL_RULE = 'label:';

/** A monster (or herb, pet...) as named in the target frame. */
interface Entry {
  /** The name's fingerprint as written in the target frame, or LABEL_RULE + an overhead name's. */
  key: string;
  /** PNG data URL of the name. */
  image: string;
  rule: NameRule;
  kills: number;
  /** Fights where it never lost HP. */
  strikes: number;
  /** The image is of an overhead name, until the target frame shows this name. */
  provisional?: boolean;
}

export interface SavedNames {
  version: 2;
  names: Entry[];
  /** Overhead name fingerprint, the target-frame name it turned out to be, and how many times. */
  labels: [string, string, number][];
  /** Overhead name fingerprint, how many times clicking it brought up nothing, and when it last did (ms since 1970). */
  blanks: [string, number, number][];
}

/** How names were saved before they were learned from the target frame. */
interface SavedNameV1 {
  fingerprint: string;
  glyphs?: string[];
  image: string;
  rule: NameRule;
  kills: number;
  strikes: number;
  frameName?: string;
}

export type Verdict = 'monster' | 'harmless' | 'unknown';

export interface Judgement {
  kind: Verdict;
  /** The label to aim at: the known name's part of it, if it was run together with other names. */
  label: Label;
}

interface KnownLabel {
  fingerprint: string;
  glyphs: string[];
  kind: Exclude<Verdict, 'unknown'>;
}

/** How a label was judged: the verdict and which run of its glyphs it applies to. */
interface Ruling {
  kind: Verdict;
  at: number;
  length: number;
}

/** The part of a label made of `length` glyphs from `at`. */
function partOf(label: Label, at: number, length: number): Label {
  if (at === 0 && length === label.glyphs.length) return label;
  const glyphs = label.glyphs.slice(at, at + length);
  const left = glyphs[0].left;
  const right = glyphs[glyphs.length - 1].right;
  return {
    ...label,
    box: { ...label.box, left, right: right + 1 },
    centre: { x: Math.round((left + right) / 2), y: label.centre.y },
    glyphs,
    width: right + 1 - left,
    fingerprint: glyphs.map((glyph) => glyph.key).join('|'),
  };
}

/**
 * What the bot has learned about the things it has fought. Names are known by
 * how the target frame writes them: always in the same place and never covered,
 * unlike overhead names. Overhead names are linked to the target-frame name
 * they turned out to be, so harmless ones can be skipped without clicking them.
 */
export class NameBook {
  private readonly entries = new Map<string, Entry>();
  /** Overhead name fingerprint -> target-frame names it turned out to be, with counts. */
  private readonly labels = new Map<string, Map<string, number>>();
  private readonly blanks = new Map<string, { count: number; at: number }>();
  private known: KnownLabel[] | null = null;
  private readonly rulings = new Map<string, Ruling>();

  constructor(
    private readonly onChange: () => void,
    private readonly clock: () => number = Date.now,
  ) {}

  load(saved: unknown): void {
    if (Array.isArray(saved)) {
      this.loadV1(saved as SavedNameV1[]);
      return;
    }
    const data = saved as SavedNames | null;
    if (data?.version !== 2) return;
    for (const entry of data.names) this.entries.set(entry.key, { ...entry });
    for (const [label, name, count] of data.labels) {
      if (!this.labels.has(label)) this.labels.set(label, new Map());
      this.labels.get(label)!.set(name, count);
    }
    for (const [label, count, at] of data.blanks) this.blanks.set(label, { count, at: at ?? this.clock() });
  }

  /**
   * Names used to be learned from overhead names, which overlapping names and
   * combat text made unreliable (real monsters ended up skipped). Keep what holds
   * up: kills confirmed by the target frame, and the user's own rules.
   */
  private loadV1(saved: SavedNameV1[]): void {
    const mostKills = new Map<string, number>();
    for (const old of saved) {
      if (old.rule !== 'auto') {
        const key = LABEL_RULE + old.fingerprint;
        this.entries.set(key, { key, image: old.image, rule: old.rule, kills: 0, strikes: 0 });
      }
      // A single kill was often a pet's kill credited to whatever had been clicked.
      if (!old.frameName || old.kills < 2) continue;
      let entry = this.entries.get(old.frameName);
      if (!entry) {
        entry = { key: old.frameName, image: old.image, rule: 'auto', kills: 0, strikes: 0, provisional: true };
        this.entries.set(old.frameName, entry);
      }
      entry.kills += old.kills;
      if (old.kills > (mostKills.get(old.frameName) ?? 0)) {
        mostKills.set(old.frameName, old.kills);
        entry.image = old.image;
      }
      this.labels.set(old.fingerprint, new Map([[old.frameName, old.kills]]));
    }
  }

  toJSON(): SavedNames {
    const labels: [string, string, number][] = [];
    for (const [label, names] of this.labels) for (const [name, count] of names) labels.push([label, name, count]);
    return { version: 2, names: [...this.entries.values()], labels, blanks: [...this.blanks].map(([label, { count, at }]) => [label, count, at]) };
  }

  private changed(): void {
    this.known = null;
    this.rulings.clear();
    this.onChange();
  }

  // ---- Before clicking: what an overhead name is known to be ----

  /**
   * Whether an overhead name is a monster, harmless, or not known yet. Names
   * run together with other names are judged by a known name inside them (and
   * aimed at its middle); partly hidden names by the known name they're part of.
   */
  judgeLabel(label: Label): Judgement {
    let ruling = this.rulings.get(label.fingerprint);
    if (!ruling) {
      ruling = this.rule(label);
      this.rulings.set(label.fingerprint, ruling);
    }
    return { kind: ruling.kind, label: partOf(label, ruling.at, ruling.length) };
  }

  private rule(label: Label): Ruling {
    const keys = label.glyphs.map((glyph) => glyph.key);
    const all: Ruling = { kind: this.verdictOf(label.fingerprint), at: 0, length: keys.length };
    if (all.kind !== 'unknown' || keys.length === 0) return all;

    let inside: { known: KnownLabel; at: number } | null = null;
    let whole: Verdict | null = null;
    let disagree = false;
    for (const known of this.knownLabels()) {
      const n = known.glyphs.length;
      if (n < MIN_PART_GLYPHS) continue;
      if (n < keys.length) {
        const at = indexOfRun(keys, known.glyphs);
        if (at < 0) continue;
        // Monsters first, then the longest name.
        const better =
          !inside ||
          (known.kind === 'monster' && inside.known.kind !== 'monster') ||
          (known.kind === inside.known.kind && n > inside.known.glyphs.length);
        if (better) inside = { known, at };
      } else if (n > keys.length && keys.length >= MIN_PART_GLYPHS && keys.length >= n * PART_SHARE) {
        if (indexOfRun(known.glyphs, keys) < 0) continue;
        if (whole && whole !== known.kind) disagree = true;
        whole = known.kind;
      }
    }

    if (inside) {
      const { known, at } = inside;
      if (known.kind === 'monster') return { kind: 'monster', at, length: known.glyphs.length };
      // A harmless name run together with something else: the something else is still worth a look.
      const before = at;
      const after = keys.length - at - known.glyphs.length;
      if (Math.max(before, after) >= MIN_PART_GLYPHS) {
        return before >= after ? { kind: 'unknown', at: 0, length: before } : { kind: 'unknown', at: at + known.glyphs.length, length: after };
      }
      return { kind: 'harmless', at, length: known.glyphs.length };
    }
    if (whole && !disagree) return { ...all, kind: whole };
    return all;
  }

  private verdictOf(fingerprint: string): Verdict {
    const rule = this.entries.get(LABEL_RULE + fingerprint)?.rule;
    if (rule === 'attack') return 'monster';
    if (rule === 'ignore') return 'harmless';
    const name = this.nameOf(fingerprint);
    if (name !== null) {
      if (!this.isAttackable(name)) return 'harmless';
      return this.isKnownMonster(name) ? 'monster' : 'unknown';
    }
    const blank = this.blanks.get(fingerprint);
    return blank && blank.count >= BLANKS_TO_IGNORE && this.clock() - blank.at < BLANK_EXPIRY_MS ? 'harmless' : 'unknown';
  }

  /** The target-frame name an overhead name has turned out to be most often. */
  nameOf(fingerprint: string): string | null {
    const names = this.labels.get(fingerprint);
    if (!names) return null;
    let best: string | null = null;
    let most = 0;
    for (const [name, count] of names) {
      if (count > most && this.entries.has(name)) {
        best = name;
        most = count;
      }
    }
    return best;
  }

  /** Overhead names with a verdict, for judging merged and partly hidden ones. */
  private knownLabels(): KnownLabel[] {
    if (this.known) return this.known;
    const known: KnownLabel[] = [];
    const seen = new Set<string>();
    const add = (fingerprint: string) => {
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      const kind = this.verdictOf(fingerprint);
      if (kind !== 'unknown') known.push({ fingerprint, glyphs: fingerprint.split('|'), kind });
    };
    for (const fingerprint of this.labels.keys()) add(fingerprint);
    for (const key of this.entries.keys()) if (key.startsWith(LABEL_RULE)) add(key.slice(LABEL_RULE.length));
    for (const fingerprint of this.blanks.keys()) add(fingerprint);
    this.known = known;
    return known;
  }

  // ---- After clicking: what the target frame showed ----

  /** Registers a name shown in the target frame; `image` is only drawn for a new name. */
  see(name: string, image: () => string): void {
    const entry = this.entries.get(name);
    if (!entry) {
      this.entries.set(name, { key: name, image: image(), rule: 'auto', kills: 0, strikes: 0 });
      this.changed();
    } else if (entry.provisional) {
      entry.image = image();
      delete entry.provisional;
      this.changed();
    }
  }

  isAttackable(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return true;
    if (entry.rule !== 'auto') return entry.rule === 'attack';
    return entry.kills > 0 || entry.strikes < STRIKES_TO_IGNORE;
  }

  /** Known to be a monster: it has died to us before (or the user says so). */
  isKnownMonster(name: string): boolean {
    const entry = this.entries.get(name);
    return !!entry && (entry.rule === 'attack' || entry.kills > 0);
  }

  /** A kill; `label` is the overhead name that was clicked, if it surely was this one. */
  recordKill(name: string, label: string | null): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.kills++;
    if (label) this.link(label, name);
    this.changed();
  }

  /** A fight where it never lost HP. */
  recordStrike(name: string, label: string | null): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    if (entry.kills === 0) entry.strikes++;
    if (label) this.link(label, name);
    this.changed();
  }

  /** Clicking an overhead name surely brought up this target-frame name. */
  noteLabel(label: string, name: string): void {
    if (!this.entries.has(name)) return;
    this.link(label, name);
    this.changed();
  }

  /** Clicked an overhead name and the target frame showed nothing for it. */
  recordBlank(label: string): void {
    if (this.labels.has(label)) return;
    const blank = this.blanks.get(label);
    const now = this.clock();
    // An old blank has expired: count afresh.
    const count = blank && now - blank.at < BLANK_EXPIRY_MS ? blank.count : 0;
    this.blanks.set(label, { count: count + 1, at: now });
    this.changed();
  }

  private link(label: string, name: string): void {
    let names = this.labels.get(label);
    if (!names) {
      names = new Map();
      this.labels.set(label, names);
      if (this.labels.size > MAX_LABELS) this.prune();
    }
    names.set(name, (names.get(name) ?? 0) + 1);
    this.blanks.delete(label);
  }

  private prune(): void {
    const total = (names: Map<string, number>) => [...names.values()].reduce((sum, count) => sum + count, 0);
    const ranked = [...this.labels].sort((a, b) => total(a[1]) - total(b[1]));
    for (const [label] of ranked.slice(0, ranked.length - Math.floor(MAX_LABELS * 0.9))) this.labels.delete(label);
  }

  // ---- The user's view ----

  setRule(key: string, rule: NameRule): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (key.startsWith(LABEL_RULE) && rule === 'auto') {
      // An old rule on an overhead name: back to automatic means it's no longer needed.
      this.entries.delete(key);
    } else {
      entry.rule = rule;
      // Back to automatic means learning from scratch.
      if (rule === 'auto') entry.strikes = 0;
    }
    this.changed();
  }

  forget(key: string): void {
    if (!this.entries.delete(key)) return;
    for (const names of this.labels.values()) names.delete(key);
    this.changed();
  }

  list(): NameEntry[] {
    return [...this.entries.values()]
      .map(({ key, image, rule, kills, strikes }) => ({
        fingerprint: key,
        image,
        rule,
        kills,
        strikes,
        attacking: key.startsWith(LABEL_RULE) ? rule !== 'ignore' : this.isAttackable(key),
      }))
      .sort((a, b) => Number(b.attacking) - Number(a.attacking) || b.kills - a.kills || b.strikes - a.strikes);
  }
}
