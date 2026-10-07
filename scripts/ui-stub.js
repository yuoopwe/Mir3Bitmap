// A stand-in for the bot (window.bot from src/main/preload.ts), so the control window can be opened in a
// browser without Electron or the game: scripts/ui-harness.js puts it in front of the renderer. It answers
// as the bot does, with made-up statuses, monsters, names and stats, and records every call in uiStub.calls.
// Not part of the app.
'use strict';
(() => {
  /** Every call the window made: { fn, args }, the args copied the way Electron's IPC copies them. */
  const calls = [];
  const listeners = { status: [], names: [], monsters: [] };
  const record = (fn, ...args) => calls.push({ fn, args: structuredClone(args) });
  const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---- Stats, kept as src/main/session-stats.ts keeps them ----

  const noCounts = () => ({ kills: 0, items: 0, gathered: 0, triadPlayed: 0, triadWon: 0, triadLost: 0, triadDrawn: 0, decks: 0, runningMs: 0 });
  let session = noCounts();
  const allTime = noCounts();
  let timedTo = null;
  const addTime = () => {
    if (timedTo === null) return;
    const now = Date.now();
    session.runningMs += now - timedTo;
    allTime.runningMs += now - timedTo;
    timedTo = now;
  };
  const snapshot = () => {
    addTime();
    return { session: { ...session }, allTime: { ...allTime } };
  };
  const count = (name, by = 1) => {
    session[name] += by;
    allTime[name] += by;
  };

  // ---- Names learned from the screen: pictures of the name as the game draws it ----

  /** A PNG data URL of `text` in small game-like lettering on black, as main.ts crops it out of a frame. */
  function picture(text, colour) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const font = '11px Tahoma, Verdana, sans-serif';
    context.font = font;
    canvas.width = Math.ceil(context.measureText(text).width) + 3;
    canvas.height = 13;
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = font;
    context.fillStyle = colour ?? '#f2f2f2';
    context.textBaseline = 'middle';
    context.fillText(text, 1, 7);
    return canvas.toDataURL();
  }

  /** As NameBook.isAttackable: the user's rule, else attack anything that has died to us or hasn't shrugged off 3 fights. */
  const attacking = (n) => (n.rule !== 'auto' ? n.rule === 'attack' : n.kills > 0 || n.strikes < 3);
  let names = [
    { text: 'Skeleton', rule: 'auto', kills: 412, strikes: 0 },
    { text: 'Cave Maggot', rule: 'auto', kills: 268, strikes: 1 },
    { text: 'Skeleton Axeman', rule: 'auto', kills: 97, strikes: 0 },
    { text: 'Bone Archer', rule: 'attack', kills: 31, strikes: 0 },
    { text: 'Spiked Beetle', rule: 'auto', kills: 12, strikes: 2 },
    { text: 'Tiger Snake', rule: 'auto', kills: 0, strikes: 1 },
    { text: 'Moon Lily', rule: 'auto', kills: 0, strikes: 3 },
    { text: 'Shinsu', rule: 'ignore', kills: 0, strikes: 0 },
    // Junk learned in the old days: damage numbers and the like.
    { text: '-154', rule: 'auto', kills: 0, strikes: 3, colour: '#ff6b4a' },
    { text: 'Miss', rule: 'auto', kills: 0, strikes: 4, colour: '#ffd23c' },
    { text: '+38', rule: 'auto', kills: 0, strikes: 3, colour: '#5fe07a' },
  ].map((n, i) => ({ ...n, fingerprint: `${i}:${n.text.length}|stub` }));

  const nameList = () =>
    names
      .map((n) => ({ fingerprint: n.fingerprint, image: (n.image ??= picture(n.text, n.colour)), rule: n.rule, kills: n.kills, strikes: n.strikes, attacking: attacking(n) }))
      .sort((a, b) => Number(b.attacking) - Number(a.attacking) || b.kills - a.kills || b.strikes - a.strikes);
  // The app batches name changes and sends the list half a second later.
  const namesChanged = () => setTimeout(() => emitNames(), 500);
  const emitNames = () => listeners.names.forEach((listener) => listener(nameList()));

  // ---- Monsters seen in the game's memory while hunting ----

  const monstersSeen = new Set();
  const seeMonsters = (more) => {
    const before = monstersSeen.size;
    for (const name of more) monstersSeen.add(name);
    if (monstersSeen.size > before) listeners.monsters.forEach((listener) => listener([...monstersSeen].sort()));
  };

  // ---- Travel: the real places when scripts/ui-harness.js wrote them out, else a few ----

  const places = window.uiStubPlaces ?? [
    { id: 'map:1', label: 'Bichon Province' },
    { id: 'map:2', label: 'Bichon Castle' },
    { id: 'map:3', label: 'Bichon Cave Lv 1' },
    { id: 'map:4', label: 'Bichon Cave Lv 2' },
    { id: 'npc:1', label: 'Mr. Kang - Bichon Province, Weapon Store' },
  ];
  /** As searchPlaces in src/main/travel.ts. */
  function searchPlaces(query, limit = 30) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const q = query.trim().toLowerCase();
    const rank = (label) => (label.startsWith(q) ? 0 : label.split(/[\s,(-]+/).some((w) => w.startsWith(words[0])) ? 1 : 2);
    return places
      .map((p) => ({ p, label: p.label.toLowerCase() }))
      .filter(({ label }) => words.every((w) => label.includes(w)))
      .sort((a, b) => rank(a.label) - rank(b.label) || a.label.length - b.label.length)
      .slice(0, limit)
      .map(({ p }) => ({ id: p.id, label: p.label }));
  }
  const placeLabel = (id) => places.find((p) => p.id === id)?.label ?? id;

  // ---- Statuses ----

  let state = { mode: 'idle', hp: null, mp: null, kills: 0, explored: null, captureMs: 0, scanMs: 0 };
  function emitStatus(message, changes = {}) {
    state = { ...state, ...changes };
    const status = { ...state, message, stats: snapshot() };
    listeners.status.forEach((listener) => listener(structuredClone(status)));
  }

  /** A mode "running": `steps` are called one after another every `everyMs` until one returns a final message. */
  let running = null;
  function run(mode, starting, everyMs, step) {
    if (state.mode !== 'idle') return;
    timedTo = Date.now();
    if (mode === 'explore') state.explored = null;
    emitStatus(starting, { mode, hp: 0.92, mp: 0.71, captureMs: 6.4, scanMs: 3.1 });
    let tick = 0;
    running = setInterval(() => {
      const wobble = (value) => Math.min(1, Math.max(0.05, (value ?? 0.8) + (Math.random() - 0.55) * 0.08));
      const frame = { hp: wobble(state.hp), mp: wobble(state.mp), captureMs: 5 + Math.random() * 3, scanMs: 2 + Math.random() * 3 };
      const message = step(tick++, frame);
      if (typeof message === 'string') emitStatus(message, frame);
      else if (message?.done) finish(message.done);
    }, everyMs);
  }
  function finish(message) {
    clearInterval(running);
    running = null;
    addTime();
    timedTo = null;
    emitStatus(message, { mode: 'idle' });
  }

  const pick = (list, i) => list[i % list.length];
  const huntTargets = ['Skeleton', 'Cave Maggot', 'Skeleton Axeman', 'Bone Archer', 'Spiked Beetle'];

  window.bot = {
    async startAttack() {
      record('startAttack');
      run('attack', 'Hunting', 900, (tick) => {
        if (tick === 1) seeMonsters(['Skeleton', 'Cave Maggot', 'Skeleton Axeman']);
        if (tick === 4) seeMonsters(['Bone Archer', 'Spiked Beetle', 'Voracious Ghost', '[Behemoth] Tombbound Horror']);
        if (tick % 3 === 2) {
          state.kills++;
          count('kills');
          count('items', 2);
          return 'Picking up 2 items';
        }
        return tick % 7 === 6 ? 'Waiting for monsters (game memory)' : `Attacking ${pick(huntTargets, tick)} (game memory)`;
      });
    },
    async startExplore() {
      record('startExplore');
      let explored = 0.41;
      run('explore', 'Exploring', 900, (tick) => {
        explored = Math.min(0.96, explored + 0.03);
        state.explored = explored;
        if (explored >= 0.95) return { done: `Bichon Cave Lv 2 explored (${Math.round(explored * 100)}%)` };
        if (tick % 5 === 4) return 'Fighting Cave Maggot in the way';
        return `Exploring Bichon Cave Lv 2: ${Math.round(explored * 100)}% uncovered`;
      });
    },
    async startTriad() {
      record('startTriad');
      const moves = ['Waiting for the game to start', 'Ant Healer (3-3-3-3) to square 5 (should win by 2, game memory)', 'Funguar (5-3-1-1) to square 1 (should win by 3, game memory)', 'Bite Bug (1-5-3-3) to square 9 (should win by 3, game memory)', 'Match over; pressing OK'];
      run('triad', 'Playing Triple Triad', 1200, (tick) => {
        if (tick % moves.length === moves.length - 1) {
          count('triadPlayed');
          count('triadWon');
        }
        return pick(moves, tick);
      });
    },
    async startDeck() {
      record('startDeck');
      const steps = ['Working out the best deck (trying combinations against random decks)...', 'Putting Gayla in slot 2', 'Putting Fire Minotaur in slot 4'];
      run('deck', 'Building a Triple Triad deck', 1000, (tick) => {
        if (tick < steps.length) return steps[tick];
        count('decks');
        return { done: 'Deck saved: Fire Minotaur, Gayla, Funguar, Ant Healer, Bite Bug (won 71% of test games)' };
      });
    },
    async startGather() {
      record('startGather');
      let gathered = 0;
      run('gather', 'Gathering', 1000, (tick) => {
        if (tick % 3 === 0) return `Walking to a Moon Lily ${6 - (tick % 4)} tiles away (${gathered} gathered)`;
        if (tick % 3 === 1) return `Gathering a Moon Lily (${gathered} gathered)`;
        gathered++;
        count('gathered');
        return `Looking for something to gather (${gathered} gathered)`;
      });
    },
    async startTrain() {
      record('startTrain');
      run('train', 'Training', 1000, (tick) => `Training: ${(tick + 1) * 1} casts`);
    },
    async startTravel(placeId) {
      record('startTravel', placeId);
      const label = placeLabel(placeId);
      const to = label.replace(/ \(level \d+\+\)$/, '');
      const route = ['Bichon Province', 'Bichon Castle', 'Woomyon Woods', to.split(' - ').pop().split(',')[0]];
      run('travel', 'Travelling', 1000, (tick) => {
        if (tick === 0) return `Route: ${route.join(' > ')}`;
        if (tick === 2) return 'Waypoint to Woomyon Woods';
        if (tick >= 6) return { done: `Arrived at ${to.split(' - ')[0]}` };
        const left = Math.max(0, 3 - Math.floor(tick / 2));
        return `Travelling to ${label}: ${left ? `${left} map${left === 1 ? '' : 's'} to go` : 'nearly there'}`;
      });
    },
    async searchPlaces(query) {
      record('searchPlaces', query);
      return searchPlaces(query);
    },
    async stop() {
      record('stop');
      if (running) finish('Stopped');
    },
    async updateSettings(settings) {
      record('updateSettings', settings);
    },
    async listNames() {
      record('listNames');
      return nameList();
    },
    async setNameRule(fingerprint, rule) {
      record('setNameRule', fingerprint, rule);
      const entry = names.find((n) => n.fingerprint === fingerprint);
      if (entry) entry.rule = rule;
      namesChanged();
    },
    async forgetName(fingerprint) {
      record('forgetName', fingerprint);
      names = names.filter((n) => n.fingerprint !== fingerprint);
      namesChanged();
    },
    async loadStats(saved) {
      record('loadStats', saved);
      // As SessionStats.restore: a higher saved count wins.
      if (typeof saved === 'object' && saved) {
        for (const name of Object.keys(allTime)) {
          const value = saved[name];
          if (typeof value === 'number' && Number.isFinite(value) && value > allTime[name]) allTime[name] = value;
        }
      }
      return snapshot();
    },
    async resetStats() {
      record('resetStats');
      addTime();
      session = noCounts();
      state.kills = 0;
      return snapshot();
    },
    onStatus(listener) {
      listeners.status.push(listener);
    },
    onNames(listener) {
      listeners.names.push(listener);
    },
    onMonsters(listener) {
      listeners.monsters.push(listener);
    },
  };

  /** For poking the window from the console (or a test script). */
  window.uiStub = {
    calls,
    /** Sends a status as the bot would, e.g. uiStub.status('Hunting', { mode: 'attack', hp: 0.5 }). */
    status: emitStatus,
    /** Sends more monster names, as Hunt does when it sees new ones in the game's memory. */
    monsters: seeMonsters,
    /** Sends the learned names again (after changing uiStub.names). */
    names: emitNames,
    get learned() {
      return names;
    },
    set learned(list) {
      names = list;
    },
    /** Counts something, as the bot does (e.g. uiStub.count('kills', 3)). */
    count,
    picture,
    later,
  };
})();
