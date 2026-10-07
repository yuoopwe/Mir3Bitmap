import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { GATHER, canGather, chooseGatherSpot, describeSpot, gatherableOn, levelOn, rateSpot, rateSpots } from '../main/gather-planner';
import { loadTravelData, type GatherNode, type GatherSpot, type Start, type TravelData, type TravelLink } from '../main/travel';

const data = loadTravelData(path.join(__dirname, '..', '..', 'game-data', 'travel.json'));

// ---- A small world: Home (where the player stands), Near (110 steps away), Far (2010) and High (level 30 and up) ----

const HOME = 1, NEAR = 2, FAR = 3, HIGH = 4;
const NODES: GatherNode[] = [
  { id: 1, name: 'Silverleaf', kind: 'plant', level: 1, exp: 5, item: 'Silverleaf' },
  { id: 2, name: 'Stormseed', kind: 'plant', level: 1, exp: 5, item: 'Stormseed', weather: 'RainLightning' },
  { id: 3, name: 'Copper Vein', kind: 'ore', level: 1, exp: 20, item: 'Copper Ore' },
  { id: 4, name: 'Iron Vein', kind: 'ore', level: 30, exp: 80, item: 'Iron Ore' },
  { id: 5, name: 'Rimecap', kind: 'plant', level: 1, exp: 5, item: 'Rimecap', light: 'Dark' },
];
const link = (id: number, to: number, steps: number): [TravelLink, number] => [{ id, from: HOME, to, exit: [[id, id]], land: [5, 5], steps: {} }, steps];
const LINKS = [link(1, NEAR, 100), link(2, FAR, 2000), link(3, HIGH, 100)];
const start: Start = { map: HOME, steps: new Map(LINKS.map(([l, steps]) => [l.id, steps])) };

/** A spot on a map, with [node id, how many, region level] and the minutes nodes take to come back. */
const spot = (map: number, nodes: [number, number, number][], respawn = 8): GatherSpot => ({ region: 0, map, at: [[10, 10, 1]], respawn, nodes });

/** The small world with these spots: each spot's region is its place in the list plus 100. */
function world(...spots: GatherSpot[]): TravelData {
  return {
    maps: [{ i: HOME, name: 'Home' }, { i: NEAR, name: 'Near' }, { i: FAR, name: 'Far' }, { i: HIGH, name: 'High', level: 30 }],
    links: LINKS.map(([l]) => l),
    npcs: [],
    gathering: { nodes: NODES, spots: spots.map((s, i) => ({ ...s, region: 100 + i })) },
  };
}

const who = { level: 20 };

test('levels: a node needs its own level, and the region level when higher', () => {
  const [silverleaf, , , iron] = NODES;
  assert.ok(!canGather(iron, 0, { ore: 29 }));
  assert.ok(canGather(iron, 0, { ore: 30 }));
  // The region asks 20 of a level 1 plant.
  assert.ok(!canGather(silverleaf, 20, { plant: 19 }));
  assert.ok(canGather(silverleaf, 20, { plant: 20 }));
  assert.ok(canGather(silverleaf, 0, { plant: 1 }));
  // A kind not planned for (not ticked, or not earning) is never gathered.
  assert.ok(!canGather(silverleaf, 0, { ore: 100 }));

  const w = world(spot(HOME, [[4, 10, 0]]), spot(HOME, [[1, 10, 20]]));
  const [iron10, region20] = w.gathering!.spots;
  assert.equal(rateSpot(w, iron10, { ore: 29 }), null);
  assert.ok(rateSpot(w, iron10, { ore: 30 }));
  assert.equal(rateSpot(w, region20, { plant: 19 }), null);
  assert.equal(rateSpot(w, region20, { plant: 20 })!.plants, 10);
  // The rule the bot picks by on a map: the lowest level any spot there asks.
  assert.equal(levelOn(w, HOME, 1), 20);
  // Silverleaf needs 20 here; the nodes no spot here lists go by their own level.
  assert.deepEqual([...gatherableOn(w, HOME, { plant: 19, ore: 30 })].sort(), [2, 3, 4, 5]);
});

test('rates: weather and light nodes count a fifth, picked nodes take respawn minutes to come back, and one character only picks so fast', () => {
  const w = world(
    spot(HOME, [[1, 10, 0]], 60),
    spot(HOME, [[2, 10, 0]], 60),
    spot(HOME, [[5, 10, 0]], 60),
    spot(HOME, [[1, 10, 0]], 8),
    spot(HOME, [[1, 10, 0]], 16),
    spot(HOME, [[1, 1000, 0]], 1),
    spot(HOME, [[1, 1000, 0], [3, 1000, 0]], 1),
  );
  const rate = (i: number) => rateSpot(w, w.gathering!.spots[i], { plant: 50, ore: 50 })!.rate;
  // 10 nodes back every hour: 10 picks of 5.
  assert.equal(rate(0), 50);
  assert.equal(rate(1), 50 * GATHER.sometimesShare);
  assert.equal(rate(2), 50 * GATHER.sometimesShare);
  // Back every 8 minutes: 75 picks an hour; every 16, half that.
  assert.equal(rate(3), 375);
  assert.equal(rate(4), 187.5);
  // However many there are: 3600 / pickSeconds picks an hour, the ones giving the most first.
  const picks = 3600 / GATHER.pickSeconds;
  assert.equal(rate(5), picks * 5);
  assert.equal(rate(6), picks * 20);
  assert.equal(describeSpot(rateSpot(w, w.gathering!.spots[5], { plant: 1 })!), 'Home: 1,000 plants, ~2,250 exp/h');
});

test('travel: the trip is spread over a stay, nearly as good spots go to the one with more nodes, far ones lose', () => {
  // All three are at the cap (a plant every 8 s): Home is as good as it gets, Near 2.4% worse for the trip, Far a third worse.
  const w = world(spot(HOME, [[1, 1000, 0]], 1), spot(NEAR, [[1, 2000, 0]], 1), spot(FAR, [[1, 3000, 0]], 1));
  const choice = chooseGatherSpot(w, start, who, { plant: 1 })!;
  assert.equal(choice.name, 'Near');
  assert.equal(choice.route.steps, 110);
  const stay = GATHER.stayMinutes * 60;
  assert.equal(choice.effective, (choice.rate * stay) / (stay + 110 / 2.5));
  assert.equal(choice.reason, 'the best');
  // Clearly better is worth the trip: Far with twice the experience (ore at 20 a pick against 5 at Home).
  const ore = world(spot(HOME, [[1, 1000, 0]], 1), spot(FAR, [[3, 1000, 0]], 1));
  assert.equal(chooseGatherSpot(ore, start, who, { plant: 1, ore: 1 })!.name, 'Far');
  // No way there: left out. High needs level 30.
  const high = world(spot(HOME, [[1, 10, 0]]), spot(HIGH, [[1, 1000, 0]], 1));
  assert.equal(chooseGatherSpot(high, start, who, { plant: 1 })!.name, 'Home');
  assert.equal(chooseGatherSpot(high, start, { level: 30 }, { plant: 1 })!.name, 'High');
  const cut = { ...ore, links: [] };
  assert.equal(chooseGatherSpot(cut, start, who, { plant: 1, ore: 1 })!.name, 'Home');
  assert.equal(chooseGatherSpot({ ...world(spot(FAR, [[1, 10, 0]])), links: [] }, start, who, { plant: 1 }), null);
});

test('the current spot is kept unless another is 20% better', () => {
  // Near gives 15% more (12% counting the trip), Far's ore over twice as much.
  const w = world(spot(HOME, [[1, 100, 0]], 60), spot(NEAR, [[1, 115, 0]], 60), spot(FAR, [[3, 100, 0]], 60));
  const kept = chooseGatherSpot(w, start, who, { plant: 1 }, { current: 100 })!;
  assert.equal(kept.name, 'Home');
  assert.ok(kept.stay);
  assert.match(kept.reason, /^Near is only \d+% better$/);
  const moved = chooseGatherSpot(w, start, who, { plant: 1, ore: 1 }, { current: 100 })!;
  assert.equal(moved.name, 'Far');
  assert.match(moved.reason, /^\d+% better than Home$/);
  // Staying where the best is.
  assert.equal(chooseGatherSpot(w, start, who, { plant: 1, ore: 1 }, { current: 102 })!.reason, 'still the best');
});

test('failed spots and refused nodes are left out', () => {
  const w = world(spot(HOME, [[1, 100, 20]], 8), spot(HOME, [[1, 60, 0]], 8));
  assert.equal(chooseGatherSpot(w, start, who, { plant: 25 })!.spot.region, 100);
  // The first failed lately.
  assert.equal(chooseGatherSpot(w, start, who, { plant: 25 }, { skip: new Set([100]) })!.spot.region, 101);
  assert.equal(chooseGatherSpot(w, start, who, { plant: 25 }, { skip: new Set([100, 101]) }), null);
  // Silverleaf refused where it needed 20: not counted wherever it needs 20 or more, still where it needs less.
  const refused = new Map([[1, 20]]);
  assert.equal(chooseGatherSpot(w, start, who, { plant: 25 }, { refused })!.spot.region, 101);
  assert.deepEqual([...gatherableOn(w, HOME, { plant: 25 }, refused)].includes(1), true);
  assert.deepEqual([...gatherableOn(world(spot(HOME, [[1, 100, 20]])), HOME, { plant: 25 }, refused)].includes(1), false);
  // A choice that failed isn't kept either.
  assert.equal(chooseGatherSpot(w, start, who, { plant: 25 }, { current: 100, skip: new Set([100]) })!.reason, 'the last spot no longer suits');
});

test('only ore, only plants: a spot with both counts what is ticked', () => {
  const w = world(spot(HOME, [[1, 100, 0], [3, 6, 0]], 60));
  const both = rateSpot(w, w.gathering!.spots[0], { plant: 1, ore: 1 })!;
  const plants = rateSpot(w, w.gathering!.spots[0], { plant: 1 })!;
  const ore = rateSpot(w, w.gathering!.spots[0], { ore: 1 })!;
  assert.deepEqual([both.plants, both.ores, plants.plants, plants.ores, ore.plants, ore.ores], [100, 6, 100, 0, 0, 6]);
  assert.ok(both.rate > plants.rate && both.rate > ore.rate);
  assert.equal(describeSpot(plants), 'Home: 100 plants, ~500 exp/h');
  assert.equal(describeSpot(ore), 'Home: 6 ore, ~120 exp/h');
  assert.equal(describeSpot(both), 'Home: 100 plants, 6 ore, ~620 exp/h');
});

test('the real data: plants at 23 go to Arcadia Castle, ore at 5 to Quartz Mine Lv 1 (from level 40)', () => {
  // As planned in game: Arcadia Castle's 212 (counted as level 20 there), then the 118 of Bichon, Lost Paradise and Prajna Village.
  const plants = rateSpots(data, { level: 50 }, { plant: 23 });
  assert.deepEqual(plants.slice(0, 4).map((r) => [r.name, r.plants]), [['Arcadia Castle', 212], ['Bichon Province', 118], ['Lost Paradise', 118], ['Prajna Village', 118]]);
  assert.ok(plants.every((r) => r.ores === 0));
  const arcadia = chooseGatherSpot(data, { map: 563, steps: new Map() }, { level: 50 }, { plant: 23 })!;
  assert.equal(arcadia.name, 'Arcadia Castle');
  assert.equal(arcadia.route.links.length, 0);

  const ore = chooseGatherSpot(data, { map: 1, steps: new Map() }, { level: 45 }, { ore: 5 })!;
  assert.deepEqual([ore.name, ore.ores, ore.plants], ['Quartz Mine Lv 1', 24, 0]);
  // Below level 40 the mine is shut.
  assert.notEqual(chooseGatherSpot(data, { map: 1, steps: new Map() }, { level: 10 }, { ore: 5 })!.name, 'Quartz Mine Lv 1');
});
