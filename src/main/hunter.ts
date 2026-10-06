import type { Point } from '../shared/types';
import { indexOfRun, type Label } from './labels';
import type { NameBook } from './names';
import { isFloating, isSettled, type Sighting } from './sightings';

/** Target frame readings this soon after going for a target may still be about the previous one. */
const FRAME_SETTLE_MS = 250;
/** If the target frame hasn't shown what's being clicked by then, there's nothing there that can be targeted. */
const CONFIRM_MS = 1800;
/** A target out of sight this long is gone... */
const LOST_MS = 2000;
/** ...unless the frame shows it still losing HP (hidden under effects or other names), for up to this long. */
const HIDDEN_FIGHT_MS = 5000;
/** Its HP not going down for this long, after it had been, means we can't reach it. */
const STUCK_MS = 12_000;
/** Time allowed to walk up and land the first hit: a base plus some per pixel of distance. */
const VERIFY_BASE_MS = 4000;
const VERIFY_MS_PER_PIXEL = 15;
/** Attacks it must take without losing HP before it counts as harmless. */
const MIN_ATTACKS = 4;
/** Fighting hand to hand, the character must have got this close to a target (its name) for it to count as harmless. */
const MELEE_REACH = 110;
/** Known monsters win over nearer unknown names unless those are this much closer. */
const KNOWN_MONSTER_BONUS = 150;
/**
 * Where to click, relative to the middle of the overhead name. The name sits on
 * the body of most monsters but over the top of some and below others, so until
 * the target frame shows the target (or its HP goes down), try a little above and below.
 */
const AIM_OFFSETS = [0, -12, 10];
const AIM_SWITCH_MS = 450;
/** Confirmed but still not losing HP this long after: maybe the clicks are missing, so try the other aim points. */
const REAIM_AFTER_MS = 2000;
/** With its own name out of sight, the nearest name within this distance is taken to be it (growing the longer it's been gone). */
const REFIND_BASE = 40;
const REFIND_PER_MS = 0.12;
const REFIND_MAX = 160;
/** Names given up on are left alone this long, and so is the spot they were in, briefly, in case they're seen afresh. */
const AVOID_NOTHING_MS = 30_000;
const AVOID_UNREACHABLE_MS = 20_000;
const AVOID_HARMLESS_MS = 60_000;
const AVOID_SPOT_MS = 3000;
const AVOID_RADIUS = 30;
/** The same name this close to where it was given up on is still avoided (after looting, say, it's seen afresh but hasn't gone far). */
const AVOID_SAME_NAME_RADIUS = 120;
/** Smaller changes in the HP bar are reading noise (the bar is 127 pixels wide). */
const HP_EPSILON = 0.004;
/** Stands in for a target-frame name that couldn't be read (not white text): fought, but nothing is learned. */
const UNREAD = '?';

/** What the target frame at the top of the screen shows. */
export interface TargetFrame {
  /** HP bar, 0-1 (0 once dead). */
  hp: number;
  /** Fingerprint of the name written in the frame, or null if it couldn't be read. */
  name: string | null;
  /**
   * The "hp / max" text's pixels. It changes whenever the HP does, which shows
   * damage the bar can't: the bar's end can be hidden under the text.
   */
  hpText?: string;
  /** Draws the name, for the names list. */
  image?: () => string;
}

export interface Target {
  /** The sighting of its overhead name. */
  sightingId: number;
  /** Its overhead name when it was picked: what's learned about it is linked to this. */
  labelFingerprint: string;
  /** The middle of its overhead name. */
  position: Point;
  /** How far away it was when picked, and the closest it has been since. */
  startDistance: number;
  closest: number;
  startedAt: number;
  lastSeenAt: number;
  /** What the target frame showed just before going for it. */
  frameBefore: TargetFrame | null;
  /** Its name in the target frame, once the frame shows it. */
  name: string | null;
  confirmedAt: number | null;
  /**
   * The frame changed to this name when we went for it, so the name is surely
   * this target's and not, say, a previous target's of the same kind.
   */
  attributable: boolean;
  lastHp: number | null;
  lastHpText: string | null;
  /** Highest HP seen while fighting it; a dead previous target never shows more than 0. */
  maxHp: number;
  /** When its HP last went down; null until it has. */
  lastHpDropAt: number | null;
  /** Clicks and attack spells aimed at it since the frame showed it. */
  attacks: number;
  /** Which of AIM_OFFSETS is being used. */
  aim: number;
}

export type GiveUpReason = 'lost' | 'harmless' | 'stuck' | 'nothing' | 'noDamage';

export type Decision =
  /** `select`: click it so the target frame shows it (it doesn't yet). */
  | { kind: 'attack'; target: Target; point: Point; select: boolean }
  | { kind: 'killed'; target: Target }
  | { kind: 'gaveUp'; target: Target; reason: GiveUpReason }
  /** `pending`: there are names that may be worth attacking once they've been on screen a moment longer. */
  | { kind: 'search'; pending: boolean };

interface Avoided {
  sightingId: number;
  fingerprint: string;
  point: Point;
  until: number;
  /** The spot itself is only avoided until then. */
  spotUntil: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Where to aim on a label: the middle of the target's own name, if it has been run together with others. */
function centreOf(label: Label, fingerprint: string): Point {
  if (label.fingerprint === fingerprint) return label.centre;
  const own = fingerprint.split('|');
  const keys = label.glyphs.map((glyph) => glyph.key);
  const at = own.length < keys.length ? indexOfRun(keys, own) : -1;
  if (at < 0) return label.centre;
  const left = label.glyphs[at].left;
  const right = label.glyphs[at + own.length - 1].right;
  return { x: Math.round((left + right) / 2), y: label.centre.y };
}

/**
 * Picks targets from the names on screen and judges each fight by the target
 * frame. Once it has a target it stays on it until the frame shows it dead, it
 * can't be hurt, or it's gone.
 */
export class Hunter {
  target: Target | null = null;
  /** Attacking hand to hand (so the character has to reach a target), rather than with a spell from afar. */
  melee = true;
  private avoid: Avoided[] = [];

  constructor(
    private readonly names: NameBook,
    private readonly player: Point,
  ) {}

  reset(): void {
    this.target = null;
    this.avoid = [];
  }

  /**
   * @param sightings names on screen this scan
   * @param frame what the target frame shows, or null if it isn't showing
   */
  think(sightings: Sighting[], frame: TargetFrame | null, now: number): Decision {
    this.avoid = this.avoid.filter((spot) => spot.until > now);
    const shown = frame && { ...frame, name: frame.name ?? UNREAD };
    if (this.target) return this.follow(this.target, sightings, shown, now);
    return this.pick(sightings, shown, now);
  }

  /** The bot attacked the target (a melee click or an attack spell). */
  attacked(): void {
    if (this.target?.name) this.target.attacks++;
  }

  private follow(target: Target, sightings: Sighting[], frame: TargetFrame | null, now: number): Decision {
    const seen = sightings.find((sighting) => sighting.id === target.sightingId) ?? this.refind(target, sightings, now);
    if (seen) {
      target.sightingId = seen.id;
      target.position = centreOf(seen.label, target.labelFingerprint);
      target.lastSeenAt = now;
      target.closest = Math.min(target.closest, distance(this.player, target.position));
    }

    if (frame && now - target.startedAt >= FRAME_SETTLE_MS) {
      if (target.name === null) {
        const decision = this.confirm(target, frame, now);
        if (decision) return decision;
      }
      if (target.name !== null && frame.name === target.name) {
        const barDropped = target.lastHp !== null && frame.hp < target.lastHp - HP_EPSILON;
        const barRose = target.lastHp !== null && frame.hp > target.lastHp + HP_EPSILON;
        const textChanged = target.lastHpText !== null && frame.hpText !== undefined && frame.hpText !== target.lastHpText;
        if (barDropped || (textChanged && !barRose)) target.lastHpDropAt = now;
        target.lastHp = frame.hp;
        target.lastHpText = frame.hpText ?? null;
        target.maxHp = Math.max(target.maxHp, frame.hp);
        if (frame.hp <= 0 && target.maxHp > 0) return this.finish({ kind: 'killed', target });
      }
    }

    if (target.name === null) {
      if (now - target.startedAt <= CONFIRM_MS) return this.attack(target, now);
      // Clicked it for a while and the frame never showed it: not something that can be targeted.
      this.names.recordBlank(target.labelFingerprint);
      return this.giveUp(target, 'nothing', AVOID_NOTHING_MS, now);
    }

    const hidden = now - target.lastSeenAt;
    if (hidden > LOST_MS) {
      const stillLosingHp = target.lastHpDropAt !== null && now - target.lastHpDropAt < LOST_MS && frame?.name === target.name;
      if (!stillLosingHp || hidden > HIDDEN_FIGHT_MS) return this.giveUp(target, 'lost', 0, now);
    }

    if (target.lastHpDropAt === null) {
      const waited = now - target.confirmedAt!;
      const allowed = VERIFY_BASE_MS + target.startDistance * VERIFY_MS_PER_PIXEL;
      if (waited > allowed && target.attacks >= MIN_ATTACKS) {
        // Only a name the frame surely showed for this target can be blamed, and
        // only if it was in reach (not, say, across a wall).
        if (target.attributable && (!this.melee || target.closest <= MELEE_REACH)) {
          this.names.recordStrike(target.name, target.labelFingerprint);
          return this.giveUp(target, 'harmless', AVOID_HARMLESS_MS, now);
        }
        return this.giveUp(target, 'noDamage', AVOID_UNREACHABLE_MS, now);
      }
      // Not attacking it at all (no melee or attack spell set up): move on without blaming it.
      if (waited > allowed * 2) return this.giveUp(target, 'noDamage', AVOID_UNREACHABLE_MS, now);
    } else if (now - target.lastHpDropAt > STUCK_MS) {
      return this.giveUp(target, 'stuck', AVOID_UNREACHABLE_MS, now);
    }

    return this.attack(target, now);
  }

  /** Decides whether the target frame now shows this target, and learns its name. */
  private confirm(target: Target, frame: TargetFrame, now: number): Decision | null {
    const name = frame.name!;
    const before = target.frameBefore;
    const switched = !before || before.name !== name || (before.hp <= 0 && frame.hp > 0);
    // The frame may still be showing the previous target, but this overhead name is known to be that kind of thing anyway.
    const linked = name !== UNREAD && this.names.nameOf(target.labelFingerprint) === name;
    // Still showing the previous target (dead, or something given up on): not this one yet.
    if (!switched && (frame.hp <= 0 || (!linked && name !== UNREAD && !this.names.isAttackable(name)))) return null;

    target.name = name;
    target.confirmedAt = now;
    target.attributable = (switched || linked) && name !== UNREAD;
    if (name === UNREAD) return null;
    if (frame.image) this.names.see(name, frame.image);
    if (target.attributable && !this.names.isAttackable(name)) {
      // Known to be harmless: skip it, and recognise this overhead name next time without clicking.
      this.names.noteLabel(target.labelFingerprint, name);
      return this.giveUp(target, 'harmless', AVOID_HARMLESS_MS, now);
    }
    return null;
  }

  private attack(target: Target, now: number): Decision {
    const searching = target.name === null || (target.lastHpDropAt === null && now - target.confirmedAt! > REAIM_AFTER_MS);
    if (searching) target.aim = Math.floor((now - target.startedAt) / AIM_SWITCH_MS) % AIM_OFFSETS.length;
    const point = { x: target.position.x, y: target.position.y + AIM_OFFSETS[target.aim] };
    return { kind: 'attack', target, point, select: target.name === null };
  }

  /** Its own name is out of sight (run together with another, or covered): the nearest name around where it was is probably it. */
  private refind(target: Target, sightings: Sighting[], now: number): Sighting | null {
    const reach = Math.min(REFIND_BASE + (now - target.lastSeenAt) * REFIND_PER_MS, REFIND_MAX);
    let best: Sighting | null = null;
    let bestDistance = reach;
    for (const sighting of sightings) {
      if (isFloating(sighting, now) || this.names.judgeLabel(sighting.label).kind === 'harmless') continue;
      const d = distance(sighting.label.centre, target.position);
      if (d <= bestDistance) {
        best = sighting;
        bestDistance = d;
      }
    }
    return best;
  }

  private giveUp(target: Target, reason: GiveUpReason, avoidMs: number, now: number): Decision {
    if (avoidMs > 0) {
      this.avoid.push({
        sightingId: target.sightingId,
        fingerprint: target.labelFingerprint,
        point: { ...target.position },
        until: now + avoidMs,
        spotUntil: now + AVOID_SPOT_MS,
      });
    }
    return this.finish({ kind: 'gaveUp', target, reason });
  }

  private finish(decision: Extract<Decision, { kind: 'killed' | 'gaveUp' }>): Decision {
    const { target } = decision;
    if (decision.kind === 'killed' && target.name && target.name !== UNREAD) {
      this.names.recordKill(target.name, target.attributable ? target.labelFingerprint : null);
    }
    this.target = null;
    return decision;
  }

  private isAvoided(sighting: Sighting, now: number): boolean {
    return this.avoid.some((spot) => {
      if (spot.sightingId === sighting.id) return true;
      const d = distance(spot.point, sighting.label.centre);
      return (now < spot.spotUntil && d < AVOID_RADIUS) || (spot.fingerprint === sighting.label.fingerprint && d < AVOID_SAME_NAME_RADIUS);
    });
  }

  private pick(sightings: Sighting[], frame: TargetFrame | null, now: number): Decision {
    let best: { sighting: Sighting; label: Label } | null = null;
    let bestScore = Infinity;
    let pending = false;
    for (const sighting of sightings) {
      if (this.isAvoided(sighting, now)) continue;
      const judged = this.names.judgeLabel(sighting.label);
      if (judged.kind === 'harmless') continue;
      if (!isSettled(sighting, now)) {
        pending ||= !isFloating(sighting, now);
        continue;
      }
      const score = distance(this.player, judged.label.centre) - (judged.kind === 'monster' ? KNOWN_MONSTER_BONUS : 0);
      if (score < bestScore) {
        best = { sighting, label: judged.label };
        bestScore = score;
      }
    }
    if (!best) return { kind: 'search', pending };

    this.target = {
      sightingId: best.sighting.id,
      labelFingerprint: best.label.fingerprint,
      position: best.label.centre,
      startDistance: distance(this.player, best.label.centre),
      closest: distance(this.player, best.label.centre),
      startedAt: now,
      lastSeenAt: now,
      frameBefore: frame && { hp: frame.hp, name: frame.name },
      name: null,
      confirmedAt: null,
      attributable: false,
      lastHp: null,
      lastHpText: null,
      maxHp: 0,
      lastHpDropAt: null,
      attacks: 0,
      aim: 0,
    };
    return this.attack(this.target, now);
  }
}
