const KEY_LABELS: Record<KeyId, string> = {
  F1: 'F1 (spam)', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  N1: 'Item 1',
};
const KEY_IDS = Object.keys(KEY_LABELS) as KeyId[];

type DelayId = keyof Settings['delays'];
const DELAY_FIELDS: { id: DelayId; label: string; defaultMs: number }[] = [
  { id: 'attackClick', label: 'Attack click', defaultMs: 200 },
  { id: 'pickUpClick', label: 'Pick-up click', defaultMs: 50 },
  { id: 'quickKey', label: 'After F2–F5', defaultMs: 100 },
  { id: 'buffKey', label: 'Around F6–F12', defaultMs: 1500 },
  { id: 'itemKey', label: 'Before item key', defaultMs: 1000 },
  { id: 'runStep', label: 'Travel/roam step', defaultMs: 400 },
  { id: 'menu', label: 'Selling clicks', defaultMs: 200 },
];
const DEFAULT_FUZZ_PERCENT = 20;
const DEFAULT_GRIND: Settings['grind'] = { replanMinutes: 15, maxLevelsAbove: 10, questsFirst: false };
const PICK_UP_KEYS = ['', 'Tab', 'Space', '`', 'Z', 'X', 'C', 'V', 'G', 'F'];
const POTION_KEYS = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
const RULE_LABELS: Record<NameRule, string> = { auto: 'Auto', attack: 'Always attack', ignore: 'Never attack' };
const SETTINGS_KEY = 'settings-v2';
/** All-time stats get a key of their own: saveSettings rewrites the settings from the form on every change. */
const STATS_KEY = 'stats-v1';
/** What the status bar and the activity log call each mode. */
const MODE_LABELS: Record<Status['mode'], string> = {
  idle: 'Idle', circuit: 'Boss circuit', attack: 'Hunting', explore: 'Exploring', travel: 'Travelling', grind: 'Grinding', quest: 'Questing', gather: 'Gathering', triad: 'Triple Triad', deck: 'Best deck', train: 'Training',
};

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const windowTitle = element<HTMLInputElement>('window-title');
const capture = element<HTMLSelectElement>('capture');
const attack = element<HTMLInputElement>('attack');
const archer = element<HTMLInputElement>('archer');
const roam = element<HTMLInputElement>('roam');
const questOnly = element<HTMLInputElement>('quest-only');
const loot = element<HTMLInputElement>('loot');
const sellItems = element<HTMLInputElement>('sell-items');
const pickUpKey = element<HTMLSelectElement>('pickup-key');
const townPortalKey = element<HTMLSelectElement>('town-portal-key');
const unstuckKey = element<HTMLSelectElement>('unstuck-key');
const randomKey = element<HTMLSelectElement>('random-key');
const hpKey = element<HTMLSelectElement>('hp-key');
const hpPercent = element<HTMLInputElement>('hp-percent');
const mpKey = element<HTMLSelectElement>('mp-key');
const mpPercent = element<HTMLInputElement>('mp-percent');
const travelSearch = element<HTMLInputElement>('travel-search');
const travelResults = element<HTMLSelectElement>('travel-results');
const travelCount = element<HTMLParagraphElement>('travel-count');
const routeList = element<HTMLOListElement>('route');
const attackButton = element<HTMLButtonElement>('attack-button');
const exploreButton = element<HTMLButtonElement>('explore-button');
const triadButton = element<HTMLButtonElement>('triad-button');
const trainButton = element<HTMLButtonElement>('train-button');
const deckButton = element<HTMLButtonElement>('deck-button');
const gatherButton = element<HTMLButtonElement>('gather-button');
const gatherPlants = element<HTMLInputElement>('gather-plants');
const gatherOre = element<HTMLInputElement>('gather-ore');
const gatherTrips = element<HTMLInputElement>('gather-trips');
const gatherPlan = element<HTMLParagraphElement>('gather-plan');
const fightInTheWay = element<HTMLInputElement>('fight-in-the-way');
const trainKey = element<HTMLSelectElement>('train-key');
const trainInterval = element<HTMLInputElement>('train-interval');
const explorePercent = element<HTMLInputElement>('explore-percent');
const exploreRestart = element<HTMLInputElement>('explore-restart');
const pauseOnMouse = element<HTMLInputElement>('pause-on-mouse');
const exploreTeleport = element<HTMLInputElement>('explore-teleport');
const travelButton = element<HTMLButtonElement>('travel-button');
const grindButton = element<HTMLButtonElement>('grind-button');
const questsButton = element<HTMLButtonElement>('quests-button');
const circuitButton = element<HTMLButtonElement>('circuit-button');
const circuitQuests = element<HTMLDivElement>('circuit-quests');
const circuitLevelHint = element<HTMLParagraphElement>('circuit-level-hint');
const circuitKeep = element<HTMLInputElement>('circuit-keep');
const circuitRetreat = element<HTMLInputElement>('circuit-retreat');
const circuitSummary = element<HTMLParagraphElement>('circuit-summary');
const circuitTasks = element<HTMLUListElement>('circuit-tasks');
const circuitStops = element<HTMLOListElement>('circuit-stops');
const guideAuto = element<HTMLInputElement>('guide-auto');
const guideFocus = element<HTMLInputElement>('guide-focus');
const elixirsOn = element<HTMLInputElement>('elixirs-on');
const elixirKeys = element<HTMLDivElement>('elixir-keys');
const guideSummary = element<HTMLParagraphElement>('guide-summary');
const guideStats = element<HTMLOListElement>('guide-stats');
const guideLocked = element<HTMLUListElement>('guide-locked');
const guideElixirs = element<HTMLUListElement>('guide-elixirs');
const guidePotions = element<HTMLParagraphElement>('guide-potions');
const guideCalibration = element<HTMLParagraphElement>('guide-calibration');
/** The kinds of elixir with a belt key each (src/main/bot-elixirs.ts ELIXIR_KINDS). */
const ELIXIR_KINDS = ['Haste', 'Destruction', 'Life', 'Mana', 'Nature', 'Spirit'];
const elixirKeyInputs = new Map<string, HTMLSelectElement>();
/** The Boss circuit's quests (as src/main/boss-planner.ts has them): the daily Seasonal Supply Hunts and Elite Bounties, and the level each needs. */
const CIRCUIT_QUESTS = [
  { id: 1840, label: 'Seasonal Supply Hunt – Grade E (100 Forge Stones)', level: 40 },
  { id: 1841, label: 'Seasonal Supply Hunt – Grade D (200 Forge Stones)', level: 90 },
  { id: 1842, label: 'Seasonal Supply Hunt – Grade C (300 Forge Stones)', level: 190 },
  { id: 1843, label: 'Seasonal Supply Hunt – Grade B (300 Forge Stones)', level: 340 },
  { id: 66, label: 'Elite Bounty: Demonic Kektal [Grade F] (5 Forge Stones)', level: 20 },
  { id: 67, label: 'Elite Bounty: Arachnid Brood Queen [Grade F] (5 Forge Stones)', level: 30 },
];
const DEFAULT_CIRCUIT: NonNullable<Settings['circuit']> = { quests: [1840], keepHunting: false, retreatHpPercent: 35 };
/** The character's level as last seen, kept between runs of the window (it greys out quests above it). */
const LEVEL_KEY = 'level-v1';
const circuitQuestInputs = new Map<number, HTMLInputElement>();
const questMax = element<HTMLInputElement>('quest-max');
const grindReplan = element<HTMLInputElement>('grind-replan');
const grindAbove = element<HTMLInputElement>('grind-above');
const bagFree = element<HTMLInputElement>('bag-free');
const bagWeight = element<HTMLInputElement>('bag-weight');
const grindQuestsFirst = element<HTMLInputElement>('grind-quests-first');
const grindPlan = element<HTMLParagraphElement>('grind-plan');
const stopButton = element<HTMLButtonElement>('stop-button');
const modeText = element<HTMLSpanElement>('mode');
const statusText = element<HTMLSpanElement>('status');
const hpText = element<HTMLSpanElement>('hp');
const hpFill = element<HTMLSpanElement>('hp-fill');
const mpText = element<HTMLSpanElement>('mp');
const mpFill = element<HTMLSpanElement>('mp-fill');
const exploredText = element<HTMLSpanElement>('explored');
const timingText = element<HTMLSpanElement>('timing');
const statsTables = element<HTMLDivElement>('stats-tables');
const statsResetButton = element<HTMLButtonElement>('stats-reset');
const namesList = element<HTMLUListElement>('names');
const namesCount = element<HTMLSpanElement>('names-count');
const monstersList = element<HTMLUListElement>('monsters');
const monstersCount = element<HTMLSpanElement>('monsters-count');
/** Monster names Hunt leaves alone, and those seen so far. */
let skipMonsters: string[] = [];
let monstersSeen: string[] = [];
const activityLog = element<HTMLOListElement>('log');
const keptList = element<HTMLOListElement>('kept');
const equipUpgrades = element<HTMLInputElement>('equip-upgrades');
/** The log fills the Stats & log tab, so it keeps plenty. */
const LOG_LENGTH = 500;
let lastLogged = '';

/** The sidebar's tabs: one per mode, then the shared ones. */
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

const keyInputs = new Map<KeyId, { enabled: HTMLInputElement; seconds: HTMLInputElement }>();
const delayInputs = new Map<DelayId, HTMLInputElement>();
let fuzzInput: HTMLInputElement;

const count = (n: number) => n.toLocaleString();
/** The stats panel's rows, in two groups side by side: a label, and how to show its count. */
const STAT_ROWS: { label: string; hint?: string; show: (counts: StatCounts) => string }[][] = [
  [
    { label: 'Time running', show: (c) => duration(c.runningMs) },
    { label: 'Monsters killed', hint: 'Targets that died while being attacked. Without the memory reader: targets gone from view.', show: (c) => count(c.kills) },
    { label: 'Items picked up', hint: 'With the memory reader: items in reach that were then gone. Without it: pick-up tries after kills.', show: (c) => count(c.items) },
    { label: 'Nodes gathered', show: (c) => count(c.gathered) },
    { label: 'Items kept', hint: 'Bag items the loot judge locked and kept out of a sale: upgrades, and Legendary or rarer finds', show: (c) => count(c.kept) },
  ],
  [
    { label: 'Triple Triad played', show: (c) => count(c.triadPlayed) },
    { label: 'Won · lost · drawn', hint: "From the final board in the game's memory: without the memory reader, matches count as played only", show: (c) => `${count(c.triadWon)} · ${count(c.triadLost)} · ${count(c.triadDrawn)}` },
    { label: 'Decks built', hint: 'Best deck runs that changed the deck', show: (c) => count(c.decks) },
  ],
];
const statCells: { show: (counts: StatCounts) => string; session: HTMLTableCellElement; allTime: HTMLTableCellElement }[] = [];
/** The last stats from the bot, when they came, and whether the bot was running then. */
let stats: Stats | null = null;
let statsAt = 0;
let botRunning = false;

/**
 * Shows a tab's panel. A setting that belongs to two modes (Pick up items, Fight monsters in the way) is one
 * set of controls, moved into whichever of its tabs is open: each setting still has a single input.
 */
function showTab(tab: HTMLButtonElement, focus = false): void {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    other.tabIndex = selected ? 0 : -1;
    element(other.getAttribute('aria-controls')!).hidden = !selected;
  }
  const panel = element(tab.getAttribute('aria-controls')!);
  for (const slot of Array.from(panel.querySelectorAll<HTMLElement>('[data-slot]'))) slot.append(element(slot.dataset.slot!));
  if (focus) tab.focus();
}

function setUpTabs(): void {
  for (const tab of tabs) tab.addEventListener('click', () => showTab(tab));
  // Arrow keys, Home and End move between the tabs, as in any tab list.
  const moves: Record<string, (at: number) => number> = {
    ArrowDown: (at) => at + 1,
    ArrowRight: (at) => at + 1,
    ArrowUp: (at) => at - 1,
    ArrowLeft: (at) => at - 1,
    Home: () => 0,
    End: () => tabs.length - 1,
  };
  for (const tab of tabs) {
    tab.addEventListener('keydown', (event) => {
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      showTab(tabs[(move(tabs.indexOf(tab)) + tabs.length) % tabs.length], true);
    });
  }
  // Links to the shared tabs ("Spell keys, potions and timing: Keys & potions").
  for (const link of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-goto]'))) {
    link.addEventListener('click', () => showTab(element(link.dataset.goto!), true));
  }
  showTab(tabs[0]);
}

function buildKeyRows(): void {
  const list = element<HTMLUListElement>('keys');
  for (const id of KEY_IDS) {
    const seconds = document.createElement('input');
    seconds.type = 'number';
    seconds.min = '0';
    seconds.value = '0';
    // F1 is pressed on every loop while fighting, so it has no timer.
    seconds.disabled = id === 'F1';
    seconds.setAttribute('aria-label', `${KEY_LABELS[id]}: seconds between presses`);
    const every = document.createElement('span');
    every.className = 'every';
    if (id === 'F1') {
      // Its (unused) number is still kept in the settings.
      seconds.hidden = true;
      every.append(seconds, 'every round');
    } else every.append(seconds, ' s');

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    const label = document.createElement('label');
    label.append(enabled, ` ${KEY_LABELS[id]}`);

    const item = document.createElement('li');
    item.append(label, every);
    list.append(item);
    keyInputs.set(id, { enabled, seconds });
  }
}

function buildStatsTables(): void {
  for (const group of STAT_ROWS) {
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const text of ['', 'This session', 'All time']) {
      const cell = document.createElement('th');
      cell.textContent = text;
      head.append(cell);
    }
    const body = table.createTBody();
    for (const row of group) {
      const line = body.insertRow();
      const label = document.createElement('th');
      label.textContent = row.label;
      if (row.hint) label.title = row.hint;
      line.append(label);
      statCells.push({ show: row.show, session: line.insertCell(), allTime: line.insertCell() });
    }
    statsTables.append(table);
  }
}

function numberField(container: HTMLElement, label: string, value: number, max?: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  if (max !== undefined) input.max = String(max);
  input.value = String(value);
  const wrapper = document.createElement('label');
  wrapper.append(label, input);
  container.append(wrapper);
  return input;
}

function buildDelayFields(): void {
  const container = element<HTMLDivElement>('delays');
  for (const field of DELAY_FIELDS) {
    delayInputs.set(field.id, numberField(container, field.label, field.defaultMs));
  }
  fuzzInput = numberField(container, 'Fuzz ± %', DEFAULT_FUZZ_PERCENT, 100);
}

function buildPotionSelects(): void {
  for (const select of [hpKey, mpKey]) {
    select.replaceChildren(...POTION_KEYS.map((key) => new Option(key || 'none', key)));
  }
  pickUpKey.replaceChildren(...PICK_UP_KEYS.map((key) => new Option(key || 'none', key)));
  townPortalKey.replaceChildren(...POTION_KEYS.map((key) => new Option(key || 'none', key)));
  townPortalKey.value = '3';
  unstuckKey.replaceChildren(...POTION_KEYS.map((key) => new Option(key || 'none', key)));
  unstuckKey.value = 'F2';
  randomKey.replaceChildren(...POTION_KEYS.map((key) => new Option(key || 'none', key)));
  randomKey.value = '1';
  trainKey.replaceChildren(...POTION_KEYS.map((key) => new Option(key || 'none', key)));
  trainKey.value = 'F1';
  trainInterval.value = '1000';
  hpPercent.value = '50';
  mpPercent.value = '30';
}

/** A non-negative whole number from an input, or `fallback` if it's blank or invalid. */
function readNumber(input: HTMLInputElement, fallback: number): number {
  const value = Math.floor(Number(input.value));
  return input.value.trim() === '' || !Number.isFinite(value) ? fallback : Math.max(0, value);
}

function readSettings(): Settings {
  const keys = {} as Settings['keys'];
  for (const [id, inputs] of keyInputs) {
    keys[id] = { enabled: inputs.enabled.checked, seconds: readNumber(inputs.seconds, 0) };
  }
  const delays = {} as Settings['delays'];
  for (const field of DELAY_FIELDS) {
    delays[field.id] = readNumber(delayInputs.get(field.id)!, field.defaultMs);
  }
  return {
    windowTitle: windowTitle.value,
    capture: capture.value === 'blt' ? 'blt' : 'print',
    attack: attack.checked,
    archer: archer.checked,
    sellItems: sellItems.checked,
    keys,
    delays,
    fuzzPercent: Math.min(readNumber(fuzzInput, DEFAULT_FUZZ_PERCENT), 100),
    explorePercent: Math.min(Math.max(readNumber(explorePercent, 95), 1), 100),
    exploreAutoRestart: exploreRestart.checked,
    exploreTeleport: exploreTeleport.checked,
    gatherPlants: gatherPlants.checked,
    gatherOre: gatherOre.checked,
    gatherTrips: gatherTrips.checked,
    fightInTheWay: fightInTheWay.checked,
    skipMonsters,
    pauseOnMouse: pauseOnMouse.checked,
    trainKey: trainKey.value,
    trainIntervalMs: Math.max(readNumber(trainInterval, 1000), 100),
    questMaxActive: Math.min(Math.max(readNumber(questMax, 5), 1), 30),
    circuit: {
      quests: [...circuitQuestInputs].filter(([, input]) => input.checked).map(([id]) => id),
      keepHunting: circuitKeep.checked,
      retreatHpPercent: Math.min(Math.max(readNumber(circuitRetreat, DEFAULT_CIRCUIT.retreatHpPercent), 5), 90),
    },
    guide: { auto: guideAuto.checked, focus: Math.min(Math.max(readNumber(guideFocus, 50), 0), 100) },
    elixirs: { enabled: elixirsOn.checked, keys: Object.fromEntries([...elixirKeyInputs].map(([kind, select]) => [kind, select.value])) },
    grind: {
      replanMinutes: Math.max(readNumber(grindReplan, DEFAULT_GRIND.replanMinutes), 1),
      maxLevelsAbove: Math.min(readNumber(grindAbove, DEFAULT_GRIND.maxLevelsAbove), 50),
      questsFirst: grindQuestsFirst.checked,
    },
    hunt: {
      roam: roam.checked,
      bagFreeSlots: Math.min(Math.max(readNumber(bagFree, 15), 0), 100),
      bagWeightPercent: Math.min(Math.max(readNumber(bagWeight, 95), 10), 100),
      questOnly: questOnly.checked,
      loot: loot.checked,
      pickUpKey: pickUpKey.value,
      townPortalKey: townPortalKey.value,
      equipUpgrades: equipUpgrades.checked,
      unstuckKey: unstuckKey.value,
      randomTeleportKey: randomKey.value,
      hpPotionKey: hpKey.value,
      hpPotionPercent: Math.min(readNumber(hpPercent, 50), 100),
      mpPotionKey: mpKey.value,
      mpPotionPercent: Math.min(readNumber(mpPercent, 30), 100),
    },
  };
}

function applySettings(settings: Partial<Settings>): void {
  if (settings.windowTitle !== undefined) windowTitle.value = settings.windowTitle;
  if (settings.capture) capture.value = settings.capture;
  if (settings.attack !== undefined) attack.checked = settings.attack;
  if (settings.archer !== undefined) archer.checked = settings.archer;
  if (settings.sellItems !== undefined) sellItems.checked = settings.sellItems;
  for (const [id, inputs] of keyInputs) {
    const key = settings.keys?.[id];
    if (!key) continue;
    inputs.enabled.checked = key.enabled;
    inputs.seconds.value = String(key.seconds);
  }
  for (const [id, input] of delayInputs) {
    const value = settings.delays?.[id];
    if (value !== undefined) input.value = String(value);
  }
  if (settings.fuzzPercent !== undefined) fuzzInput.value = String(settings.fuzzPercent);
  if (settings.explorePercent !== undefined) explorePercent.value = String(settings.explorePercent);
  if (settings.exploreAutoRestart !== undefined) exploreRestart.checked = settings.exploreAutoRestart;
  if (settings.pauseOnMouse !== undefined) pauseOnMouse.checked = settings.pauseOnMouse;
  if (settings.exploreTeleport !== undefined) exploreTeleport.checked = settings.exploreTeleport;
  if (settings.gatherPlants !== undefined) gatherPlants.checked = settings.gatherPlants;
  if (settings.gatherOre !== undefined) gatherOre.checked = settings.gatherOre;
  if (settings.gatherTrips !== undefined) gatherTrips.checked = settings.gatherTrips;
  if (settings.fightInTheWay !== undefined) fightInTheWay.checked = settings.fightInTheWay;
  if (Array.isArray(settings.skipMonsters)) {
    skipMonsters = settings.skipMonsters;
    showMonsters();
  }
  if (settings.trainKey !== undefined) trainKey.value = settings.trainKey;
  if (settings.trainIntervalMs !== undefined) trainInterval.value = String(settings.trainIntervalMs);
  if (settings.grind?.replanMinutes !== undefined) grindReplan.value = String(settings.grind.replanMinutes);
  if (settings.questMaxActive !== undefined) questMax.value = String(settings.questMaxActive);
  if (settings.circuit) {
    for (const [id, input] of circuitQuestInputs) input.checked = settings.circuit.quests.includes(id);
    circuitKeep.checked = settings.circuit.keepHunting;
    circuitRetreat.value = String(settings.circuit.retreatHpPercent);
  }
  if (settings.guide) {
    guideAuto.checked = settings.guide.auto;
    guideFocus.value = String(settings.guide.focus);
    guideFocus.disabled = settings.guide.auto;
  }
  if (settings.elixirs) {
    elixirsOn.checked = settings.elixirs.enabled;
    for (const [kind, select] of elixirKeyInputs) select.value = settings.elixirs.keys[kind] ?? '';
  }
  if (settings.grind?.maxLevelsAbove !== undefined) grindAbove.value = String(settings.grind.maxLevelsAbove);
  if (settings.grind?.questsFirst !== undefined) grindQuestsFirst.checked = settings.grind.questsFirst;
  const hunt = settings.hunt;
  if (hunt) {
    roam.checked = hunt.roam;
    bagFree.value = String(hunt.bagFreeSlots ?? 15);
    bagWeight.value = String(hunt.bagWeightPercent ?? 95);
    questOnly.checked = hunt.questOnly ?? false;
    loot.checked = hunt.loot;
    pickUpKey.value = hunt.pickUpKey ?? '';
    townPortalKey.value = hunt.townPortalKey ?? '3';
    equipUpgrades.checked = hunt.equipUpgrades ?? false;
    unstuckKey.value = hunt.unstuckKey ?? 'F2';
    randomKey.value = hunt.randomTeleportKey ?? '1';
    hpKey.value = hunt.hpPotionKey;
    hpPercent.value = String(hunt.hpPotionPercent);
    mpKey.value = hunt.mpPotionKey;
    mpPercent.value = String(hunt.mpPotionPercent);
  }
}

function saveSettings(): void {
  const settings = readSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  void window.bot.updateSettings(settings);
}

const TRAVEL_KEY = 'travel-v1';

/** Lists the maps and NPCs matching the search box, keeping the one picked if it's still there. */
async function showPlaces(): Promise<void> {
  const picked = travelResults.value || JSON.parse(localStorage.getItem(TRAVEL_KEY) ?? '{}').picked;
  const found = await window.bot.searchPlaces(travelSearch.value);
  travelResults.replaceChildren(...found.map((p) => new Option(p.label, p.id)));
  if (found.some((p) => p.id === picked)) travelResults.value = picked;
  else if (found.length > 0) travelResults.selectedIndex = 0;
  // The bot lists the best 30.
  travelCount.textContent = !travelSearch.value.trim()
    ? 'Type part of the name of a map or an NPC.'
    : found.length === 0
      ? 'Nothing found.'
      : `${found.length >= 30 ? `The best ${found.length} found: type more to narrow it down.` : `${found.length} found.`} Double-click one to go there.`;
}

function saveTravel(): void {
  localStorage.setItem(TRAVEL_KEY, JSON.stringify({ search: travelSearch.value, picked: travelResults.value }));
}

/** Travel's last plan, from its status: "Route: A > B > C", or "Heading for <NPC>" when they're on this map. */
function showRoute(message: string): void {
  const stops = message.startsWith('Route: ') ? message.slice('Route: '.length).split(' > ') : [message];
  routeList.replaceChildren(
    ...stops.map((stop) => {
      const item = document.createElement('li');
      item.textContent = stop;
      return item;
    }),
  );
}

/** "8 seen · 2 left alone" beside the monster list's heading. */
function countMonsters(): void {
  const seen = monstersList.children.length;
  const skipped = monstersList.querySelectorAll('.skipped').length;
  monstersCount.textContent = seen ? `${seen} seen · ${skipped} left alone` : '';
}

/** The monsters seen while hunting (and any being skipped), each with a tick to hunt it. */
function showMonsters(): void {
  const names = [...new Set([...monstersSeen, ...skipMonsters])].sort((a, b) => a.localeCompare(b));
  monstersList.replaceChildren(
    ...names.map((name) => {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const tick = document.createElement('input');
      tick.type = 'checkbox';
      tick.checked = !skipMonsters.includes(name);
      // Runs before the change bubbles up to saveSettings.
      tick.addEventListener('change', () => {
        skipMonsters = tick.checked ? skipMonsters.filter((n) => n !== name) : [...skipMonsters, name];
        item.classList.toggle('skipped', !tick.checked);
        countMonsters();
      });
      item.classList.toggle('skipped', !tick.checked);
      // The name in full, for when it doesn't fit its column.
      label.title = name;
      const text = document.createElement('span');
      text.textContent = name;
      label.append(tick, text);
      item.append(label);
      return item;
    }),
  );
  countMonsters();
}

function showNames(names: NameEntry[]): void {
  namesList.replaceChildren(
    ...names.map((entry) => {
      const item = document.createElement('li');
      item.classList.toggle('skipped', !entry.attacking);

      const image = document.createElement('img');
      image.src = entry.image;
      image.alt = '';

      const stats = document.createElement('span');
      stats.className = 'stats';
      stats.textContent = entry.attacking
        ? `${entry.kills} kills`
        : entry.rule === 'ignore' ? 'skipped' : `skipped (never took damage in ${entry.strikes} fights)`;

      const rule = document.createElement('select');
      rule.replaceChildren(...(Object.keys(RULE_LABELS) as NameRule[]).map((value) => new Option(RULE_LABELS[value], value)));
      rule.value = entry.rule;
      rule.setAttribute('aria-label', 'Attack it?');
      // Name rules aren't settings: keep their changes out of saveSettings.
      rule.addEventListener('change', (event) => {
        event.stopPropagation();
        void window.bot.setNameRule(entry.fingerprint, rule.value as NameRule).then(refreshNames);
      });

      const forget = document.createElement('button');
      forget.type = 'button';
      forget.textContent = '✕';
      forget.title = 'Forget this name';
      forget.addEventListener('click', () => void window.bot.forgetName(entry.fingerprint).then(refreshNames));

      item.append(image, stats, rule, forget);
      return item;
    }),
  );
  namesCount.textContent = names.length ? String(names.length) : '';
}

async function refreshNames(): Promise<void> {
  showNames(await window.bot.listNames());
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${Math.round(value * 100)}%`;
}

/** Adds a status message to the activity log when it changes, newest first, with the time and the mode running. */
function logActivity(message: string, mode: Status['mode']): void {
  if (message === lastLogged) return;
  lastLogged = message;
  const entry = document.createElement('li');
  // Idle: how a run ended, or why it couldn't start.
  entry.classList.toggle('idle', mode === 'idle');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  const label = document.createElement('span');
  label.className = 'log-mode';
  label.textContent = mode === 'idle' ? '' : MODE_LABELS[mode];
  const text = document.createElement('span');
  text.className = 'log-text';
  text.textContent = message;
  entry.append(time, label, text);
  activityLog.prepend(entry);
  while (activityLog.children.length > LOG_LENGTH) activityLog.lastElementChild?.remove();
}

/** What the loot judge kept, newest first: the name, its rarity, and why. */
function showKept(items: KeptItem[]): void {
  keptList.replaceChildren(
    ...items.map((item) => {
      const entry = document.createElement('li');
      entry.title = `Kept at ${new Date(item.at).toLocaleTimeString()}`;
      const cells = [item.name, item.rarity, item.reason].map((text, i) => {
        const span = document.createElement('span');
        span.className = ['kept-name', 'kept-rarity', 'kept-reason'][i];
        span.textContent = text;
        return span;
      });
      entry.append(...cells);
      return entry;
    }),
  );
}

/** "45s", "12m 05s", "1h 05m": seconds stop mattering after the first hour. */
function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}h ${two(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${two(seconds % 60)}s`;
  return `${seconds % 60}s`;
}

/** Fills in the stats panel; while the bot runs, the time running keeps ticking between its reports. */
function renderStats(): void {
  if (!stats) return;
  const since = botRunning ? Date.now() - statsAt : 0;
  const session = { ...stats.session, runningMs: stats.session.runningMs + since };
  const allTime = { ...stats.allTime, runningMs: stats.allTime.runningMs + since };
  for (const cell of statCells) {
    cell.session.textContent = cell.show(session);
    cell.allTime.textContent = cell.show(allTime);
  }
}

/** New stats from the bot: shows them and saves the all-time totals (the bot only keeps them while the app is open). */
function showStats(latest: Stats): void {
  stats = latest;
  statsAt = Date.now();
  renderStats();
  localStorage.setItem(STATS_KEY, JSON.stringify(latest.allTime));
}

/** The all-time totals saved last time, if they can be read (the bot checks what's in them). */
function savedStats(): unknown {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) ?? 'null');
  } catch {
    return null;
  }
}

/** HP or MP in the status bar: the share as text and as a bar. */
function showVital(text: HTMLElement, fill: HTMLElement, value: number | null | undefined): void {
  text.textContent = percent(value);
  fill.style.width = value === null || value === undefined ? '0%' : `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%`;
}

function showStatus(status: Status): void {
  const running = status.mode !== 'idle';
  botRunning = running;
  if (status.stats) showStats(status.stats);
  statusText.textContent = status.message;
  logActivity(status.message, status.mode);
  attackButton.disabled = running;
  exploreButton.disabled = running;
  triadButton.disabled = running;
  trainButton.disabled = running;
  deckButton.disabled = running;
  gatherButton.disabled = running;
  travelButton.disabled = running;
  grindButton.disabled = running;
  questsButton.disabled = running;
  circuitButton.disabled = running;
  stopButton.disabled = !running;
  if (typeof status.level === 'number') showLevel(status.level);
  modeText.textContent = MODE_LABELS[status.mode];
  document.body.classList.toggle('running', running);
  for (const tab of tabs) tab.classList.toggle('running', (tab.dataset.modes ?? '').split(' ').includes(status.mode));
  showVital(hpText, hpFill, status.hp);
  showVital(mpText, mpFill, status.mp);
  exploredText.hidden = status.explored === null || status.explored === undefined;
  exploredText.textContent = `Map ${percent(status.explored)}`;
  if (status.captureMs !== undefined && status.scanMs !== undefined) {
    timingText.textContent = `Last frame: capture ${status.captureMs.toFixed(1)} ms · scan ${status.scanMs.toFixed(1)} ms`;
  }
  // Hunt's seeking says "Heading for ..." too: only Travel's count.
  if (status.mode === 'travel' && /^(Route: |Heading for )/.test(status.message)) showRoute(status.message);
  if (status.mode === 'grind' && status.message.startsWith('Grinding at ')) grindPlan.textContent = status.message;
  // "Gathering trip: Plants 23 · Bichon Province: 118 plants, ~2,250 exp/h (the best)": the levels and the spot.
  if (status.mode === 'gather' && status.message.startsWith('Gathering trip: ')) gatherPlan.textContent = status.message.slice('Gathering trip: '.length);
}

/** A checkbox for each of the circuit's quests. */
function buildCircuitQuests(): void {
  for (const quest of CIRCUIT_QUESTS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = DEFAULT_CIRCUIT.quests.includes(quest.id);
    label.append(input, ` ${quest.label}`);
    label.title = `Needs level ${quest.level}`;
    circuitQuestInputs.set(quest.id, input);
    circuitQuests.append(label);
  }
}

/** Greys out the circuit's quests above the character's level (remembered for next time). */
function showLevel(level: number): void {
  try {
    localStorage.setItem(LEVEL_KEY, String(level));
  } catch {
    // Not remembered: greyed out again once the bot sees the character.
  }
  for (const quest of CIRCUIT_QUESTS) {
    const input = circuitQuestInputs.get(quest.id)!;
    input.disabled = quest.level > level;
    input.parentElement!.title = quest.level > level ? `Needs level ${quest.level} (you're ${level})` : `Needs level ${quest.level}`;
  }
  circuitLevelHint.textContent = `Your character is level ${level}: quests above that are greyed out.`;
}

/** The Boss circuit's plan: each task's count, the spawns in order with when each is back, and what's skipped. */
function showCircuit(view: CircuitView): void {
  const done = view.tasks.reduce((n, t) => n + t.done, 0);
  const need = view.tasks.reduce((n, t) => n + t.need, 0);
  const stones = view.stones === null ? '' : ` · Forge Stones +${view.stones} this run`;
  circuitSummary.textContent = view.quest ? `${view.quest}: ${done}/${need}${stones}` : `Hunting bosses (the quests are done for today)${stones}`;
  const item = (text: string, className = '') => {
    const li = document.createElement('li');
    li.textContent = text;
    if (className) li.className = className;
    return li;
  };
  circuitTasks.replaceChildren(...(view.quest ? view.tasks : []).map((t) => item(`${t.monster} ${t.done}/${t.need}`, t.done >= t.need ? 'done' : '')));
  circuitStops.replaceChildren(
    ...view.stops.map((s) => item(`${s.monster} at ${s.map}${s.backIn > 0 ? ` (back in ${s.backIn} min)` : ''}`)),
    ...view.skipped.map((s) => item(`${s.monster} at ${s.map}: ${s.why}`, 'skipped')),
  );
}

/** A belt key for each kind of elixir. */
function buildElixirKeys(): void {
  for (const kind of ELIXIR_KINDS) {
    const label = document.createElement('label');
    const select = document.createElement('select');
    select.replaceChildren(...POTION_KEYS.map((key) => new Option(key || 'none', key)));
    label.append(`${kind} `, select);
    elixirKeys.append(label);
    elixirKeyInputs.set(kind, select);
  }
}

/** The stat guide: each stat's worth best first, what's out of reach and what it would take, the elixirs, potions and how the model measures up. */
function showStatGuide(view: StatGuideView): void {
  const share = (n: number) => `${Math.round(n * 100)}%`;
  guideSummary.textContent =
    `${view.character}, weighing levelling ${share(view.weights.grind)} and bosses ${share(view.weights.bosses)}` +
    `${view.weights.auto ? ' (by the time spent lately)' : ''}: ${view.activities.join(', ')}.`;
  const item = (text: string, className = '') => {
    const li = document.createElement('li');
    li.textContent = text;
    if (className) li.className = className;
    return li;
  };
  guideStats.replaceChildren(...view.stats.map((line) => item(line, / worth nothing here/.test(line) ? 'done' : '')));
  guideLocked.replaceChildren(...view.locked.map((l) => item(`Out of reach: ${l.name}: ${l.why}`, 'skipped')));
  guideElixirs.replaceChildren(...view.elixirs.map((e) => item(`${e.line}${e.pays ? ' (pays)' : ''}`, e.pays ? '' : 'done')));
  guidePotions.textContent = view.potions;
  guideCalibration.textContent = `Measured fights: ${view.calibration}.`;
}

async function init(): Promise<void> {
  setUpTabs();
  buildKeyRows();
  buildDelayFields();
  buildPotionSelects();
  buildCircuitQuests();
  buildElixirKeys();
  guideAuto.checked = true;
  guideFocus.value = '50';
  guideFocus.disabled = true;
  guideAuto.addEventListener('change', () => (guideFocus.disabled = guideAuto.checked));
  circuitRetreat.value = String(DEFAULT_CIRCUIT.retreatHpPercent);
  const level = Number(localStorage.getItem(LEVEL_KEY));
  if (level > 0) showLevel(level);
  buildStatsTables();
  windowTitle.value = 'Legend of Mir III - Xtreme Edition';
  loot.checked = true;
  explorePercent.value = '95';
  exploreRestart.checked = true;
  exploreTeleport.checked = true;
  gatherPlants.checked = true;
  gatherOre.checked = true;
  grindReplan.value = String(DEFAULT_GRIND.replanMinutes);
  questMax.value = '5';
  bagFree.value = '15';
  bagWeight.value = '95';
  grindAbove.value = String(DEFAULT_GRIND.maxLevelsAbove);
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) applySettings(JSON.parse(saved));
  saveSettings();
  document.body.addEventListener('change', saveSettings);

  // Before any status comes in, hand the bot the totals saved last time.
  showStats(await window.bot.loadStats(savedStats()));
  window.bot.onStatus(showStatus);
  statsResetButton.addEventListener('click', () => void window.bot.resetStats().then(showStats));
  setInterval(renderStats, 1000);
  window.bot.onNames(showNames);
  window.bot.onKept(showKept);
  window.bot.onCircuit(showCircuit);
  window.bot.onStatGuide(showStatGuide);
  window.bot.onMonsters((names) => {
    monstersSeen = names;
    showMonsters();
  });
  attackButton.addEventListener('click', () => void window.bot.startAttack());
  exploreButton.addEventListener('click', () => void window.bot.startExplore());
  triadButton.addEventListener('click', () => void window.bot.startTriad());
  trainButton.addEventListener('click', () => void window.bot.startTrain());
  deckButton.addEventListener('click', () => void window.bot.startDeck());
  gatherButton.addEventListener('click', () => void window.bot.startGather());
  grindButton.addEventListener('click', () => void window.bot.startGrind());
  questsButton.addEventListener('click', () => void window.bot.startQuests());
  circuitButton.addEventListener('click', () => void window.bot.startCircuit());
  stopButton.addEventListener('click', () => void window.bot.stop());
  travelButton.addEventListener('click', () => {
    if (travelResults.value) {
      saveTravel();
      void window.bot.startTravel(travelResults.value);
    } else statusText.textContent = 'Search for a map or NPC and pick one first';
  });

  await refreshNames();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  travelSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void showPlaces().then(saveTravel), 150);
  });
  travelResults.addEventListener('change', saveTravel);
  travelResults.addEventListener('dblclick', () => travelButton.click());
  travelSearch.value = JSON.parse(localStorage.getItem(TRAVEL_KEY) ?? '{}').search ?? '';
  await showPlaces();
}

void init();
