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

- The game's client area must be 1600x900 with the default HUD layout; screen positions are in `src/main/layout.ts`.
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

Set up once (needs PowerShell 7): `pwsh -File scripts/setup-game-reader.ps1`. Tiles are 48x32 pixels on screen and
the player's tile is centred on (804, 416), measured with the tile under the mouse from the game's memory (MapControl.MapLocation, also in the reader's output as user.mouseTile) while standing still.

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
- `src/main/bot.ts` – the bot the control window starts and stops; each mode's work is in its own part, sharing `bot-context.ts`:
  - `bot-context.ts` – what every part shares: input, clock, settings, the status line, clicks, keys, potions, aiming
  - `bot-shared.ts` – constants and small helpers more than one part uses
  - `bot-movement.ts` – running and stepping along a path, the teleport key, the mount
  - `bot-travel.ts` – Travel: routes between maps, waypoint stones, exit tiles
  - `bot-hunting.ts` – Hunt: targets, looting, seeking, fighting what's in the way
  - `bot-explore.ts` – Explore, from memory or by the big map
  - `bot-survival.ts` – a full bag (Return to Arcadia, selling, going back), dying, getting out of combat, the old screen selling
  - `bot-quests.ts`, `bot-grind.ts` – Quests and Grind
  - `bot-triad.ts` – Triple Triad and Best deck
  - `bot-gathering.ts` – Gather and Train
  - `bot-gather-trips.ts` – Gathering trips: reading the profession levels, going to the best spot, gathering there
- `src/renderer/` – the control window
