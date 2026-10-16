/**
 * The area index: a map's monsters with their stats (the game data's), what it
 * takes to fight there, and with the character's stats, how they'd fare (the
 * combat model's fights). For the Areas tab. Pure: no game, no screen.
 */
import { COMBAT, fight, foeOf, survivalGap, withStats, type Fighter, type Foe } from './combat-model';
import { mapMonsters } from './grind';
import { mapName, searchPlaces, type Place, type TravelData } from './travel';
import type { AreaView, AreaMonsterRow } from '../shared/types';

/** Every number the index is tuned by, in one place. */
export const AREA_INDEX = {
  /** Monsters making up less than this share of a map's don't decide what it needs (one odd spawn shouldn't). */
  minShare: 0.03,
  /** "To kill quickly": the attack at which the map's monsters take this long a kill on average, counted by how many there are. */
  quickKillSeconds: 4,
  /** The most extra attack looked for. */
  maxExtraAttack: 1000,
};

/** The maps with monsters to hunt whose names match `query`, best first (as Travel's search ranks them), with their monsters' levels. */
export function searchAreas(data: TravelData, query: string, limit = 30): { map: number; label: string }[] {
  const list: Place[] = data.maps.filter((m) => mapMonsters(data, m.i)?.length).map((m) => ({ id: `map:${m.i}`, label: m.name, map: m.i }));
  return searchPlaces(list, query, limit).map((p) => {
    const levels = mapMonsters(data, p.map)!.map((m) => m.level);
    const range = Math.min(...levels) === Math.max(...levels) ? `${levels[0]}` : `${Math.min(...levels)}–${Math.max(...levels)}`;
    return { map: p.map, label: `${p.label} (monsters lv ${range})` };
  });
}

/** Whether a monster hits with DC (against AC), else with MC or SC (against MR): by its biggest, as the combat model has it. */
function physical(foe: Foe): boolean {
  return foe.maxDC >= Math.max(foe.maxMC, foe.maxSC);
}

/** The attack stat the character fights with, as the combat model picks it: DC for Warriors, Assassins, Archers and Blade Dancers; else the bigger of MC and SC. */
function attackStat(me: Fighter): 'DC' | 'MC' | 'SC' {
  if ([0, 3, 6, 7].includes(me.cls)) return 'DC';
  if (me.cls === 1) return 'MC';
  if (me.cls === 2) return 'SC';
  return me.maxDC >= Math.max(me.maxMC, me.maxSC) ? 'DC' : me.maxMC >= me.maxSC ? 'MC' : 'SC';
}

/** The character with `n` more of their attack stat (min and max both). */
function moreAttack(me: Fighter, stat: 'DC' | 'MC' | 'SC', n: number): Fighter {
  return stat === 'DC' ? withStats(me, { minDC: n, maxDC: n }) : stat === 'MC' ? withStats(me, { minMC: n, maxMC: n }) : withStats(me, { minSC: n, maxSC: n });
}

/** The smallest whole amount from 0 to `most` for which `ok` holds (it holds from there on up), or null. */
function smallest(most: number, ok: (n: number) => boolean): number | null {
  if (!ok(most)) return null;
  let low = 0;
  let high = most;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ok(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * A map for the Areas tab: its monsters (bosses and difficulty copies left out,
 * as Grind has them), most common first, each with its stats; what's needed
 * there (the defence their blows go through, the attack their defence takes);
 * and with `me` (the character's stats), each fight's kill time and health,
 * the defence to fight them all without potions and the attack for quick kills.
 * Null without monsters there.
 */
export function areaView(data: TravelData, mapIndex: number, me: Fighter | null, who?: string): AreaView | null {
  const hunted = mapMonsters(data, mapIndex);
  if (!hunted?.length) return null;
  const total = hunted.reduce((sum, m) => sum + m.n, 0);
  const foes = hunted
    .map((m) => ({ m, foe: foeOf(data, m.name), share: m.n / total }))
    .filter((x): x is { m: (typeof hunted)[number]; foe: Foe; share: number } => !!x.foe)
    .sort((a, b) => b.share - a.share || a.foe.level - b.foe.level);
  const deciding = foes.filter((x) => x.share >= AREA_INDEX.minShare);

  const rows: AreaMonsterRow[] = foes.map(({ m, foe, share }) => {
    const hitsWith = physical(foe) ? 'DC' : foe.maxMC >= foe.maxSC ? 'MC' : 'SC';
    const hits: [number, number] = hitsWith === 'DC' ? [foe.minDC, foe.maxDC] : hitsWith === 'MC' ? [foe.minMC, foe.maxMC] : [foe.minSC, foe.maxSC];
    const row: AreaMonsterRow = {
      name: foe.name, level: foe.level, health: foe.health, exp: m.exp, share,
      attack: { stat: hitsWith, min: hits[0], max: hits[1] }, ac: [foe.minAC, foe.maxAC], mr: [foe.minMR, foe.maxMR],
      accuracy: foe.accuracy, agility: foe.agility,
    };
    if (me) {
      const outcome = fight(me, foe);
      row.you = { seconds: outcome.seconds, hpLost: Math.min(outcome.hpLost / me.maxHp, 9.99), worstBlow: outcome.worstBlow, survives: outcome.survivesWithout };
    }
    return row;
  });

  // What the monsters' blows and defence come to: the strongest of those that make up the map.
  const most = (pick: (foe: Foe) => number, which: (foe: Foe) => boolean = () => true) => Math.max(0, ...deciding.filter((x) => which(x.foe)).map((x) => pick(x.foe)));
  const view: AreaView = {
    map: mapIndex, name: mapName(data, mapIndex), monsters: rows,
    needs: {
      // Their hits: defence at least this high (its lowest roll) and none get through.
      blockAC: most((f) => f.maxDC, physical),
      blockMR: most((f) => Math.max(f.maxMC, f.maxSC), (f) => !physical(f)),
      // Their defence: an attack whose lowest roll tops it lands every blow in full.
      pierceAC: most((f) => f.maxAC),
      pierceMR: most((f) => f.maxMR),
    },
  };

  if (me) {
    const stat = attackStat(me);
    // The defence for every fight here without potions (null: one of them can't be, whatever the defence).
    const supplies = { potion: null, drinkMs: COMBAT.drinkMs };
    let moreAC = 0;
    let moreMR = 0;
    let beyond = false;
    for (const { foe } of deciding) {
      const gap = survivalGap(data, me, foe, { supplies });
      if (!gap) continue;
      if (gap.more === null || gap.noDamage) beyond = true;
      else if (gap.defence === 'AC') moreAC = Math.max(moreAC, gap.more);
      else moreMR = Math.max(moreMR, gap.more);
    }
    // The attack for quick kills, counted by how many of each there are.
    const meanSeconds = (f: Fighter) => deciding.reduce((sum, x) => sum + x.share * Math.min(fight(f, x.foe).seconds, 600), 0) / deciding.reduce((s, x) => s + x.share, 0);
    const now = meanSeconds(me);
    const quick = now <= AREA_INDEX.quickKillSeconds ? 0 : smallest(AREA_INDEX.maxExtraAttack, (n) => meanSeconds(moreAttack(me, stat, n)) <= AREA_INDEX.quickKillSeconds);
    const min = stat === 'DC' ? me.minDC : stat === 'MC' ? me.minMC : me.minSC;
    const max = stat === 'DC' ? me.maxDC : stat === 'MC' ? me.maxMC : me.maxSC;
    view.you = {
      who: who ?? `Level ${me.level}`,
      ac: [me.minAC, me.maxAC], mr: [me.minMR, me.maxMR], attack: { stat, min, max }, maxHp: me.maxHp,
      moreAC, moreMR, beyond, meanSeconds: now, quickAttack: quick, quickSeconds: AREA_INDEX.quickKillSeconds,
    };
  }
  return view;
}
