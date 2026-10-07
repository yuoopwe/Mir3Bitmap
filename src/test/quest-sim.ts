/**
 * A stand-in for the game's quest log, for trying the quest planner: picks up,
 * hands in, goes, talks and hunts as the planner says, each done at once, and
 * shows the planner what the game's memory would (the log, the targets and the
 * pending tasks of each quest's current stage).
 */
import { questKey, type QuestAction, type QuestState } from '../main/quest-planner';
import type { TravelData, TravelQuest } from '../main/travel';

export class QuestSim {
  map: number;
  /** Quests handed in, by key. */
  readonly completed: Set<string>;
  /** Quests on the go: which of their tasks are done. */
  readonly active = new Map<string, { quest: TravelQuest; done: Set<number> }>();
  readonly failed = new Set<string>();
  /** Every action taken, and the map changes. */
  readonly actions: QuestAction[] = [];
  trips = 0;

  constructor(
    private readonly data: TravelData,
    start: { map: number; level: number; cls?: number; completed?: string[] },
    readonly level = start.level,
    readonly cls = start.cls,
  ) {
    this.map = start.map;
    this.completed = new Set(start.completed ?? []);
  }

  /** The tasks of a quest's current stage (the lowest stage with any left), by index. */
  private current(entry: { quest: TravelQuest; done: Set<number> }): number[] {
    const left = entry.quest.tasks.map((t, i) => ({ stage: t.stage ?? 0, i })).filter(({ i }) => !entry.done.has(i));
    const stage = Math.min(...left.map((t) => t.stage));
    return left.filter((t) => t.stage === stage).map((t) => t.i);
  }

  state(): QuestState {
    const log = [
      ...[...this.completed].map((name) => ({ name, completed: true, ready: true })),
      ...[...this.active].map(([name, e]) => ({ name, completed: false, ready: e.done.size === e.quest.tasks.length })),
    ];
    const targets: QuestState['targets'][number][] = [];
    const regions: { quest: string; region: number; map: number | null }[] = [];
    const talks: { quest: string; npc: number }[] = [];
    for (const entry of this.active.values()) {
      for (const i of this.current(entry)) {
        const task = entry.quest.tasks[i];
        if (task.type === 'KillMonster' || task.type === 'GainItem') {
          for (const [name, map] of task.monsters ?? []) targets.push({ name, map: map ?? null, quest: entry.quest.name });
        } else if (task.type === 'Region' && task.region) regions.push({ quest: entry.quest.name, region: task.region.id, map: task.region.map });
        else if (task.type === 'TalkToNPC' && task.npc !== undefined) talks.push({ quest: entry.quest.name, npc: task.npc });
      }
    }
    return { map: this.map, level: this.level, cls: this.cls, log, targets, pending: { regions, talks }, failed: this.failed };
  }

  /** Does what the planner said, as if it all went well. */
  apply(action: QuestAction): void {
    this.actions.push(action);
    if (action.kind === 'none') return;
    if (action.map !== this.map) this.trips++;
    this.map = action.map;
    const quests = this.data.quests ?? [];
    const each = (fn: (entry: { quest: TravelQuest; done: Set<number> }, i: number) => boolean) => {
      for (const entry of this.active.values()) for (const i of this.current(entry)) if (fn(entry, i)) entry.done.add(i);
    };
    switch (action.kind) {
      case 'pickUp':
        for (const quest of quests.filter((q) => q.start === action.npc && action.quests.includes(q.name))) this.active.set(questKey(quest), { quest, done: new Set() });
        break;
      case 'handIn':
        for (const [key, entry] of [...this.active]) {
          if (entry.quest.finish === action.npc && entry.done.size === entry.quest.tasks.length) {
            this.active.delete(key);
            this.completed.add(key);
          }
        }
        break;
      case 'go':
        each((e, i) => e.quest.tasks[i].region?.id === action.region);
        break;
      case 'talk':
        each((e, i) => e.quest.tasks[i].type === 'TalkToNPC' && e.quest.tasks[i].npc === action.npc);
        break;
      case 'hunt':
        each((e, i) => !!e.quest.tasks[i].monsters?.some(([name, map]) => name === action.monster && (map === undefined || map === action.map)));
        break;
    }
  }
}
