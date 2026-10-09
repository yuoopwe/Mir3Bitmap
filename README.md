<img src="assets/icon.svg" width="64" height="64" alt="">

# Bitmat Bot

Screen-reading bot for the Zircon (Legend of Mir 3) client, written in TypeScript on Electron.
Ported from the C# WinForms version in [Mir3Bitmap](https://github.com/yuoopwe/Mir3Bitmap).

## Running

```
npm install
npm start
```

The window has a tab for each mode (Hunt, Explore, Travel, Gather, Triple Triad, Train), each with its Start button
and that mode's settings, and shared tabs: Keys & potions (spell keys, potions, timing), Monsters, Stats & log, and
General (the game window, capture, pausing). The status, HP and MP, and Stop stay along the bottom.

`npm test` runs the detection tests against real screenshots in `src/test/`.

`npm run ui-harness` writes `dist/ui-harness/index.html` and prints its address: the control window with a
stand-in bot (`scripts/ui-stub.js`), to open in a browser and try without Electron or the game. The stand-in
answers like the bot, with made-up statuses, monsters and names; `uiStub` in the browser console sends more and
lists the calls the window made. It isn't part of the app.

## Setup in game

- With the memory reader, Hunt, Explore, Travel, Gather, Quests, Grind and the Boss circuit work with the game at any size (a bigger
  window shows more of the map), at map zoom 100%: the bot stops and asks you to set it back otherwise (other zooms
  aren't measured yet). Without the reader, and for Triple Triad, Best deck and Train, which read the screen, the
  game's client area must be 1600x900 with the default HUD layout; screen positions are in `src/main/layout.ts`. At
  other sizes HP comes from the game's memory instead of the bar, and MP isn't known (MP potions need 1600x900).
- Put the spammable attack spell on F1 and buffs on F6 and above.
- "Background" capture works while other windows cover the game; it can't see a minimized game.
- "Pause while my mouse is over the game": every mode stops (letting go of keys and buttons) while your mouse
  pointer is over the game window, and carries on when it leaves. The bot's own clicks don't move your pointer.

## How hunting works

Kept simple on purpose:

1. Every frame, find the white overhead names (monsters, herbs, pets...) outside the HUD panels, and follow each
   from frame to frame by where it is (damage numbers and "Miss" floating away are ignored).
2. **Click the nearest name, and keep clicking it until it's gone**, then the next nearest. With "Archer" the left
   button is held down on it instead. Spell keys (F1 every round, the others on their timers) are pressed as it goes.
3. A target still there after 20 seconds (out of reach, or not really a monster) is skipped for 30 seconds.
   Names set to "Never attack" under "Names seen on screen" (Monsters tab) are skipped.
4. With "Pick up items", **click the ground at the character's feet**, which picks up everything within the
   character's pick-up radius. With the memory reader the bot reads that radius (the PickUpRadius stat) and where
   every item lies, so it clicks the moment an item drops within reach, and only walks towards items beyond it
   (between monsters, at most 6 tiles further out; any distance when there are no monsters). An item still there
   after 5 seconds (someone else's drop, or a full bag) is left alone for 2 minutes. Without the memory reader it
   clicks the feet every second and after each kill.
5. Nothing to fight: head for the nearest monster marker on the minimap (found by colour, so the panel can be any
   size), or wander, turning when blocked.
6. Drink potions when HP or MP drops below the set percentages.

### Reading the game's memory (better than the screen)

With the memory reader set up, Hunt knows exactly where every monster is instead of reading names off the screen:
`game-reader/reader.ps1` attaches read-only to the running game (Microsoft's ClrMD) and streams the objects
around the player (monsters with their names, map tiles and dead/alive, items on the ground, pets) a few times a
second. Hunt then clicks the nearest live monster's tile (not anyone's pet), and lists every monster it has seen
under "Monsters to hunt" (Monsters tab): untick one to leave it alone. Without the reader it falls back to the screen.

Set up once (needs PowerShell 7): `pwsh -File scripts/setup-game-reader.ps1`. Tiles are 48x32 pixels on screen (map
zoom 100%), and where they're drawn comes from the map view the reader sends (`view`: the game's size, its zoom, and
where MapControl draws the character's tile): a tile is at x = (tx − ux + offsetX) × 48 + pixelX + 24,
y = (ty − uy + offsetY) × 32 + pixelY + 16, which puts the player's own at (width / 2, height / 2 − 34): (800, 416)
at 1600x900, (1280, 686) at 2560x1440. Checked at both sizes against the tile under the mouse from the game's memory
(MapControl.MapLocation, also in the reader's output as user.mouseTile). Clicks on the map keep clear of the game's
windows (from memory), and of the main panel and target frame, placed for the game's size.

The reader also sends the current map: which tiles are walls (`MapControl.Cells`, read in one go by
`game-reader/MapReading.cs`) and which 4x4-tile blocks have been explored (`GameScene.MapExplorationStore`, the fog
on the big map), each only when it changes. `src/main/map-grid.ts` decodes them. To save the map you're on for
tests, run `node scripts/save-map.js` (writes `src/test/fixture-map-<name>.json`).

### Quest monsters only

Tick **Quest monsters only** (Hunt tab, Targets) to attack and seek out just the monsters an unfinished quest in your
log still needs. The reader takes them from the quest log in the game's memory (`GameScene.QuestLog`: each unfinished
task's monsters, and the map when the task names one). On a map with none of them, Hunt stays put and says where the
quests want you instead.

### Seeking with the memory reader

With "Seek when idle" ticked and the memory reader running, Hunt with nothing to fight walks (a real path round
the walls) to the nearest monster the game knows of, even off screen; failing that, to the nearest spot where many
monsters spawn (from the game's spawn data in `game-data/travel.json`) that it hasn't visited in the last 5 minutes,
working its way round the map; failing that, to unexplored ground. Monsters you've unticked don't count. It leaves
alone monsters it can't walk to (walled off), and gives up on a target after 6 s of neither getting any closer.

### Keeping upgrades out of the sale

Selling with the memory reader (Grind, Quests, Gather trips, and Hunt with "Sell items") uses Ludvik's Select All,
which would take everything on the bag's Main tab. So first, with the bag open, the loot judge
(`src/main/loot-judge.ts`) keeps what the best gear wants (below), and looks at every wearable bag item: its own stats and what it rolled on top, scored by what
each stat is worth to your character for what they do (the stat guide, below), or until that's been worked out, by
fixed weights for your class (DC for Warriors, MC for Wizards, SC for Taoists... all in one table, `LOOT.weights`,
min/max pairs at their average), against what you wear where it would go (for rings and bracelets, the weaker of the two). Items you
can wear (class, level, a stat requirement against your stats) that beat it by 5%, or go where nothing is worn, are
upgrades; those and anything Legendary or rarer are kept. Each is locked in game (Scroll Lock, the game's
ToggleItemLock key, with the mouse over its bag cell), and the lock is checked in the game's memory: one that doesn't
lock within a couple of seconds (or isn't showing in the bag) calls the sale off for that trip ("Couldn't protect X:
not selling"); the full bag is then let be for 10 minutes while hunting goes on. Locked items stay locked: unlock them
in game to sell them. What was kept, and why, is listed under "Kept this run" on the Stats & log tab (since the app
started or the session was reset), and counted with the stats.

"Put on clear upgrades" (Grind tab, Selling; off unless ticked) then, with the shop shut, double-clicks each bag item
15% better than what's worn, best first, and checks that what's worn changed (giving up on the first that doesn't).
Never one that's worn out, or that you can't wear yet. Whether Scroll Lock over a cell locks it, Select All leaves
locked items, and a double-click puts an item on aren't confirmed in game yet; each is checked as it's done.

## The combat model and the stat guide

Fixed weights get things wrong: for a Warrior who never misses and takes no damage on Zuma Temple Lv 5, a point of
Attack Speed is worth about eight of DC, and AC is worth nothing there. So `src/main/combat-model.ts` works one fight
out from both sides' stats (yours from the game's memory, the monster's from `monsterCombat` in
`game-data/travel.json`): your blow is your DC roll less its AC roll (MC or SC against MR for Wizards and Taoists),
landing as often as your Accuracy over its Agility, a swing every 1500 − 47 × Attack Speed ms (measured: 158 dps
predicted for DC 146–215 and Attack Speed 8 against Zuma AC 2–3, 162 measured); its blows the same way against your
AC, every attack delay; your potions and regeneration against that. From it: how long a kill takes (hits to kill as
a distribution, so breakpoints show), the health it costs, potions and gold a kill, whether it can be survived (what
it takes, within 70% of your health, with the potions in the bag drunk as often as the bot does), and for one that
can't, what would do it: "needs +76 AC, or +19154 HP, or 168 Health Potion (XL) a kill (you have 100) (a gear gap:
levels alone won't close it)". Its guesses (the miss roll, crits, regeneration) are checked against your own fights
(`src/main/calibration.ts`): each kill is now logged with the monster, your stats, the potions drunk, the health put
back and the lowest it got, and the model's kill times and health lost are compared with what was measured, newer
kills counting most, trusted as far as there are kills and capped, per level gap too. What follows each press of the
HP potion key teaches it which potion the key drinks, what one really heals and how soon the game allows another.

`src/main/stat-values.ts` turns that into the **Stat guide** (its own tab): what a point of each stat is worth for
what you actually do (Grind's map and the next best ones, by exp/h with the model's kill times; the Boss circuit's
bosses, by their exp, Forge Stone drops and quest rewards), weighed by the time you've spent on each this past week or
by the Levelling–Bosses slider. Survival is a threshold: what can't be survived brings nothing, so a stat that would
open it up is worth that whole activity shared over the points it takes, and once it's safe more defence is worth next
to nothing. It lists what's out of reach and what it would take, the potions a kill costs, and each elixir's worth
("Haste (II): +6.3% exp/h for an hour, you have 25"). It's worked out at every Grind and circuit plan, and acted on:
the loot judge scores by it, Grind leaves out maps and the circuit skips bosses it says can't be survived even with
potions (saying why, and taking them on again once the gap is closed), and with "Keep elixirs up that pay" ticked (off
unless ticked) each kind with a belt key set is drunk while grinding and on the circuit when it pays and some are in
the bag, confirmed by the bag's count going down (a key that doesn't drink it is left alone for the run). Luck,
crits and the server's level-difference rules aren't modelled yet; the corrections from your fights cover them as
far as they go.

### Best gear

`src/main/loadout.ts` picks the best set of gear from what's worn and the bag. Adding up items doesn't give the game's
totals (on one character worn items and bloodline came to DC 144–222, AC 98–115, Attack Speed 16 against the game's
138–194, 109–129 and 15): broken items give nothing, nor do the profession tools, nor the horse on foot; the class's
own stats and the bloodline add; % stats (DCPercent, ACPercent, HealthPercent...) multiply. So it never rebuilds
them: it starts from the totals the game shows and changes them by what each swap takes away and adds, a % stat applied
to the sum it multiplies (worked back from the total and the % now, rounded down as the game does), with set bonuses
counted by pieces worn. Each time what's worn changes in game, the totals read once they settle are compared with that
prediction ("Gear check: DC 138–194 predicted 158–223, read 158–222"), kept in the grind log, and fitted into per-stat
corrections as the fights' are. Candidates are what's worn and the wearable bag items the class and level allow; rings
and bracelets fill two places each; stat requirements and the weight limits (WearWeight, HandWeight for the weapon) are
checked in the order the swaps would be made, so an item needing more DC goes on after the ring that gives it. Loadouts
are scored by the stat guide (exp/h with the combat model, and the bosses that can be survived), not flat weights, and
searched by the best one or two swaps at a time, from what's worn and from the best of a beam over each slot's top
few, so a pair that only together makes a boss survivable shows. The loot judge keeps what the best gear wants, and what
the best gear for each boss the circuit wants would need to make it survivable; it says which worn items are broken
("Steelforge Blade is broken: −22–51 DC, repair it"). "Put on clear upgrades" puts the best gear on, one swap at a
time, checked in the game's memory, when it does 2% better. The Stat guide card shows the swaps, what they bring and
what to repair. Item weights and sets are read from the game's ItemInfo and the item's set as far as their fields are
found; a double-click puts a ring or bracelet where the game chooses, so a plan that needs the other place can stop
short ("went round in circles").

### Area damage

Grind favours packed maps once the character's attacks are seen to hit several monsters at once
(`src/main/area-damage.ts`). Rather than model skills, it measures: while hunting, the damage landing on every hostile
monster within 3 tiles (the reach of a Half Moon or a 3x3 spell cast a tile or two off), whether it was clicked or
not, over the time spent fighting (damage landed in the last 2 s), as 5 s samples kept in the grind log. Monsters
next to a pet or another player are theirs, and nothing is measured with another player within 9 tiles (they could be
shooting from range). From the samples: the damage rate in a crowd over the rate alone gives the extra targets' worth
(effective targets = 1 + gain x (crowd − 1), at most 5), trusted as 10 minutes each alone and in crowds build up;
gains under 0.15 are noise, so a character with no area attack plans exactly as before. How crowded each map gets is
learned too (monsters chase, so more than the spawn density says), and how that relates to spawn density, so maps
never ground on get an expected crowd. Kills on a map then go quicker by the speed-up at its crowd; measured stints
are estimated with the speed-up they measured themselves (as with the damage), so it isn't counted twice. Grind says
it after each plan ("Area damage: ~3 monsters at once clear 1.8x as fast (40 min measured)"), as does the Stat guide.

## Training

**Train** casts a spell on your character over and over to level it up: it rests the mouse on your character and
presses the chosen key (Train tab: "Cast ... on yourself every ... ms", default F1 every 1000 ms, varied by the fuzz
setting). HP and MP potions are drunk as set for hunting. Stop stops it.

## Exploring

**Explore** opens the big map (B) and keeps it open: it shows where you are and what is still fogged.
It doesn't fight (pets do).

**What counts as unexplored.** The map is judged in 6x6-pixel cells: near-black is void, bright is explored,
anything in between is fog. Walls along explored corridors are shaded dark enough to look like fog, but only in
strips a cell or two thick right beside explored ground. So fog counts as unexplored if it's thick (some of its
cells have fog on every side) or at least 3 cells from explored ground (a maze's corridors can be just a cell or two
wide), and an **unexplored edge** is thick fog within 3 cells of explored ground, or where that far fog starts.
The explored share is explored cells against explored plus unexplored, which lands within a couple of percent of the
game's own figure. An edge within about 9 tiles of somewhere you've already stood would have been uncovered by the
game, so if it still looks fogged it's dark ground and is ignored, unless the fog runs on a long way (in mazes the
game only uncovers what's in view, so a side corridor stays fogged right beside one you've walked down). The panel's
two layouts are handled: buttons over the top of the map, or in a bar underneath.

**How it moves.** A few times a second it:

1. Finds you on the map: your own sky-blue marker when any of it shows, otherwise the pets gathered where you just
   were. If the marker vanishes (e.g. under a map icon) it carries on from your last position for a few seconds.
2. Picks an unexplored edge by walking distance, and **sticks with it** until it's uncovered, unless another is
   clearly nearer.
3. Steers for the **farthest point of the route it can run to in a straight line**, by holding the right mouse
   button on the game world beside the map panel. The map keeps the world's proportions, so a direction on the map
   is the same direction on screen.
4. Presses the "Teleport key" (default F2) every ~0.4 s **while the route ahead runs straight** (a teleport past a
   corner just has to come back). For characters without a teleport, untick "Teleport while exploring": getting
   unstuck is then done by stepping aside.

From 60% explored the game unlocks a free random teleport (to anywhere explored; "Random teleport key", default 1).
Explore presses it while the walk to unexplored ground from where you are is longer than from 90% of explored
spots, re-rolling up to 6 times in a row until it lands somewhere good. In the simulation that cut the steps to
95% by a median of 6-31% depending on the map.

When stuck (often pets or monsters in the way) it teleports, then steps aside, and after a few tries leaves that
edge for 30 seconds. It stops when the set share is uncovered, when no unexplored edges have been left for 15
seconds, or when you press Stop. A sudden drop in the explored share (a new level) starts the map afresh.

`src/test/explore-sim.ts` simulates exploring the saved Zuma Temple captures, which is how these choices were
compared: against the old approach it reaches 95% in roughly 25-55% fewer steps and spends far less time stuck.

## Triple Triad

**Triple Triad** plays card matches as you start them at the card NPC: on each of your turns it reads the board,
works out the best move, clicks the card then the square, and presses OK at the end.

- **With the memory reader set up, it reads the match from the game's memory** instead of the screen: every card's
  exact numbers (yours, the board's and the cards still in the opponent's hand), who owns each square, the rules
  in play (Same, Plus and Combo are allowed for; Elemental isn't yet) and whose turn it is, and where each hand card
  is drawn (so it clicks the right places wherever the match window is, and finds the OK button at the end). The
  screen reading below is only the fallback.

- **The numbers are read off the cards** (`src/main/triad-digits.ts`), so any deck works. Digits are matched by
  the pattern of their black outline (the white fill is often no lighter than the picture behind). Hand cards are
  drawn the same way every time and read reliably. Board cards are drawn slanted and bigger towards the bottom, so
  they're read through a flattened copy against every example seen so far; your own cards (whose numbers are known
  from your hand) add new examples as you play, so the board reading improves with every match. A number that
  can't be read is guessed (6) and the status says so.
- **Who owns each card** comes from its border colour (blue mine, red theirs), checked on all four of the card's own
  sides. (Before, an empty square next to one of your cards was taken for a card, so the last card was never played.)
- **Opponents always play the same cards**, and the ones they haven't played are face down, so the cards each
  opponent plays are remembered between matches (`src/main/triad-memory.ts`, saved as `triad.json`). Cards not seen
  yet count as middling (4 on every side), so the first match against someone new is played partly blind.
- Moves come from searching every way the rest of the match can go (`src/main/triad.ts`): the best result if the
  opponent grabs the most cards each turn (as NPCs tend to), and among those, the best result against perfect play.
- If a card doesn't go down when clicked, the bot notices and tries again.
- Digits not seen yet (7 and up are rare in the examples so far) can be added: record a match with `npm run record`,
  label the cards in `scripts/triad-labels.json` and run `node scripts/triad-templates.js`.

Learned names are saved in the app's user data folder (`names.json`; names saved by older versions are converted,
and the original kept as `names-old.json`).

`npx electron scripts/grab-frame.js` saves what the bot sees to `frame-print.png` / `frame-blt.png`,
which is handy for re-measuring positions after a client update.

## Gathering

**Gather** (needs the memory reader) picks plants and mines ore: it reads the gathering nodes around you from
the game's memory, runs next to the nearest one, clicks it and waits until it's picked, then the next; with none in
sight it wanders until some appear. Put a Scavenging Dagger (plants) or Pick Axe (ore) in your Toolbelt first, and
tick "Gather plants" / "Gather ore". A node it can't reach in 15 seconds, or that won't gather (profession level
too low, or the wrong tool), is left alone for 5 minutes. Potions are drunk as when hunting. Where to go for your
profession level: game-data/gathering.md.

**Gathering trips** (Gather tab) turns Gather into levelling the professions. It reads your Scavenging (plants) and
Mining (ore) levels from the game's memory; the game only loads them once its Professions window has been opened, so
the bot opens it (Ctrl+Shift+P) and shuts it again if need be. A profession that isn't earning experience is shown
with the game's reason and left out. `src/main/gather-planner.ts` then rates every region that grows nodes (from
`game-data/travel.json`) by the profession experience an hour it should bring: each node gives at most
count x 60 / respawn picks an hour, nodes that only grow in some weather or light count a fifth, and one character
makes at most a pick every 8 s (the walking included), the best-paying first. The trip there is spread over half an
hour, spots within 5% of the best go to the one with the most nodes, and maps your level or class can't reach are left
out. Some regions set a profession level of their own (30 in Desert Tunnel, say); whether that keeps lower levels out
isn't known, so it's taken as a requirement (one rule, `neededLevel`, to loosen). The bot travels there, gathers only
the nodes your levels allow, and walks from square to square of the region (busiest first) when nothing is in sight.
A full bag is sold as Grind sells it (Return to Arcadia, Ludvik, and the button again to go back); a death means
Return and back. It plans again after each new profession level and every 20 minutes, moving only to a spot 20%
better. A spot is left out for 30 minutes when there's no way there, nothing to gather is seen for 3 minutes, or the
game refuses a node there that only the region's level allowed (the node then counts as too high at that level).
Picks refused on nodes your level surely allows, three in a row, stop it: the tool is missing. The status line and the
Gather tab show the levels and the spot chosen.

### Best deck

**Best deck** (needs the memory reader) picks the strongest five cards you own and puts them in your deck. Open the
card collection window first. It reads your collection from the game's memory, tries every combination of your
strongest ten cards in simulated games against random decks of the same card levels (both sides playing the way
NPCs do), then for each slot to change clicks the slot, the card (on its level's tab) and "Replace Slot N", and
finally "Save Deck". If the game won't take two copies of a card, it chooses again without copies.

## Boss circuit

**Boss circuit** (its own tab; needs the memory reader) farms Forge Stones through the daily boss quests: the
Seasonal Supply Hunt (Grade E at level 40: three each of ten sub-bosses, for 100 Forge Stones and more; D, C and B
further up) and the Elite Bounties from the Quest Board, ticked on the tab (those above your level are greyed out
once the bot has seen your character). It takes the quests at their NPCs, works out from the quest log what's still to
kill (the reader sends each task's count), and goes round the spawns of those monsters (`bossSpawns` in
`game-data/travel.json`): `src/main/boss-planner.ts` orders them nearest-next by the route there, with Return to
Arcadia counted as a shortcut, leaving out PvP maps and the Warped copies of maps (where there's a plain one). At
each spawn it fights only that monster (fighting anything in the way as it goes), until the task's done or none have
been about for a minute; a spawn cleared or found empty isn't expected back until its respawn time (15 minutes for
the Supply Hunt's) and the circuit waits for it only when nothing else is left. Monsters further above your level
than your fights say is safe (Grind's measurements) are skipped, as are those the combat model says can't be survived
even with potions (with what it would take; see the stat guide), and so is a spawn where the HP went below the
"Get away below" share (35% unless set) with the monster not nearly dead: it reads a Town Portal scroll (else
Returns to Arcadia once out of combat) and leaves that spawn for the run. A death means Return and carrying on; a
full bag is sold as Grind sells it; five minutes with nothing happening at a spawn plans again. Once every task is
done it hands the quest in and says what it brought (the Forge Stones counted in the bag). With the quests done for
the day it stops ("... done for today; next one after reset"), or with "Keep hunting bosses" goes round the same
sub-boss and boss spawns for their drops until stopped. The Circuit card shows each task's count, the spawns in order
with when each is back, and what's skipped.

## Travel

**Travel** (needs the memory reader) runs you to any map or NPC. Type part of a name in the search box on the
Travel tab (a map, or an NPC such as "kang" or "alpha"), pick one and press Start Travel (or double-click it).

It plans the quickest chain of maps from where you stand, leaving out maps your level can't enter and links your
class can't use, and goes through waypoint stones where that's quicker: it walks up to the stone, clicks it, picks
the waypoint in the window (scrolling the list if need be) and presses Activate. Only waypoints you've unlocked are
used (the game lists them once you've opened a stone's window; before that it tries, and drops any it can't find).
On each map it walks the walls from memory, steps at turns and goes round anything in the way. Any map change,
expected or not, plans again from wherever you are. For an NPC it stops within 2 tiles of them.

The links, NPCs and waypoints come from `game-data/travel.json`, built by `node scripts/travel-data.js` from the
database export (below) and the game's map files (for every map's walls and the walking distances between exits).
Re-run it after a game patch.

## Game data (for questions about the game)

`pwsh -File scripts/export-game-db.ps1` reads the game's own database (`Data/System.db`, decrypted by the game's
`LibraryCore.dll`, working on a copy) into `_work/gamedb/export/`, and `node scripts/game-data.js` turns that into
readable summaries in `game-data/` (not committed): `guide.md` (the in-game guide), `leveling.md` (maps by monster
level), `maps.md`, `monsters.md`, `quests.md`, `quests-by-level.md`, `npcs.md`, `dungeons.md`, `items.md`,
`skills.md`, `recipes.md` and `triple-triad-cards.md`. Re-run both after a game patch.

## Layout

- `src/main/win32.ts` – window capture and input via user32/gdi32
- `src/main/labels.ts` – finding overhead names (and fingerprinting them) and item boxes
- `src/main/sightings.ts` – following overhead names from frame to frame
- `src/main/triad-vision.ts`, `triad-digits.ts` – reading the Triple Triad panel and the cards' numbers
- `src/main/triad.ts`, `triad-player.ts`, `triad-memory.ts` – the rules, choosing moves, remembering opponents' decks
- `src/main/minimap.ts` – reading the player and monster markers off the minimap
- `src/main/bigmap.ts` – finding the big map, how much is explored, the unexplored edges, walking distances
- `src/main/explorer.ts` – choosing which edge to head for and where to steer
- `src/test/explore-sim.ts` – a rough simulation of exploring a real map capture, for comparing approaches
- `src/main/vision.ts` – bars, map and other pixel checks
- `src/main/hunter.ts` – the older target-frame-judged targeting (no longer used by Hunt; kept with its tests)
- `src/main/names.ts` – what's been learned about each name
- `src/main/map-grid.ts`, `map-explorer.ts`, `map-path.ts` – the map from memory, exploring it, walking paths
- `src/main/travel.ts` – map links, NPCs and waypoints, place search and route planning
- `src/main/gather-planner.ts` – where to gather for the profession levels
- `src/main/boss-planner.ts` – the Boss circuit's spawns, its quests' tasks, and the order to go round them
- `src/main/loot-judge.ts` – whether a bag item is an upgrade for the character, or rare enough to keep
- `src/main/combat-model.ts` – one fight from both sides' stats: kill time, health and potions it costs, survival and the gap
- `src/main/calibration.ts` – the model checked against the character's fights, and what's learned of their potions
- `src/main/stat-values.ts` – the stat guide: each stat's and elixir's worth for Grind and the Boss circuit, what's out of reach
- `src/main/loadout.ts` – the best gear: totals changed by each swap from the game's own, the search, checks against the game
- `src/main/area-damage.ts` – area damage: measured round the character, the speed-up in crowds and how crowded maps get
- `src/main/bot.ts` – the bot the control window starts and stops; each mode's work is in its own part, sharing `bot-context.ts`:
  - `bot-context.ts` – what every part shares: input, clock, settings, the status line, clicks, keys, potions, aiming
  - `bot-shared.ts` – constants and small helpers more than one part uses
  - `bot-movement.ts` – running and stepping along a path, the teleport key, the mount
  - `bot-travel.ts` – Travel: routes between maps, waypoint stones, exit tiles
  - `bot-hunting.ts` – Hunt: targets, looting, seeking, fighting what's in the way
  - `bot-explore.ts` – Explore, from memory or by the big map
  - `bot-survival.ts` – a full bag (Return to Arcadia, selling, going back), dying, getting out of combat, the old screen selling
  - `bot-quests.ts`, `bot-grind.ts` – Quests and Grind
  - `bot-circuit.ts` – the Boss circuit: its quests, going round the spawns, getting away from a fight going badly
  - `bot-triad.ts` – Triple Triad and Best deck
  - `bot-gathering.ts` – Gather and Train
  - `bot-gather-trips.ts` – Gathering trips: reading the profession levels, going to the best spot, gathering there
  - `bot-loot.ts` – at the shop: locking what the loot judge keeps, putting on clear upgrades
  - `bot-guide.ts` – the stat guide worked out from the game's memory and the grind log, for its card and the other parts
  - `bot-elixirs.ts` – keeping elixirs up that pay while grinding and on the Boss circuit
- `src/renderer/` – the control window
