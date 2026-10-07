type BotApi = import('../shared/types').BotApi;
type Settings = import('../shared/types').Settings;
type KeyId = import('../shared/types').KeyId;
type Area = import('../shared/types').Area;
type Status = import('../shared/types').Status;
type NameEntry = import('../shared/types').NameEntry;
type NameRule = import('../shared/types').NameRule;
type Stats = import('../shared/types').Stats;
type StatCounts = import('../shared/types').StatCounts;
type KeptItem = import('../shared/types').KeptItem;

interface Window {
  bot: BotApi;
}
