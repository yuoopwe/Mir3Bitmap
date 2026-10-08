/**
 * Elixirs: with "Keep elixirs up" ticked, while grinding and on the Boss
 * circuit, each kind of elixir with a belt key set is drunk when the stat
 * guide says it pays (it raises what the character does by enough, and some
 * are in the bag) and it isn't still working. A drink is confirmed by the
 * bag's count of that kind going down (gear.counts, read once a second); one
 * that doesn't is not tried again this run. The game's buffs aren't read, so
 * an elixir counts as working for its duration from the drink seen.
 */
import { loadTravelData } from './travel';
import { keyCode } from './bot-shared';
import type { BotContext } from './bot-context';

/** The kinds of elixir, as the settings' keys name them (the game's effect, less "Elixir"). */
export const ELIXIR_KINDS = ['Haste', 'Destruction', 'Life', 'Mana', 'Nature', 'Spirit'];

/** A drink that doesn't show in the bag's count within this long didn't happen. */
const CONFIRM_MS = 3000;

/** Drunk again this long before the last one runs out. */
const RENEW_EARLY_MS = 10_000;

export class Elixirs {
  /** When each kind (by the clock) runs out. */
  private readonly until = new Map<string, number>();
  /** A press waiting to show in the bag: the kind, the elixir, how many of the kind were in the bag, and when. */
  private pending: { kind: string; name: string; before: number; at: number } | null = null;
  /** Kinds whose key didn't drink anything: left alone this run. */
  private readonly failed = new Set<string>();

  constructor(private readonly bot: BotContext) {}

  /** A new run: every kind tried afresh (what's still working is remembered). */
  reset(): void {
    this.pending = null;
    this.failed.clear();
  }

  /** How many of a kind of elixir the bag holds, all strengths together. */
  private count(kind: string): number | null {
    const counts = this.bot.options.memory.latest()?.gear?.counts;
    if (!counts) return null;
    const names = (loadTravelData().consumables ?? []).filter((c) => c.effect === `${kind}Elixir`).map((c) => c.name);
    return names.reduce((sum, name) => sum + (counts[name] ?? 0), 0);
  }

  /** Called as the hunt goes on: confirms the last drink, or drinks the next elixir due. Grind and the Boss circuit only. */
  upkeep(): void {
    const settings = this.bot.settings.elixirs;
    if (!settings?.enabled || (this.bot.mode !== 'grind' && this.bot.mode !== 'circuit')) return;
    const now = this.bot.clock.now();
    const pending = this.pending;
    if (pending) {
      const left = this.count(pending.kind);
      if (left !== null && left < pending.before) {
        const advice = this.bot.guide.elixir(pending.kind);
        this.until.set(pending.kind, pending.at + (advice?.seconds ?? 3600) * 1000);
        this.pending = null;
        this.bot.status(`Drank ${pending.name}: ${left} left`);
      } else if (now - pending.at > CONFIRM_MS) {
        this.failed.add(pending.kind);
        this.pending = null;
        this.bot.status(`${pending.name} didn't go down in the bag after pressing ${settings.keys[pending.kind]} (is it on that belt key?): not drinking it again this run`);
      }
      return;
    }
    for (const kind of ELIXIR_KINDS) {
      const vk = keyCode(settings.keys[kind] ?? '');
      if (vk === null || this.failed.has(kind) || now < (this.until.get(kind) ?? 0) - RENEW_EARLY_MS) continue;
      const advice = this.bot.guide.elixir(kind);
      const before = this.count(kind);
      if (!advice?.pays || !before) continue;
      this.bot.status(`Drinking ${advice.name} (${settings.keys[kind]}): ${advice.line.slice(advice.line.indexOf(': ') + 2)}`);
      this.bot.key(vk);
      this.pending = { kind, name: advice.name, before, at: now };
      return;
    }
  }
}
