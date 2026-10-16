/**
 * Casting by what the game shows: which skill each spell key has on it (the skill bar's key set in use), what kind of
 * skill it is, and when to press it. A passive skill is never pressed. A buff skill (one whose buff the readings have
 * shown come from it) is pressed when its buff is missing or about to run out, in a fight or not. Any other skill is
 * pressed in a fight as soon as the game says it's ready and there's the MP for it, never faster than its delay. After
 * each press the next readings should show it took (the buff back, the cooldown started, the MP spent); a key whose
 * presses keep not taking is left alone for a while, and the status says so. Pure apart from the reading it's given:
 * the bot (bot-context.ts) does the pressing.
 */
import type { KeyId, KeySetting, KeyView } from '../shared/types';
import type { MemorySkill, MemoryState } from './game-memory';

/** Every number casting goes by. */
export const CASTING = {
  /** A buff is cast again with this much left (plus the reader's gap between readings, so a reading late doesn't let it lapse). */
  buffMarginMs: 3000,
  /** After a press, the readings have this long to show it took. */
  checkMs: 1500,
  /** Presses in a row that don't take before the key is left alone... */
  failuresToBackOff: 3,
  /** ...for this long. */
  backOffMs: 60_000,
};

/** How a key is pressed: by what the game shows, every N seconds (the old way), or not at all. */
export type KeyMode = 'auto' | 'every' | 'off';

/** A key's mode: a setting saved before there were modes is pressed as it always was (every N s if ticked, else not). */
export function keyMode(setting: KeySetting | undefined): KeyMode {
  return setting?.when ?? (setting?.enabled ? 'every' : 'off');
}

/** F1-F12 are the skill bar's Spell01-Spell12 (on the key set in use); other keys have no skill. */
export function spellKeyOf(id: KeyId): string | null {
  const f = /^F(\d+)$/.exec(id);
  return f ? `Spell${f[1].padStart(2, '0')}` : null;
}

export type SkillKind = 'passive' | 'buff' | 'attack';

/** The key set in use (1-4; 1 when the reading doesn't say). */
const keySet = (reading: MemoryState | null) => reading?.user?.spellSet ?? 1;

/** A press waiting to show in the readings. */
interface Pending {
  at: number;
  mp: number | null;
  /** The lowest MP seen since. */
  lowest: number | null;
  /** Its buff's seconds left when pressed (null: none up, or permanent; undefined: no buff known for it). */
  buffLeft: number | null | undefined;
}

interface KeyState {
  lastPress: number | null;
  pending: Pending | null;
  failures: number;
  backOffUntil: number;
  /** Why it's being left alone, for the window. */
  note: string | null;
}

export class SkillCaster {
  /** Skills whose buffs the readings have shown (by MagicType): their buff's type. Kept for the session. */
  private readonly buffOf = new Map<string, string>();
  private readonly keys = new Map<KeyId, KeyState>();

  private stateOf(id: KeyId): KeyState {
    let state = this.keys.get(id);
    if (!state) this.keys.set(id, (state = { lastPress: null, pending: null, failures: 0, backOffUntil: 0, note: null }));
    return state;
  }

  /** The skill on key `id` in the key set in use; null for none (or no skills in the reading). */
  skillOn(reading: MemoryState | null, id: KeyId): MemorySkill | null {
    const spell = spellKeyOf(id);
    const set = keySet(reading);
    return (spell && reading?.user?.skills?.find((s) => s.keys[set - 1] === spell)) || null;
  }

  /** What kind of skill it is: passive (its school), a buff (its buff has been seen), else an attack (or not known yet). */
  kind(skill: MemorySkill): SkillKind {
    if (skill.school === 'Passive') return 'passive';
    return this.buffOf.has(skill.magic) ? 'buff' : 'attack';
  }

  /** Takes in a reading: what buffs come from which skills. */
  learn(reading: MemoryState | null): void {
    for (const buff of reading?.user?.buffs ?? []) if (buff.source) this.buffOf.set(buff.source, buff.type);
  }

  /** The buff `skill` gives, as on now: undefined when none is known to come from it, else its seconds left (null: permanent). */
  private buffLeft(reading: MemoryState | null, skill: MemorySkill): number | null | undefined {
    if (!this.buffOf.has(skill.magic)) return undefined;
    const buff = reading?.user?.buffs?.find((b) => b.source === skill.magic);
    if (!buff) return 0;
    return buff.paused ? null : buff.left;
  }

  /**
   * Whether to press key `id` (in auto) now. `fighting`: with a target. `gapMs`: the reader's gap between readings
   * (p90), for the buff margin. Also settles the last press (took or not); returns what to say, if anything.
   */
  due(id: KeyId, setting: KeySetting, reading: MemoryState | null, now: number, fighting: boolean, gapMs = 0): { press: boolean; say: string | null } {
    const state = this.stateOf(id);
    const skill = this.skillOn(reading, id);
    // A buff already on (from before the run) says which skill gives it, before any press.
    this.learn(reading);
    const say = skill ? this.settle(id, state, skill, reading, now) : null;
    const no = { press: false, say };
    const user = reading?.user;
    if (!skill || !user || user.dead || this.kind(skill) === 'passive') return no;
    if (now < state.backOffUntil || state.pending) return no;
    if (user.mp !== undefined && user.mp !== null && user.mp < skill.cost) {
      state.note = 'waiting for MP';
      return no;
    }
    state.note = null;
    if (skill.readyIn > 0) return no;
    // Never faster than the game could take it: its delay, else the key's old seconds.
    const minGap = skill.delay > 0 ? skill.delay : setting.seconds * 1000;
    if (state.lastPress !== null && now - state.lastPress < minGap) return no;
    if (this.kind(skill) === 'buff') {
      const left = this.buffLeft(reading, skill);
      return { press: left === 0 || (left !== null && left !== undefined && left * 1000 < CASTING.buffMarginMs + gapMs), say };
    }
    return { press: fighting, say };
  }

  /** Key `id` was just pressed. */
  pressed(id: KeyId, reading: MemoryState | null, now: number): void {
    const state = this.stateOf(id);
    const skill = this.skillOn(reading, id);
    state.lastPress = now;
    const mp = reading?.user?.mp ?? null;
    const buffLeft = skill ? this.buffLeft(reading, skill) : undefined;
    // Nothing the game shows would tell whether it took (no MP to spend, no buff known to come from it): not waited on,
    // so an attack that costs nothing is pressed every round, as F1 always was.
    state.pending = skill && (skill.cost > 0 || buffLeft !== undefined) ? { at: now, mp, lowest: mp, buffLeft } : null;
  }

  /** The last press of key `id`, once the readings have had their time: whether it took. What to say about it, if anything. */
  private settle(id: KeyId, state: KeyState, skill: MemorySkill, reading: MemoryState | null, now: number): string | null {
    const pending = state.pending;
    if (!pending) return null;
    this.learn(reading);
    const user = reading?.user;
    if (user?.mp !== undefined && user.mp !== null) pending.lowest = pending.lowest === null ? user.mp : Math.min(pending.lowest, user.mp);
    // Took: its buff came back (or more of it), its cooldown started, or its MP went.
    const left = this.buffLeft(reading, skill);
    const buffBack = left !== undefined && (left === null || (left > 0 && (pending.buffLeft === undefined || pending.buffLeft === null || left > pending.buffLeft + 0.5)));
    const mpSpent = skill.cost > 0 && pending.mp !== null && pending.lowest !== null && pending.lowest <= pending.mp - Math.max(1, skill.cost / 2);
    if (buffBack || skill.readyIn > 0 || mpSpent) {
      state.pending = null;
      state.failures = 0;
      return null;
    }
    if (now - pending.at < CASTING.checkMs) return null;
    state.pending = null;
    // Nothing the game shows would tell (no MP, no buff, no cooldown): taken as done.
    if (skill.cost <= 0 && left === undefined) return null;
    if (++state.failures < CASTING.failuresToBackOff) return null;
    state.failures = 0;
    state.backOffUntil = now + CASTING.backOffMs;
    const why = user?.mp !== undefined && user.mp !== null && user.mp < skill.cost ? 'not enough MP' : 'no sign of it in the game (out of range, silenced, or not the skill on that key?)';
    state.note = `not taking: tried again in ${CASTING.backOffMs / 1000} s`;
    return `${skill.name} (${id}) isn't taking: ${why}; leaving it for ${CASTING.backOffMs / 1000} s`;
  }

  /** For the Keys & potions tab: each F-key's skill on the key set in use, its kind and its buff's time left. */
  view(reading: MemoryState | null, now: number): { keys: Partial<Record<KeyId, KeyView>>; elsewhere: string[] } | null {
    const skills = reading?.user?.skills;
    if (!skills) return null;
    this.learn(reading);
    const keys: Partial<Record<KeyId, KeyView>> = {};
    for (let n = 1; n <= 12; n++) {
      const id = `F${n}` as KeyId;
      const skill = this.skillOn(reading, id);
      if (!skill) continue;
      const kind = this.kind(skill);
      const state = this.keys.get(id);
      const left = kind === 'buff' ? this.buffLeft(reading, skill) : undefined;
      keys[id] = {
        skill: skill.name, level: skill.level, kind,
        ...(left !== undefined && { left }),
        ...(state && now < state.backOffUntil ? { note: state.note ?? 'not taking' } : state?.note ? { note: state.note } : {}),
      };
    }
    // Skills on keys the bot doesn't press (Spell13-Spell24 on this key set).
    const set = keySet(reading);
    const elsewhere = skills.filter((s) => {
      const n = /^Spell(\d+)$/.exec(s.keys[set - 1] ?? '');
      return n && Number(n[1]) > 12;
    }).map((s) => `${s.name} (${s.keys[set - 1]})`);
    return { keys, elsewhere };
  }
}
