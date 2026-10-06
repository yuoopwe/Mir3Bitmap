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
const PICK_UP_KEYS = ['', 'Tab', 'Space', '`', 'Z', 'X', 'C', 'V', 'G', 'F'];
const POTION_KEYS = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
const RULE_LABELS: Record<NameRule, string> = { auto: 'Auto', attack: 'Always attack', ignore: 'Never attack' };
const SETTINGS_KEY = 'settings-v2';

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const windowTitle = element<HTMLInputElement>('window-title');
const capture = element<HTMLSelectElement>('capture');
const attack = element<HTMLInputElement>('attack');
const archer = element<HTMLInputElement>('archer');
const roam = element<HTMLInputElement>('roam');
const loot = element<HTMLInputElement>('loot');
const sellItems = element<HTMLInputElement>('sell-items');
const pickUpKey = element<HTMLSelectElement>('pickup-key');
const unstuckKey = element<HTMLSelectElement>('unstuck-key');
const randomKey = element<HTMLSelectElement>('random-key');
const hpKey = element<HTMLSelectElement>('hp-key');
const hpPercent = element<HTMLInputElement>('hp-percent');
const mpKey = element<HTMLSelectElement>('mp-key');
const mpPercent = element<HTMLInputElement>('mp-percent');
const areaSelect = element<HTMLSelectElement>('area');
const destinationSelect = element<HTMLSelectElement>('destination');
const attackButton = element<HTMLButtonElement>('attack-button');
const exploreButton = element<HTMLButtonElement>('explore-button');
const triadButton = element<HTMLButtonElement>('triad-button');
const trainButton = element<HTMLButtonElement>('train-button');
const deckButton = element<HTMLButtonElement>('deck-button');
const gatherButton = element<HTMLButtonElement>('gather-button');
const gatherPlants = element<HTMLInputElement>('gather-plants');
const gatherOre = element<HTMLInputElement>('gather-ore');
const trainKey = element<HTMLSelectElement>('train-key');
const trainInterval = element<HTMLInputElement>('train-interval');
const explorePercent = element<HTMLInputElement>('explore-percent');
const exploreRestart = element<HTMLInputElement>('explore-restart');
const pauseOnMouse = element<HTMLInputElement>('pause-on-mouse');
const exploreTeleport = element<HTMLInputElement>('explore-teleport');
const travelButton = element<HTMLButtonElement>('travel-button');
const stopButton = element<HTMLButtonElement>('stop-button');
const statusText = element<HTMLSpanElement>('status');
const vitalsText = element<HTMLSpanElement>('vitals');
const timingText = element<HTMLSpanElement>('timing');
const namesList = element<HTMLUListElement>('names');
const monstersList = element<HTMLUListElement>('monsters');
/** Monster names Hunt leaves alone, and those seen so far. */
let skipMonsters: string[] = [];
let monstersSeen: string[] = [];
const activityLog = element<HTMLOListElement>('log');
const LOG_LENGTH = 30;
let lastLogged = '';

const keyInputs = new Map<KeyId, { enabled: HTMLInputElement; seconds: HTMLInputElement }>();
const delayInputs = new Map<DelayId, HTMLInputElement>();
let fuzzInput: HTMLInputElement;
let currentArea: Area | null = null;

function buildKeyRows(): void {
  const body = element<HTMLTableSectionElement>('keys');
  for (const id of KEY_IDS) {
    const seconds = document.createElement('input');
    seconds.type = 'number';
    seconds.min = '0';
    seconds.value = '0';
    // F1 is pressed on every loop while fighting, so it has no timer.
    seconds.disabled = id === 'F1';

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    const label = document.createElement('label');
    label.append(enabled, ` ${KEY_LABELS[id]}`);

    const row = body.insertRow();
    row.insertCell().append(seconds);
    row.insertCell().append(label);
    keyInputs.set(id, { enabled, seconds });
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
    skipMonsters,
    pauseOnMouse: pauseOnMouse.checked,
    trainKey: trainKey.value,
    trainIntervalMs: Math.max(readNumber(trainInterval, 1000), 100),
    hunt: {
      roam: roam.checked,
      loot: loot.checked,
      pickUpKey: pickUpKey.value,
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
  if (Array.isArray(settings.skipMonsters)) {
    skipMonsters = settings.skipMonsters;
    showMonsters();
  }
  if (settings.trainKey !== undefined) trainKey.value = settings.trainKey;
  if (settings.trainIntervalMs !== undefined) trainInterval.value = String(settings.trainIntervalMs);
  const hunt = settings.hunt;
  if (hunt) {
    roam.checked = hunt.roam;
    loot.checked = hunt.loot;
    pickUpKey.value = hunt.pickUpKey ?? '';
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

async function showArea(name: string): Promise<void> {
  currentArea = await window.bot.loadArea(name);
  destinationSelect.replaceChildren(...currentArea.destinations.map((destination) => new Option(destination.name)));
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
      });
      item.classList.toggle('skipped', !tick.checked);
      label.append(tick, ` ${name}`);
      item.append(label);
      return item;
    }),
  );
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
      // Name rules aren't settings: keep their changes out of saveSettings.
      rule.addEventListener('change', (event) => {
        event.stopPropagation();
        void window.bot.setNameRule(entry.fingerprint, rule.value as NameRule).then(refreshNames);
      });

      const forget = document.createElement('button');
      forget.textContent = '✕';
      forget.title = 'Forget this name';
      forget.addEventListener('click', () => void window.bot.forgetName(entry.fingerprint).then(refreshNames));

      item.append(image, stats, rule, forget);
      return item;
    }),
  );
}

async function refreshNames(): Promise<void> {
  showNames(await window.bot.listNames());
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${Math.round(value * 100)}%`;
}

/** Adds a status message to the activity log when it changes, newest first. */
function logActivity(message: string): void {
  if (message === lastLogged) return;
  lastLogged = message;
  const entry = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  entry.append(time, message);
  activityLog.prepend(entry);
  while (activityLog.children.length > LOG_LENGTH) activityLog.lastElementChild?.remove();
}

function showStatus(status: Status): void {
  const running = status.mode !== 'idle';
  statusText.textContent = status.message;
  logActivity(status.message);
  attackButton.disabled = running;
  exploreButton.disabled = running;
  triadButton.disabled = running;
  trainButton.disabled = running;
  deckButton.disabled = running;
  gatherButton.disabled = running;
  travelButton.disabled = running;
  stopButton.disabled = !running;
  const explored = status.explored === null || status.explored === undefined ? '' : ` · map ${percent(status.explored)}`;
  vitalsText.textContent = `HP ${percent(status.hp)} · MP ${percent(status.mp)} · ${status.kills ?? 0} kills${explored}`;
  if (status.captureMs !== undefined && status.scanMs !== undefined) {
    timingText.textContent = `capture ${status.captureMs.toFixed(1)} ms · scan ${status.scanMs.toFixed(1)} ms`;
  }
}

async function init(): Promise<void> {
  buildKeyRows();
  buildDelayFields();
  buildPotionSelects();
  windowTitle.value = 'Legend of Mir III - Xtreme Edition';
  loot.checked = true;
  explorePercent.value = '95';
  exploreRestart.checked = true;
  exploreTeleport.checked = true;
  gatherPlants.checked = true;
  gatherOre.checked = true;
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) applySettings(JSON.parse(saved));
  saveSettings();
  document.body.addEventListener('change', saveSettings);

  window.bot.onStatus(showStatus);
  window.bot.onNames(showNames);
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
  stopButton.addEventListener('click', () => void window.bot.stop());
  travelButton.addEventListener('click', () => {
    const destination = currentArea?.destinations[destinationSelect.selectedIndex];
    if (destination) void window.bot.startTravel(destination);
    else statusText.textContent = 'Pick a destination first';
  });

  await refreshNames();
  const areas = await window.bot.listAreas();
  areaSelect.replaceChildren(...areas.map((name) => new Option(name)));
  areaSelect.addEventListener('change', () => void showArea(areaSelect.value));
  if (areas.length > 0) await showArea(areas[0]);
}

void init();
