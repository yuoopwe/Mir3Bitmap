/** Quests mode: what the quest planner says next, done with the NPCs (quest lists, talking) and the hunt loop. */

import { loadTravelData, type TravelQuest } from './travel';
import { RouteCosts, nextQuestAction, questKey } from './quest-planner';
import type { MemoryState } from './game-memory';
import { VK } from './input';
import { BotError, MEMORY_START_MS, Stopped, boxCentre } from './bot-shared';
import type { BotContext } from './bot-context';

/** The quest log shows a quest taken or handed in within this long (the server's answer). */
const QUEST_TAKEN_MS = 4000;
/** A quest picked from the list shows in its own window within this long; picked this many times at most. */
const QUEST_BOX_MS = 2000;
const QUEST_ROW_TRIES = 3;

export class Questing {
  constructor(private readonly bot: BotContext) {}

  /**
   * Does quests: hands in the ones that are finished, picks up more for the
   * character's level (from the NPCs that give them, while fewer than the
   * setting are on the go), then works on what it has: places to go, people
   * to talk to, and monsters to kill (on the map the quest names, else where
   * they spawn). Deaths and a full bag are dealt with as in Grind.
   */
  async questLoop(): Promise<string> {
    const data = loadTravelData();
    const memory = this.bot.options.memory;
    if (!memory.installed) throw new BotError('Quests needs the memory reader (run scripts/setup-game-reader.ps1).');
    memory.start();
    const started = this.bot.clock.now();
    const byKey = new Map((data.quests ?? []).map((q) => [questKey(q), q]));
    /** Route costs between maps, worked out once each this run (for the quest planner). */
    const routes = new RouteCosts(data);
    /** Things that didn't work this run (an NPC whose quests wouldn't open, a quest that wouldn't hand in, a spot out of reach). */
    const failed = new Set<string>();
    let handedIn = 0;
    let accepted = 0;

    while (true) {
      await this.bot.yieldToEvents();
      const reading = memory.latest();
      const log = reading?.questLog;
      const user = reading?.user;
      if (!reading || !log || !user || user.level === undefined || !memory.map()) {
        this.bot.statusEvery(!reading ? (this.bot.clock.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`) : 'Waiting for the quest log');
        await this.bot.sleep(300);
        continue;
      }
      if (user.dead) {
        await this.bot.survival.reviveInArcadia();
        continue;
      }
      if (this.bot.survival.bagFull(reading)) {
        await this.bot.survival.emptyBag();
        continue;
      }
      // The next thing to do, from the quest planner.
      const action = nextQuestAction(
        data,
        {
          map: memory.map()!.index,
          at: { x: user.x, y: user.y },
          level: user.level,
          cls: user.class,
          log,
          targets: reading.questTargets ?? [],
          pending: reading.questPending,
          waypoints: reading.waypoints?.unlocked?.length ? new Set(reading.waypoints.unlocked.map((w) => w.name)) : undefined,
          failed,
        },
        { maxActive: this.bot.settings.questMaxActive ?? 5 },
        routes,
      );

      // 1. Hand in what's finished.
      if (action.kind === 'handIn') {
        const n = await this.atQuestNpc(action.npc, 'handIn', action.reason);
        if (n > 0) handedIn += n;
        else for (const key of action.keys) failed.add(`hand:${key}`);
        continue;
      }

      // 2. Pick up more.
      if (action.kind === 'pickUp') {
        const n = await this.atQuestNpc(action.npc, 'accept', action.reason);
        if (n > 0) accepted += n;
        else failed.add(`accept:${action.npc}`);
        continue;
      }

      // 3. Places to go, and people to talk to.
      if (action.kind === 'go') {
        const [x, y] = action.at;
        this.bot.status(action.reason);
        try {
          this.bot.status(await this.bot.travel.travelTo(`spot:${action.map}:${x}:${y}`));
          await this.bot.sleep(1500);
        } catch (error) {
          if (error instanceof Stopped) throw error;
          failed.add(`region:${action.region}`);
        }
        // Still pending after getting there: don't keep coming back to it.
        if (memory.latest()?.questPending?.regions.some((r) => r.region === action.region)) failed.add(`region:${action.region}`);
        continue;
      }
      if (action.kind === 'talk') {
        await this.talkTo(action.npc, action.reason);
        if (memory.latest()?.questPending?.talks.some((t) => t.npc === action.npc)) failed.add(`talk:${action.npc}`);
        continue;
      }

      // 4. Monsters to kill.
      if (action.kind === 'hunt') {
        const target = { name: action.monster, map: action.target };
        const map = action.map;
        if (memory.map()!.index !== map) this.bot.status(await this.bot.travel.travelTo(`map:${map}`));
        this.bot.status(action.reason);
        const huntStart = this.bot.clock.now();
        const why = await this.bot.hunting.huntLoop({
          seek: true,
          questOnly: true,
          stopWhen: () => {
            const now = memory.latest();
            if (now?.user?.dead) return 'dead';
            if (this.bot.survival.bagFull(now)) return 'bag';
            if (now?.questLog?.some((q) => q.ready && byKey.has(q.name) && !failed.has(`hand:${q.name}`))) return 'A quest is finished';
            if (!now?.questTargets?.some((t) => t.name === target.name && (t.map === null || t.map === map))) return `Done with ${target.name}`;
            if (now?.map && now.map.index !== map) return 'Left the map';
            return this.bot.clock.now() - huntStart > 20 * 60_000 ? `20 minutes on ${target.name}; trying something else` : null;
          },
        });
        if (why.startsWith('20 minutes')) failed.add(`hunt:${target.name}:${target.map}`);
        if (why === 'dead') await this.bot.survival.reviveInArcadia();
        else if (why === 'bag') await this.bot.survival.emptyBag();
        else this.bot.status(why);
        continue;
      }

      this.bot.stopRunning();
      return `Quests: handed in ${handedIn}, picked up ${accepted}; nothing more to do for now`;
    }
  }

  /**
   * Goes to a quest NPC, opens their quest list (pressing Quests if they show
   * the Talk / Quests menu) and presses Accept All or Hand In; then, when
   * `quest` is still to take (or hand in), picks it from the list and presses
   * its own Accept (or Complete). Returns how many quests that took (0 if the
   * list didn't open or nothing was taken).
   */
  async atQuestNpc(npcId: number, action: 'accept' | 'handIn', why: string, quest?: TravelQuest): Promise<number> {
    const memory = this.bot.options.memory;
    const data = loadTravelData();
    const npc = data.npcs.find((n) => n.id === npcId);
    if (!npc) return 0;
    this.bot.status(why);
    try {
      await this.bot.travel.travelTo(`npc:${npcId}`);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      return 0;
    }
    const list = await this.openQuestList(npc.name);
    if (!list) return 0;
    const count = () => memory.latest()?.questLog?.filter((q) => (action === 'accept' ? true : q.completed)).length;
    const before = count() ?? 0;
    const button = action === 'accept' ? list.acceptAll : list.handIn;
    if (button?.enabled) {
      await this.bot.click(boxCentre(button), this.bot.delay('menu'));
      await this.confirmQuest();
      await this.waitFor(() => (count() ?? before) !== before, QUEST_TAKEN_MS);
    }
    // Some quests are left out of Accept All and Hand In (the Seasonal Supply Hunts: one a day, of your choice): the
    // one wanted is picked from the list and taken (or handed in) with its own button.
    if (quest && !this.questDone(quest, action)) await this.oneQuest(quest, action);
    const after = count() ?? before;
    // Escape shuts the quest's window first, then the list.
    for (let i = 0; i < 2; i++) {
      this.bot.key(VK.ESCAPE);
      await this.bot.sleep(300);
      const survival = memory.latest()?.survival;
      if (!survival?.questList && !survival?.questBox) break;
    }
    return Math.max(0, after - before);
  }

  /** Whether the quest log has `quest` taken (accept) or handed in (handIn). */
  private questDone(quest: TravelQuest, action: 'accept' | 'handIn'): boolean {
    const entry = this.bot.options.memory.latest()?.questLog?.find((q) => q.name === questKey(quest) || q.name === quest.name);
    return action === 'accept' ? !!entry : !!entry?.completed;
  }

  /** With the quest list open: clicks `quest`'s row, then its window's Accept (or Complete), and waits for the quest log to show it. */
  private async oneQuest(quest: TravelQuest, action: 'accept' | 'handIn'): Promise<void> {
    const memory = this.bot.options.memory;
    const named = (name: string | null | undefined) => name === quest.name || name === questKey(quest);
    const row = memory.latest()?.survival?.questList?.rows?.find((r) => named(r.name));
    if (!row) return;
    const shown = () => {
      const box = memory.latest()?.survival?.questBox;
      const button = action === 'accept' ? box?.accept : box?.complete;
      return box && named(box.quest) && button?.enabled ? button : null;
    };
    for (let tries = 0; tries < QUEST_ROW_TRIES && !shown(); tries++) {
      this.bot.status(`Picking ${quest.name} from the list`);
      // The last try a double-click, should single clicks not pick it.
      const point = boxCentre(row);
      if (tries < QUEST_ROW_TRIES - 1) await this.bot.click(point, this.bot.delay('menu'));
      else this.bot.input.doubleClick(this.bot.hwnd, point.x, point.y);
      await this.waitFor(() => !!shown(), QUEST_BOX_MS);
    }
    const button = shown();
    if (!button) return;
    await this.bot.click(boxCentre(button), this.bot.delay('menu'));
    await this.confirmQuest();
    await this.waitFor(() => this.questDone(quest, action), QUEST_TAKEN_MS);
  }

  /** An "are you sure?" or a reward choice after taking or handing in: press its Yes / OK. */
  private async confirmQuest(): Promise<void> {
    await this.bot.sleep(500);
    const ask = this.bot.options.memory.latest()?.survival?.messages?.find((m) => m.buttons.some((b) => /yes|ok|confirm/i.test(b.name)));
    const yes = ask?.buttons.find((b) => /yes|ok|confirm/i.test(b.name));
    if (yes) await this.bot.click(boxCentre(yes), this.bot.delay('menu'));
  }

  private async waitFor(ok: () => boolean, ms: number): Promise<boolean> {
    for (const since = this.bot.clock.now(); this.bot.clock.now() - since < ms; ) {
      if (ok()) return true;
      await this.bot.sleep(300);
    }
    return ok();
  }

  /** Clicks an NPC (standing next to them) and opens their quest list; null if it didn't open. */
  private async openQuestList(npcName: string): Promise<NonNullable<NonNullable<MemoryState['survival']>['questList']> | null> {
    const memory = this.bot.options.memory;
    const list = () => memory.latest()?.survival?.questList ?? null;
    for (let attempt = 0; attempt < 3 && !list(); attempt++) {
      if (!(await this.clickNpc(npcName))) return null;
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < 3000 && !list(); ) {
        const menu = memory.latest()?.survival?.npcMenu;
        if (menu?.quests?.enabled) {
          await this.bot.click(boxCentre(menu.quests), this.bot.delay('menu'));
          await this.bot.sleep(500);
        }
        await this.bot.sleep(150);
      }
    }
    return list();
  }

  /** Clicks an NPC in view by name (hovering until the game confirms it's under the mouse). */
  private async clickNpc(npcName: string): Promise<boolean> {
    const reading = this.bot.options.memory.latest();
    const npc = reading?.objects?.find((o) => o.kind === 'npc' && o.name === npcName);
    if (!npc || !reading?.user) return false;
    this.bot.stopRunning();
    const tile = this.bot.toScreen(reading.user, npc.x, npc.y);
    const point = (await this.bot.aimAt({ key: `npc${npc.id}`, point: tile, name: npcName, tile })) ?? tile;
    await this.bot.click(point, this.bot.delay('menu'));
    return true;
  }

  /** A quest's "talk to": goes to the NPC, clicks them and presses Talk if they ask. */
  private async talkTo(npcId: number, why: string): Promise<void> {
    const memory = this.bot.options.memory;
    const npc = loadTravelData().npcs.find((n) => n.id === npcId);
    if (!npc) return;
    this.bot.status(why);
    try {
      await this.bot.travel.travelTo(`npc:${npcId}`);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      return;
    }
    if (!(await this.clickNpc(npc.name))) return;
    await this.bot.sleep(800);
    const menu = memory.latest()?.survival?.npcMenu;
    if (menu?.talk?.enabled) await this.bot.click(boxCentre(menu.talk), this.bot.delay('menu'));
    await this.bot.sleep(1500);
    this.bot.key(VK.ESCAPE);
    await this.bot.sleep(300);
  }
}
