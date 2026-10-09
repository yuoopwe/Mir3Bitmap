# Reads what's around the player straight from the running game's memory (read-only, using Microsoft's
# ClrMD) and prints it as one JSON line every ~150 ms, for the bot to use instead of reading the screen.
# Needs the libraries in .\lib (scripts/setup-game-reader.ps1 downloads them). Runs until the bot (-ParentPid)
# is gone, so a bot that was closed or killed never leaves it reading the game in the background.
param([int]$IntervalMs = 150, [int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
$lib = Join-Path $PSScriptRoot 'lib'
# ClrMD's helpers (Azure.Core is only used for symbol downloads, but has to load).
Get-ChildItem $lib -Filter *.dll | Where-Object { $_.Name -ne 'Microsoft.Diagnostics.Runtime.dll' } | ForEach-Object { try { Add-Type -Path $_.FullName } catch {} }
Add-Type -Path (Join-Path $lib 'Microsoft.Diagnostics.Runtime.dll')
Add-Type -Path (Join-Path $PSScriptRoot 'MapReading.cs') -ReferencedAssemblies (Join-Path $lib 'Microsoft.Diagnostics.Runtime.dll')

# Ends the reader once the bot that started it has gone (checked about once a second).
$parentCheck = [Diagnostics.Stopwatch]::StartNew()
function Exit-IfOrphaned {
  if ($ParentPid -le 0 -or $parentCheck.ElapsedMilliseconds -lt 1000) { return }
  $parentCheck.Restart()
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
}

function Write-State($state) {
  Exit-IfOrphaned
  [Console]::Out.WriteLine(($state | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

# Library.Stat.PickUpRadius: how far (in tiles) clicking at the feet picks things up.
$PickUpRadius = 40

# Library.Stat numbers for health and the stats that decide how fast the character kills and how much it takes.
$HealthStat = 2
$CombatStats = @{ minAC = 4; maxAC = 5; minMR = 6; maxMR = 7; minDC = 8; maxDC = 9; minMC = 10; maxMC = 11; minSC = 12; maxSC = 13; accuracy = 14; agility = 15; attackSpeed = 16 }
# The % stats, which multiply what they're for (HealthPercent 54, MCPercent 67, DCPercent 84, SCPercent 85,
# MagicDefencePercent 92, PhysicalDefencePercent 93, ManaPercent 94, ACPercent 10031, MRPercent 10032), and the most
# weight that may be worn on the body and in hand (WearWeight 74, HandWeight 75).
$PercentStats = @(54, 67, 84, 85, 92, 93, 94, 10031, 10032)
$WearWeightStat = 74
$HandWeightStat = 75

# One of the player's stats: Stats.Values is a SortedDictionary, i.e. a binary search tree keyed by stat number.
function Read-Stat($userObject, [int]$stat) {
  $stats = $userObject.ReadObjectField('_Stats')
  if ($stats.IsNull) { return 0 }
  $node = $stats.ReadObjectField('<Values>k__BackingField').ReadObjectField('_set').ReadObjectField('root')
  while (-not $node.IsNull) {
    $pair = $node.ReadValueTypeField('<Item>k__BackingField')
    $key = $pair.ReadField[int]('key')
    if ($key -eq $stat) { return $pair.ReadField[int]('value') }
    $node = $node.ReadObjectField($(if ($stat -lt $key) { '<Left>k__BackingField' } else { '<Right>k__BackingField' }))
  }
  return 0
}

# One element of an array of numbers or enums, whatever their size.
function Read-Number($array, $index) {
  switch ($array.Type.ComponentSize) {
    1 { return [int]$array.GetValue[byte]($index) }
    2 { return [int]$array.GetValue[int16]($index) }
    8 { return [long]$array.GetValue[long]($index) }
    default { return $array.GetValue[int]($index) }
  }
}

# Items of a List<T> or array of objects.
function Read-List($list) {
  $out = [System.Collections.Generic.List[object]]::new()
  if ($list.IsNull) { return ,$out }
  if ($list.IsArray) {
    $array = $list.AsArray()
    for ($i = 0; $i -lt $array.Length; $i++) { $out.Add($array.GetObjectValue($i)) }
    return ,$out
  }
  $size = $list.ReadField[int]('_size')
  $items = $list.ReadObjectField('_items').AsArray()
  for ($i = 0; $i -lt $size; $i++) { $out.Add($items.GetObjectValue($i)) }
  return ,$out
}

function Read-Card($card) {
  if ($card.IsNull) { return $null }
  return @{
    name = $card.ReadStringField('<Name>k__BackingField'); image = $card.ReadField[int]('<ImageIndex>k__BackingField')
    up = $card.ReadField[int]('<Up>k__BackingField'); right = $card.ReadField[int]('<Right>k__BackingField')
    down = $card.ReadField[int]('<Down>k__BackingField'); left = $card.ReadField[int]('<Left>k__BackingField')
    element = [int]$card.ReadField[byte]('<Element>k__BackingField'); level = $card.ReadField[int]('<Level>k__BackingField')
  }
}

# A control's top-left corner on the game's screen (its own position plus all its parents').
function Read-ScreenLocation($control) {
  $x = 0; $y = 0
  while (-not $control.IsNull) {
    $location = $control.ReadValueTypeField('_Location')
    $x += $location.ReadField[int]('x'); $y += $location.ReadField[int]('y')
    $control = $control.ReadObjectField('_Parent')
  }
  return @($x, $y)
}

# Every Triple Triad card by its picture number (the decks are lists of these), read once per attach.
$script:cardsByImage = $null
function Find-Card($module, $domain, [int]$image) {
  if (-not $script:cardsByImage) {
    $script:cardsByImage = @{}
    $all = $module.GetTypeByName('Client.Scenes.Views.TripleTriad.TripleTriadCardDB').GetStaticFieldByName('<AllCards>k__BackingField').ReadObject($domain)
    foreach ($card in (Read-List $all)) { $c = Read-Card $card; if ($c -and -not $script:cardsByImage.ContainsKey($c.image)) { $script:cardsByImage[$c.image] = $c } }
  }
  $found = $script:cardsByImage[$image]
  if ($found) { return $found.Clone() }
  return @{ image = $image; name = '?'; up = 0; right = 0; down = 0; left = 0; element = 0 }
}

# How much the game scales its windows and buttons (RenderingPipelineManager._displayScale): 1 at 1600x900, 1.5 at
# 2560x1440. Controls are laid out unscaled; the map isn't scaled. Set each round from the game.
$script:uiScale = 1.0

# A control's box on the game's screen (its layout scaled by the game's UI scale).
function Read-Box($control) {
  $at = Read-ScreenLocation $control
  $size = $control.ReadValueTypeField('_Size')
  $k = $script:uiScale
  return @{ x = [int][math]::Round($at[0] * $k); y = [int][math]::Round($at[1] * $k); width = [int][math]::Round($size.ReadField[int]('width') * $k); height = [int][math]::Round($size.ReadField[int]('height') * $k) }
}

# A List<int> (or int array) of picture numbers.
function Read-IntList($list) {
  $out = @()
  if ($list.IsNull) { return $out }
  if ($list.IsArray) { $array = $list.AsArray(); for ($i = 0; $i -lt $array.Length; $i++) { $out += Read-Number $array $i }; return $out }
  $size = $list.ReadField[int]('_size')
  $items = $list.ReadObjectField('_items').AsArray()
  for ($i = 0; $i -lt $size; $i++) { $out += Read-Number $items $i }
  return $out
}

# The Triple Triad match on screen, if any: the board, both decks, whose turn it is, and where the hand's cards are.
function Read-Triad($scene, $module, $domain) {
  # The result box's OK button, once a game is over.
  $ok = $null
  $result = $scene.ReadObjectField('_tripleTriadResultBox')
  if (-not $result.IsNull -and $result.ReadField[bool]('_IsVisible')) {
    $button = $result.ReadObjectField('OKButton')
    if (-not $button.IsNull -and $button.ReadField[bool]('_IsVisible')) { $ok = Read-Box $button }
  }
  $dialog = $scene.ReadObjectField('TripleTriadBox')
  if ($dialog.IsNull -or -not $dialog.ReadField[bool]('_IsVisible')) { if ($ok) { return @{ open = $false; ok = $ok } }; return $null }
  $game = $dialog.ReadObjectField('_manager').ReadObjectField('<Game>k__BackingField')
  if ($game.IsNull) { return @{ open = $true; ok = $ok } }
  $players = Read-List ($game.ReadObjectField('<Players>k__BackingField'))
  $current = $game.ReadObjectField('<CurrentPlayer>k__BackingField')
  $board = $game.ReadObjectField('<Board>k__BackingField')
  $cells = $board.ReadObjectField('_cells').AsArray()
  $elements = $board.ReadObjectField('_elements').AsArray()
  $placed = @(); $boardElements = @()
  for ($row = 0; $row -lt 3; $row++) {
    for ($col = 0; $col -lt 3; $col++) {
      $cell = $cells.GetObjectValue(@($row, $col))
      $card = if ($cell.IsNull) { $null } else { Read-Card ($cell.ReadObjectField('<Card>k__BackingField')) }
      if ($card) {
        $owner = $cell.ReadObjectField('<Owner>k__BackingField')
        $card.owner = [array]::IndexOf(@($players | ForEach-Object { $_.Address }), $owner.Address)
      }
      $placed += ,$card
      $boardElements += Read-Number $elements @($row, $col)
    }
  }
  $rules = 0
  foreach ($rule in (Read-RuleList ($game.ReadObjectField('<ActiveRules>k__BackingField')))) { $rules = $rules -bor $rule }
  # My hand as drawn (each card and where it is), and where the board's squares are.
  $hand = @()
  $deckCells = $dialog.ReadObjectField('_deckCells').AsArray()
  for ($i = 0; $i -lt $deckCells.Length; $i++) {
    $control = $deckCells.GetObjectValue($i)
    if ($control.IsNull -or -not $control.ReadField[bool]('_IsVisible')) { continue }
    $box = Read-Box $control
    $box.card = Find-Card $module $domain ($control.ReadField[int]('_Index'))
    $hand += ,$box
  }
  $squares = @()
  $boardCells = $dialog.ReadObjectField('_boardCells').AsArray()
  for ($row = 0; $row -lt 3; $row++) { for ($col = 0; $col -lt 3; $col++) { $square = $boardCells.GetObjectValue(@($row, $col)); $box = Read-Box $square; $box.image = $square.ReadField[int]('_Index'); $squares += ,$box } }
  $turns = $dialog.ReadObjectField('_authoritativeTurns')
  return @{
    open = $true
    ok = $ok
    rules = $rules
    current = [array]::IndexOf(@($players | ForEach-Object { $_.Address }), $current.Address)
    stage = if ($turns.IsNull) { -1 } else { $turns.ReadField[int]('_stage') }
    complete = $dialog.ReadField[bool]('_authoritativeMatchComplete')
    players = @($players | ForEach-Object { @{ name = $_.ReadStringField('<Name>k__BackingField'); ai = $_.ReadField[bool]('<IsAI>k__BackingField'); deck = @(Read-List ($_.ReadObjectField('<Deck>k__BackingField')) | ForEach-Object { Read-Card $_ }) } })
    board = $placed
    elements = $boardElements
    hand = $hand
    squares = $squares
    myDeck = @(Read-IntList ($dialog.ReadObjectField('<PlayerDeck>k__BackingField')) | ForEach-Object { Find-Card $module $domain $_ })
    opponentDeck = @(Read-IntList ($dialog.ReadObjectField('<OpponentDeck>k__BackingField')) | ForEach-Object { Find-Card $module $domain $_ })
    playerName = $dialog.ReadStringField('<PlayerName>k__BackingField')
    opponentName = $dialog.ReadStringField('<OpponentName>k__BackingField')
  }
}

# A button: where it is, whether it can be pressed, and what it says.
function Read-Button($button) {
  if ($button.IsNull) { return $null }
  $box = Read-Box $button
  $box.enabled = $button.ReadField[bool]('_IsEnabled') -and $button.ReadField[bool]('_IsVisible')
  $label = $button.ReadObjectField('<Label>k__BackingField')
  $box.text = if ($label.IsNull) { '' } else { $label.ReadStringField('_Text') }
  return $box
}

# The card collection window, if open: the cards owned, the deck being edited, and where everything is drawn.
function Read-Collection($scene, $module, $domain) {
  $dialog = $scene.ReadObjectField('TripleTriadCollectionBox')
  if ($dialog.IsNull -or -not $dialog.ReadField[bool]('_IsVisible')) { return $null }
  $user = $scene.ReadObjectField('_User')
  $owned = @()
  foreach ($entry in (Read-List ($user.ReadObjectField('TripleTriadCards')))) {
    $owned += ,@{ card = (Find-Card $module $domain ($entry.ReadField[int]('<Index>k__BackingField'))); count = $entry.ReadField[int]('<Count>k__BackingField') }
  }
  $deckSlots = @()
  $cells = $dialog.ReadObjectField('_deckCells').AsArray()
  for ($i = 0; $i -lt $cells.Length; $i++) { $deckSlots += ,(Read-Box ($cells.GetObjectValue($i))) }
  $tabs = @()
  $levelTabs = $dialog.ReadObjectField('_levelTabs')
  $entries = $levelTabs.ReadObjectField('_entries').AsArray()
  for ($e = 0; $e -lt $levelTabs.ReadField[int]('_count'); $e++) {
    $entry = $entries.GetStructValue($e)
    $info = $entry.ReadObjectField('value')
    if ($info.IsNull) { continue }
    $tab = $info.ReadObjectField('Tab')
    $panel = $info.ReadObjectField('CardPanel')
    $scroll = $info.ReadObjectField('ScrollBar')
    $slots = @()
    foreach ($slot in (Read-List ($info.ReadObjectField('Slots')))) {
      $image = $slot.ReadObjectField('Image')
      if ($image.IsNull) { continue }
      $box = Read-Box $image
      $box.image = $slot.ReadField[int]('CardIndex')
      $box.shown = $slot.ReadField[bool]('FilteredIn') -and $image.ReadField[bool]('_IsVisible')
      $slots += ,$box
    }
    $tabs += ,@{
      level = $entry.ReadField[int]('key'); selected = $tab.ReadField[bool]('_Selected')
      button = Read-Button ($tab.ReadObjectField('<TabButton>k__BackingField')); panel = Read-Box $panel
      up = if ($scroll.IsNull) { $null } else { Read-Button ($scroll.ReadObjectField('UpButton')) }
      down = if ($scroll.IsNull) { $null } else { Read-Button ($scroll.ReadObjectField('DownButton')) }
      slots = $slots
    }
  }
  return @{
    owned = $owned
    saved = @(Read-IntList ($user.ReadObjectField('TripleTriadDeck')))
    draft = @(Read-IntList ($dialog.ReadObjectField('_draftDeck')))
    dirty = $dialog.ReadField[bool]('_deckDirty')
    selectedSlot = $dialog.ReadField[int]('_selectedDeckSlot')
    detail = $dialog.ReadField[int]('_selectedDetailCard')
    feedback = $dialog.ReadStringField('_deckFeedback')
    deckSlots = $deckSlots
    action = Read-Button ($dialog.ReadObjectField('_deckActionButton'))
    save = Read-Button ($dialog.ReadObjectField('_saveDeckButton'))
    undo = Read-Button ($dialog.ReadObjectField('_revertDeckButton'))
    tabs = $tabs
    cards = @($script:cardsByImage.Values)
  }
}

# The values of a List<TripleTriadRule> (an enum list, so plain ints).
function Read-RuleList($list) {
  $out = @()
  if ($list.IsNull) { return $out }
  if ($list.Type.Name -notlike 'System.Collections.Generic.List*') { return $out }
  $size = $list.ReadField[int]('_size')
  $items = $list.ReadObjectField('_items').AsArray()
  for ($i = 0; $i -lt $size; $i++) { $out += Read-Number $items $i }
  return $out
}

# The map: its size, its walls (sent when the map changes, and again on each attach) and its explored blocks (sent when
# they change). Walls read just after arriving can be the map still loading (all walls): they're read again a few times
# over the first seconds on a map, and sent again if they've changed.
$WallsRecheckMs = @(1500, 4000, 8000)
function Read-Map($scene) {
  $control = $scene.ReadObjectField('MapControl')
  $info = $control.ReadObjectField('_MapInfo')
  if ($info.IsNull) { return $null }
  $index = $info.ReadField[int]('<Index>k__BackingField')
  $width = $control.ReadField[int]('Width'); $height = $control.ReadField[int]('Height')
  $map = @{ index = $index; name = $info.ReadStringField('_Description'); width = $width; height = $height }
  $key = "$index/$width/$height"
  if ($script:wallsSent -ne $key) {
    $map.walls = [Convert]::ToBase64String([MapReading]::Walls($control))
    $script:wallsSent = $key
    $script:wallsLast = $map.walls
    $script:wallsAt = [Diagnostics.Stopwatch]::StartNew()
    $script:wallsChecks = 0
    $script:exploredSent = $null
  } elseif ($script:wallsAt -and $script:wallsChecks -lt $WallsRecheckMs.Count -and $script:wallsAt.ElapsedMilliseconds -ge $WallsRecheckMs[$script:wallsChecks]) {
    $script:wallsChecks++
    $walls = [Convert]::ToBase64String([MapReading]::Walls($control))
    if ($walls -ne $script:wallsLast) { $map.walls = $walls; $script:wallsLast = $walls }
  }
  # Exploration is kept per map (and per instance, for dungeons visited this session).
  $states = $scene.ReadObjectField('<MapExplorationStore>k__BackingField').ReadObjectField('_states')
  $entries = $states.ReadObjectField('_entries').AsArray()
  $state = $null
  for ($i = 0; $i -lt $states.ReadField[int]('_count'); $i++) {
    $entry = $entries.GetStructValue($i)
    if ($entry.ReadField[int]('next') -lt -1) { continue }
    $candidate = $entry.ReadObjectField('value')
    if ($candidate.IsNull -or $candidate.ReadField[int]('<MapIndex>k__BackingField') -ne $index) { continue }
    # An instance's own record (SessionOnly) wins over the map's.
    if (-not $state -or $candidate.ReadField[bool]('<SessionOnly>k__BackingField')) { $state = $candidate }
  }
  if ($state) {
    $map.blockSize = $state.ReadField[int]('<BlockSize>k__BackingField')
    $map.gridWidth = $state.ReadField[int]('<GridWidth>k__BackingField')
    $map.gridHeight = $state.ReadField[int]('<GridHeight>k__BackingField')
    $map.revision = $state.ReadField[int]('<Revision>k__BackingField')
    $sent = "$key/$($map.revision)/$($state.Address)"
    if ($script:exploredSent -ne $sent) {
      $bits = $state.ReadObjectField('_exploredBits').AsArray()
      $map.explored = [Convert]::ToBase64String($bits.ReadValues[byte](0, $bits.Length))
      $script:exploredSent = $sent
    }
  }
  return $map
}

# Waypoints: the ones unlocked (the game fills this in once the waypoint window has been opened), and
# while the window is open, its rows (name and Activate button) and scrollbar.
function Read-Waypoints($scene) {
  $unlocked = @()
  $list = $scene.ReadObjectField('_User').ReadObjectField('UserWaypoints')
  foreach ($w in (Read-List $list)) {
    if ($w.ReadField[bool]('<IsUnlocked>k__BackingField')) { $unlocked += ,@{ name = $w.ReadStringField('<WaypointName>k__BackingField'); map = $w.ReadField[int]('<MapIndex>k__BackingField') } }
  }
  $out = @{ unlocked = $unlocked; open = $false }
  $box = $scene.ReadObjectField('WaypointsBox')
  if ($box.IsNull -or -not $box.ReadField[bool]('_IsVisible')) { return $out }
  $out.open = $true
  $rows = @()
  $array = $box.ReadObjectField('WaypointRows').AsArray()
  for ($i = 0; $i -lt $array.Length; $i++) {
    $row = $array.GetObjectValue($i)
    if ($row.IsNull -or -not $row.ReadField[bool]('_IsVisible')) { continue }
    $info = $row.ReadObjectField('<WaypointInfo>k__BackingField')
    if ($info.IsNull) { continue }
    $catalogue = $info.ReadObjectField('<Catalogue>k__BackingField')
    $rows += ,@{ name = $(if ($catalogue.IsNull) { $null } else { $catalogue.ReadStringField('_Name') }); activate = Read-Button ($row.ReadObjectField('ActivateButton')) }
  }
  $out.rows = $rows
  $out.total = $box.ReadObjectField('WaypointSearchResults').ReadField[int]('_size')
  $bar = $box.ReadObjectField('WaypointScrollBar')
  $out.scroll = @{ value = $bar.ReadField[int]('_Value'); max = $bar.ReadField[int]('_MaxValue'); up = Read-Button ($bar.ReadObjectField('UpButton')); down = Read-Button ($bar.ReadObjectField('DownButton')) }
  return $out
}

# The game's windows showing right now (minimap, quest tracker, any dialog...), as boxes: holding the run
# button over one doesn't run. The scene's window fields are listed once per attach.
function Read-Windows($scene) {
  if (-not $script:windowFields) {
    $script:windowFields = @(foreach ($f in $scene.Type.Fields) {
      if (-not $f.IsObjectReference) { continue }
      try { $o = $scene.ReadObjectField($f.Name) } catch { continue }
      if (-not $o.IsNull -and $o.Type.GetFieldByName('_IsVisible') -and $o.Type.GetFieldByName('_Location')) { $f.Name }
    })
  }
  $boxes = @()
  foreach ($name in $script:windowFields) {
    $o = $scene.ReadObjectField($name)
    if ($o.IsNull -or -not $o.ReadField[bool]('_IsVisible')) { continue }
    $box = Read-Box $o
    # Not the game world itself (MapControl covers the whole screen), nor empty controls.
    if ($box.width -le 0 -or $box.height -le 0 -or $box.width * $box.height -ge 1000000) { continue }
    $box.name = $name
    $boxes += ,$box
  }
  return $boxes
}

# Whether anything is in the Horse equipment slot (EquipmentSlot.Horse = 18): no mount yet, nothing to get on.
function Read-HasMount($scene) {
  try {
    $equipment = $scene.ReadObjectField('Equipment')
    if ($equipment.IsNull) { return $null }
    $slots = $equipment.AsArray()
    if ($slots.Length -le 18) { return $null }
    return -not $slots.GetObjectValue(18).IsNull
  } catch { return $null }
}

# Quest targets: the monsters (and the map, when a task names one) still needed by an unfinished task
# of a quest in the log. A task's monsters come from QuestTask.MonsterDetails (a DBBindingList).
function Read-BindingList($list) {
  if ($list.IsNull) { return @() }
  return Read-List ($list.ReadObjectField('items'))
}
function Read-QuestTargets($scene) {
  $targets = @{}
  $script:questLog = @()
  # Unfinished "go to" and "talk to" tasks: the region (index) and its map, or the NPC (index).
  $script:questPending = @{ regions = @(); talks = @() }
  foreach ($quest in (Read-List ($scene.ReadObjectField('QuestLog')))) {
    $info = $quest.ReadObjectField('<Quest>k__BackingField')
    $questName = if ($info.IsNull) { '' } else { $info.ReadStringField('_QuestName') }
    # The quest's tasks (QuestInfo.Tasks), each with its progress: the character's entry for it, which the game only
    # adds once there's been some (a quest just taken has none: nothing done yet, not everything).
    $progressOf = @{}
    foreach ($p in (Read-List ($quest.ReadObjectField('<Tasks>k__BackingField')))) {
      $t = $p.ReadObjectField('<Task>k__BackingField')
      if (-not $t.IsNull) { $progressOf["$($t.Address)"] = $p }
    }
    $tasks = @()
    if (-not $info.IsNull) {
      foreach ($task in (Read-BindingList ($info.ReadObjectField('<Tasks>k__BackingField')))) {
        if ($task.IsNull) { continue }
        $p = $progressOf["$($task.Address)"]
        # Some quests leave the per-character requirement at 0: the task's own amount is the target then.
        $required = $(if ($p) { $p.ReadField[int]('<RequiredAmount>k__BackingField') } else { 0 })
        if ($required -le 0) { $required = $task.ReadField[int]('_Amount') }
        $have = $(if ($p) { $p.ReadField[long]('<Amount>k__BackingField') } else { 0 })
        $tasks += ,@{ task = $task; required = $required; have = $have; stage = $task.ReadField[int]('_Stage'); mine = [bool]$p }
      }
    }
    # A quest can hold the tasks of several versions of itself: the character's are the ones with entries (none yet: all count).
    $mine = @($tasks | Where-Object { $_.mine })
    if ($mine.Count -gt 0) { $tasks = $mine }
    # A staged quest only counts the current stage's tasks (kills before reaching it don't count).
    $staged = -not $info.IsNull -and $(try { $info.ReadField[bool]('_Staged') } catch { $false })
    $stage = $quest.ReadField[int]('<CurrentStage>k__BackingField')
    # The log: each quest, whether it's been handed in, and whether every task is done (ready to hand in).
    $completed = $quest.ReadField[bool]('<Completed>k__BackingField')
    $ready = -not $completed -and @($tasks | Where-Object { $_.required -gt 0 -and $_.have -lt $_.required }).Count -eq 0
    $script:questLog += ,@{ name = $questName; completed = $completed; ready = $ready }
    if ($completed) { continue }
    foreach ($entry in $tasks) {
      if ($staged -and $entry.stage -gt 0 -and $entry.stage -ne $stage) { continue }
      $task = $entry.task; $required = $entry.required; $have = $entry.have
      $kind = $task.ReadField[int]('_Task')
      if ($required -gt 0 -and $have -ge $required) { continue }
      if ($kind -eq 2) {
        $region = $task.ReadObjectField('_RegionParameter')
        if (-not $region.IsNull) {
          $map = $region.ReadObjectField('_Map')
          $script:questPending.regions += ,@{ quest = $questName; region = $region.ReadField[int]('<Index>k__BackingField'); map = $(if ($map.IsNull) { $null } else { $map.ReadField[int]('<Index>k__BackingField') }) }
        }
      } elseif ($kind -eq 10) {
        $npc = $task.ReadObjectField('_NpcParameter')
        if (-not $npc.IsNull) { $script:questPending.talks += ,@{ quest = $questName; npc = $npc.ReadField[int]('<Index>k__BackingField') } }
      }
      # Every unfinished task counts, whatever the quest's stage: the game marks those monsters "(Quest)" too.
      foreach ($detail in (Read-BindingList ($task.ReadObjectField('<MonsterDetails>k__BackingField')))) {
        $monster = $detail.ReadObjectField('_Monster')
        if ($monster.IsNull) { continue }
        $name = $monster.ReadStringField('_MonsterName')
        $map = $detail.ReadObjectField('_Map')
        $mapIndex = if ($map.IsNull) { $null } else { $map.ReadField[int]('<Index>k__BackingField') }
        $key = "$name|$mapIndex"
        # With the task's progress: done of need.
        if (-not $targets.ContainsKey($key)) { $targets[$key] = @{ name = $name; map = $mapIndex; quest = $questName; done = $have; need = $required } }
      }
    }
  }
  return @($targets.Values)
}

# Staying alive and the bag: the Return to Arcadia button, the death window (while it's up) and how full
# the bag is (slots used of those unlocked, weight against the BagWeight stat, 73).
$BagWeightStat = 73
# A visible button somewhere under `control` whose label reads `text` (for buttons the game doesn't keep a field for).
function Find-Button($control, [string]$text, [int]$depth = 0) {
  if ($control.IsNull -or $depth -gt 6 -or -not $control.ReadField[bool]('_IsVisible')) { return $null }
  if ($control.Type.GetFieldByName('<Label>k__BackingField')) {
    $label = $control.ReadObjectField('<Label>k__BackingField')
    if (-not $label.IsNull -and $label.ReadStringField('_Text') -eq $text) { return Read-Button $control }
  }
  $kids = $control.ReadObjectField('<Controls>k__BackingField')
  if ($kids.IsNull) { return $null }
  $items = $kids.ReadObjectField('_items').AsArray()
  for ($i = 0; $i -lt $kids.ReadField[int]('_size'); $i++) {
    $found = Find-Button ($items.GetObjectValue($i)) $text ($depth + 1)
    if ($found) { return $found }
  }
  return $null
}
# Every monster the game knows of on the map, near or far (GameScene.DataDictionary: what the map's markers are drawn
# from, sub-bosses included wherever they are): which, where, its health, and whether it's dead.
function Read-Known($scene) {
  $out = @()
  $set = $scene.ReadObjectField('DataDictionary').ReadObjectField('_set')
  $stack = [System.Collections.Generic.Stack[object]]::new()
  $stack.Push($set.ReadObjectField('root'))
  while ($stack.Count -gt 0) {
    $node = $stack.Pop()
    if ($node.IsNull) { continue }
    $stack.Push($node.ReadObjectField('<Left>k__BackingField'))
    $stack.Push($node.ReadObjectField('<Right>k__BackingField'))
    $data = $node.ReadValueTypeField('<Item>k__BackingField').ReadObjectField('value')
    if ($data.IsNull) { continue }
    $info = $data.ReadObjectField('MonsterInfo')
    if ($info.IsNull -or $data.ReadStringField('PetOwner')) { continue }
    $at = $data.ReadValueTypeField('Location')
    $out += ,@{
      id = $data.ReadField[uint32]('ObjectID'); name = $info.ReadStringField('_MonsterName'); map = $data.ReadField[int]('MapIndex')
      x = $at.ReadField[int]('x'); y = $at.ReadField[int]('y'); hp = $data.ReadField[int]('Health'); maxHp = $data.ReadField[int]('MaxHealth'); dead = $data.ReadField[bool]('Dead')
    }
  }
  return $out
}
# The game's message boxes showing (a "sell these?" check, say): their text and buttons.
function Read-MessageBoxes($module, $domain) {
  $out = @()
  $list = $module.GetTypeByName('Client.Controls.DXControl').GetStaticFieldByName('MessageBoxList').ReadObject($domain)
  foreach ($box in (Read-List $list)) {
    if (-not $box.ReadField[bool]('_IsVisible')) { continue }
    $buttons = @()
    foreach ($f in $box.Type.Fields) {
      if ($f.Type.Name -ne 'Client.Controls.DXButton') { continue }
      $b = Read-Button ($box.ReadObjectField($f.Name))
      if ($b -and $b.enabled) { $b.name = $f.Name; $buttons += ,$b }
    }
    # Its text (DXMessageBox.Label is a property: the field behind it), and how long it ignores clicks once shown.
    $label = $box.ReadObjectField('<Label>k__BackingField')
    $out += ,@{ text = $(if ($label.IsNull) { '' } else { $label.ReadStringField('_Text') }); buttons = $buttons; cooldownMs = $(try { $box.ReadField[int]('ButtonCooldownMs') } catch { $null }) }
  }
  return $out
}
function Read-Survival($scene) {
  $out = @{}
  try { $out.arcadia = Read-Button ($scene.ReadObjectField('MainPanel').ReadObjectField('SanctuaryButton')) } catch {}
  # An NPC's dialog (what clicking an NPC opens), so a stray one can be closed.
  try { $npcBox = $scene.ReadObjectField('NPCBox'); $out.npcDialog = -not $npcBox.IsNull -and $npcBox.ReadField[bool]('_IsVisible') } catch {}
  try {
    # A shop's sell panel while it's open (Select All picks what can be sold from the open bag tab).
    $sell = $scene.ReadObjectField('NPCSellBox')
    if (-not $sell.IsNull -and $sell.ReadField[bool]('_IsVisible')) {
      $out.sell = @{ selectAll = (Find-Button $sell 'Select All'); sell = (Read-Button ($sell.ReadObjectField('SellButton'))); value = $sell.ReadObjectField('CurrencyLabel').ReadStringField('_Text') }
      $goods = $scene.ReadObjectField('NPCGoodsBox')
      try { if (-not $goods.IsNull) { $out.sell.close = Read-Button ($goods.ReadObjectField('CloseButton')) } } catch {}
    }
    $inventory = $scene.ReadObjectField('InventoryBox')
    if (-not $inventory.IsNull) { $out.inventory = @{ open = $inventory.ReadField[bool]('_IsVisible'); section = $inventory.ReadField[int]('_activeSection'); mainTab = (Read-Button ($inventory.ReadObjectField('MainTabButton'))) } }
  } catch {}
  try {
    # Talking to an NPC: the Talk / Quests menu some show first, and the quest list (Accept All, Hand In).
    $radial = $scene.ReadObjectField('NPCRadialMenuBox')
    if (-not $radial.IsNull -and $radial.ReadField[bool]('_IsVisible')) { $out.npcMenu = @{ quests = (Find-Button $radial 'Quests'); talk = (Find-Button $radial 'Talk'); waypoints = (Find-Button $radial 'Waypoints') } }
    $list = $scene.ReadObjectField('NPCQuestListBox')
    if (-not $list.IsNull -and $list.ReadField[bool]('_IsVisible')) {
      $info = $list.ReadObjectField('_NPCInfo')
      $out.questList = @{
        npc = $(if ($info.IsNull) { $null } else { $info.ReadField[int]('<Index>k__BackingField') })
        acceptAll = (Read-Button ($list.ReadObjectField('AcceptAllButton')))
        handIn = (Read-Button ($list.ReadObjectField('HandInAllButton')))
        quests = @(foreach ($q in (Read-List ($list.ReadObjectField('Quests')))) { $q.ReadStringField('_QuestName') })
      }
      # Its rows, to pick one quest at a time (some, as the Seasonal Supply Hunts, are left out of Accept All).
      $rows = @()
      $cells = $list.ReadObjectField('Rows')
      if (-not $cells.IsNull) {
        $cells = $cells.AsArray()
        for ($i = 0; $i -lt $cells.Length; $i++) {
          $row = $cells.GetObjectValue($i)
          if ($row.IsNull -or -not $row.ReadField[bool]('_IsVisible')) { continue }
          $info = $row.ReadObjectField('_QuestInfo')
          if ($info.IsNull) { continue }
          $box = Read-Box $row
          $box.name = $info.ReadStringField('_QuestName')
          $box.taken = -not $row.ReadObjectField('_UserQuest').IsNull
          $box.selected = $row.ReadField[bool]('_Selected')
          $rows += ,$box
        }
      }
      $out.questList.rows = $rows
    }
    # The chosen quest's window: Accept, and Complete to hand it in.
    $quest = $scene.ReadObjectField('NPCQuestBox')
    if (-not $quest.IsNull -and $quest.ReadField[bool]('_IsVisible')) {
      $chosen = $quest.ReadObjectField('_SelectedQuest')
      $info = if ($chosen.IsNull) { $null } else { $chosen.ReadObjectField('_QuestInfo') }
      $out.questBox = @{
        quest = $(if ($null -eq $info -or $info.IsNull) { $null } else { $info.ReadStringField('_QuestName') })
        accept = (Read-Button ($quest.ReadObjectField('AcceptButton')))
        complete = (Read-Button ($quest.ReadObjectField('CompleteButton')))
      }
    }
  } catch {}
  try {
    $death = $scene.ReadObjectField('DeathOptionsBox')
    if (-not $death.IsNull -and $death.ReadField[bool]('_IsVisible')) { $out.death = @{ returnButton = Read-Button ($death.ReadObjectField('_returnButton')) } }
  } catch {}
  try {
    $slots = $scene.ReadObjectField('Inventory').AsArray()
    $used = 0
    for ($i = 0; $i -lt $slots.Length; $i++) { if (-not $slots.GetObjectValue($i).IsNull) { $used++ } }
    $user = $scene.ReadObjectField('_User')
    $out.bag = @{ used = $used; slots = $scene.ReadObjectField('InventoryBox').ReadField[int]('_lastUnlockedSlots'); weight = $user.ReadField[int]('BagWeight'); maxWeight = (Read-Stat $user $BagWeightStat) }
  } catch {}
  return $out
}

# Gear: what's worn (by Library.EquipmentSlot) and the wearable items in the bag (by bag slot), each with its stats as
# rolled: the item's own (ItemInfo.Stats) and what it rolled on top (AddedStats), by Library.Stat number.
# Library.ItemType numbers of things that are worn: weapon, armour, torch, helmet, necklace, bracelet, ring, shoes,
# poison, amulet, emblem, shield, wings, belt.
$WearableTypes = @(2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 26, 27, 28, 30)
# Items the bag is counted for, by name (the Boss circuit's quest rewards).
$CountedItems = @('Forge Stone', 'Phoenix Tear')
function Read-EnumField($obj, [string]$name) {
  $field = $obj.Type.GetFieldByName($name)
  if (-not $field) { return $null }
  switch ($field.ElementType.ToString()) {
    'Int8' { return [int]$obj.ReadField[sbyte]($name) }
    'UInt8' { return [int]$obj.ReadField[byte]($name) }
    'Int16' { return [int]$obj.ReadField[int16]($name) }
    'UInt16' { return [int]$obj.ReadField[uint16]($name) }
    'Int64' { return $obj.ReadField[long]($name) }
    default { return $obj.ReadField[int]($name) }
  }
}
# Every value in a Stats (its SortedDictionary is a tree): stat number -> value.
function Read-AllStats($stats) {
  $out = @{}
  if ($stats.IsNull) { return $out }
  $stack = [System.Collections.Generic.Stack[object]]::new()
  $root = $stats.ReadObjectField('<Values>k__BackingField').ReadObjectField('_set').ReadObjectField('root')
  if (-not $root.IsNull) { $stack.Push($root) }
  while ($stack.Count -gt 0) {
    $node = $stack.Pop()
    $pair = $node.ReadValueTypeField('<Item>k__BackingField')
    $out["$($pair.ReadField[int]('key'))"] = $pair.ReadField[int]('value')
    foreach ($side in '<Left>k__BackingField', '<Right>k__BackingField') { $child = $node.ReadObjectField($side); if (-not $child.IsNull) { $stack.Push($child) } }
  }
  return $out
}
# The first of these fields the object has (names differ between versions of the game), or null.
function Find-FieldName($obj, [string[]]$names) {
  foreach ($name in $names) { if ($obj.Type.GetFieldByName($name)) { return $name } }
  return $null
}
# Items of a List<T>, an array, or a BindingList / Collection<T> (its inner list is `items`).
function Read-AnyList($list) {
  if ($list.IsNull) { return ,[System.Collections.Generic.List[object]]::new() }
  if (-not $list.IsArray -and -not $list.Type.GetFieldByName('_size') -and $list.Type.GetFieldByName('items')) { return Read-AnyList ($list.ReadObjectField('items')) }
  return Read-List $list
}
# The set an item is part of (its own rolled set, else its ItemInfo's): the set's name and each bonus with the pieces it
# needs worn (all of the set's pieces when the game doesn't say). Not every field name here is confirmed in game: those
# missing leave the set out.
function Read-ItemSet($item, $info) {
  $set = $null
  foreach ($pair in @(@($item, '<GeneratedSet>k__BackingField'), @($info, '_Set'))) {
    if (-not $pair[0].Type.GetFieldByName($pair[1])) { continue }
    $read = $pair[0].ReadObjectField($pair[1])
    if (-not $read.IsNull) { $set = $read; break }
  }
  if (-not $set) { return $null }
  $all = (Read-AnyList ($set.ReadObjectField('<Items>k__BackingField'))).Count
  $bonuses = @{}
  $add = { param([int]$pieces, $stat, [int]$amount) if (-not $stat -or -not $amount) { return }; if (-not $bonuses.ContainsKey("$pieces")) { $bonuses["$pieces"] = @{} }; $bonuses["$pieces"]["$stat"] = [int]$bonuses["$pieces"]["$stat"] + $amount }
  # Library.RequiredClass of the character (1 Warrior, 2 Wizard, 4 Taoist...): bonuses for other classes don't count.
  $mine = $script:classFlag
  $forMe = { param($entry) $c = Read-EnumField $entry '_RequiredClass'; if ($null -eq $c) { $c = Read-EnumField $entry '_Class' }; -not $c -or -not $mine -or ($c -band $mine) }
  # The full set's stats (SetInfoStat), and bonuses at a number of pieces (SetBonusInfo: stat bonuses only).
  foreach ($entry in (Read-AnyList ($set.ReadObjectField('<SetStats>k__BackingField')))) {
    if ($entry.IsNull -or -not (& $forMe $entry)) { continue }
    & $add $all (Read-EnumField $entry '_Stat') (Read-EnumField $entry '_Amount')
  }
  foreach ($entry in (Read-AnyList ($set.ReadObjectField('<Bonuses>k__BackingField')))) {
    if ($entry.IsNull -or -not (& $forMe $entry)) { continue }
    & $add (Read-EnumField $entry '_RequiredPieces') (Read-EnumField $entry '_Stat') (Read-EnumField $entry '_Amount')
  }
  return @{ name = $set.ReadStringField('_SetName'); pieces = $all; bonuses = @($bonuses.Keys | ForEach-Object { @{ pieces = [int]$_; stats = $bonuses[$_] } }) }
}
function Read-Item($item, [int]$slot) {
  $info = $item.ReadObjectField('Info')
  if ($info.IsNull) { return $null }
  $type = Read-EnumField $info '_ItemType'
  $rolled = Read-EnumField $item '<newRarity>k__BackingField'
  return @{
    slot = $slot; name = $info.ReadStringField('_ItemName'); type = $type
    # Its rarity as rolled (Library.Rarity: 0 Common .. 7 Set), else the item's own.
    rarity = $(if ($rolled) { $rolled } else { Read-EnumField $info '_Rarity' })
    lootLevel = $item.ReadField[int]('<LootLevel>k__BackingField')
    cls = Read-EnumField $info '_RequiredClass'; needs = Read-EnumField $info '_RequiredType'; needsAmount = $info.ReadField[int]('_RequiredAmount')
    flags = Read-EnumField $item '<Flags>k__BackingField'; canSell = $info.ReadField[bool]('_CanSell')
    durability = $item.ReadField[int]('<CurrentDurability>k__BackingField'); maxDurability = $item.ReadField[int]('<MaxDurability>k__BackingField')
    base = Read-AllStats ($info.ReadObjectField('Stats')); added = Read-AllStats ($item.ReadObjectField('<AddedStats>k__BackingField'))
    weight = $(try { $info.ReadField[int]('_Weight') } catch { $null })
    set = $(try { Read-ItemSet $item $info } catch { $null })
  }
}
function Read-Gear($scene) {
  # The character's class as a Library.RequiredClass flag, for set bonuses (Read-ItemSet).
  $script:classFlag = $(try { $c = [int]$scene.ReadObjectField('_User').ReadField[byte]('_Class'); if ($c -le 7) { 1 -shl $c } elseif ($c -eq 8) { 256 } else { 512 } } catch { 0 })
  $worn = @()
  $equipment = $scene.ReadObjectField('Equipment')
  if (-not $equipment.IsNull) {
    $slots = $equipment.AsArray()
    for ($i = 0; $i -lt $slots.Length; $i++) { $item = $slots.GetObjectValue($i); if (-not $item.IsNull) { $read = Read-Item $item $i; if ($read) { $worn += $read } } }
  }
  # With the bag open: each bag slot's cell on screen (cells showing only: the open tab, scrolled into view).
  $cells = @{}
  $box = $scene.ReadObjectField('InventoryBox')
  if (-not $box.IsNull -and $box.ReadField[bool]('_IsVisible')) {
    $grid = $box.ReadObjectField('Grid').ReadObjectField('Grid')
    if (-not $grid.IsNull) {
      $all = $grid.AsArray()
      for ($i = 0; $i -lt $all.Length; $i++) {
        $cell = $all.GetObjectValue($i)
        if ($cell.IsNull -or -not $cell.ReadField[bool]('_IsVisible')) { continue }
        $cells["$($cell.ReadField[int]('_Slot'))"] = Read-Box $cell
      }
    }
  }
  $bag = @()
  # How many of each CountedItems the bag holds (stacks added up).
  $counts = @{}
  foreach ($name in $CountedItems) { $counts[$name] = 0 }
  $inventory = $scene.ReadObjectField('Inventory')
  if (-not $inventory.IsNull) {
    $slots = $inventory.AsArray()
    for ($i = 0; $i -lt $slots.Length; $i++) {
      $item = $slots.GetObjectValue($i)
      if ($item.IsNull) { continue }
      $info = $item.ReadObjectField('Info')
      if ($info.IsNull) { continue }
      $itemName = $info.ReadStringField('_ItemName')
      # Consumables (potions, elixirs, scrolls) are counted too, whatever they are.
      if ($CountedItems -contains $itemName -or (Read-EnumField $info '_ItemType') -eq 1) { $counts[$itemName] = [long]$counts[$itemName] + $(try { $item.ReadField[long]('<Count>k__BackingField') } catch { 1 }) }
      if ($WearableTypes -notcontains (Read-EnumField $info '_ItemType')) { continue }
      $read = Read-Item $item $i
      if ($read) { if ($cells.ContainsKey("$i")) { $read.cell = $cells["$i"] }; $bag += $read }
    }
  }
  # How many columns the bag's grid has (its Main tab starts at bag slot 0, top left, row by row).
  $columns = $(try { $scene.ReadObjectField('InventoryBox').ReadObjectField('Grid').ReadValueTypeField('_GridSize').ReadField[int]('width') } catch { 0 })
  return @{ worn = $worn; bag = $bag; counts = $counts; columns = $columns }
}

# The bloodline (the game's Hermit system: points from levelling bought into stats): the points to spend, what's been
# bought (by Library.Stat number), and, once the Character window's Bloodline tab has been shown, the grade and each
# upgrade on offer with its button and hint (name, what it affects, its cost and what it gives, as the game words it).
function Read-Bloodline($scene) {
  $user = $scene.ReadObjectField('_User')
  if ($user.IsNull) { return $null }
  $out = @{ points = $user.ReadField[int]('HermitPoints'); bought = (Read-AllStats ($user.ReadObjectField('_HermitStats'))); options = @() }
  $box = $scene.ReadObjectField('CharacterBox')
  if ($box.IsNull) { return $out }
  $grade = $box.ReadObjectField('BloodlineGrade')
  if (-not $grade.IsNull) { $out.grade = $grade.ReadStringField('_Text') }
  $out.open = $box.ReadField[bool]('_IsVisible')
  foreach ($button in (Read-List ($box.ReadObjectField('bloodlineButtons')))) {
    if ($button.IsNull) { continue }
    $hint = $button.ReadStringField('_Hint')
    if (-not $hint) { continue }
    $option = @{ hint = $hint; enabled = $button.ReadField[bool]('_IsEnabled') }
    if ($out.open -and $button.ReadField[bool]('_IsVisible')) { $option.box = Read-Box $button }
    $out.options += ,$option
  }
  $use = $box.ReadObjectField('bloodlinePointsToUse')
  if (-not $use.IsNull -and $out.open -and $use.ReadField[bool]('_IsVisible')) { $out.pointsBox = Read-Box $use }
  return $out
}

# The game's own auto potion: each link's item (ItemInfo index), the HP and MP it's drunk below (0: not for that), and
# whether it's on. The game drinks these itself.
function Read-AutoPotion($scene) {
  $box = $scene.ReadObjectField('AutoPotionBox')
  if ($box.IsNull) { return $null }
  $links = $box.ReadObjectField('Links')
  if ($links.IsNull) { return $null }
  $out = @()
  $all = $links.AsArray()
  for ($i = 0; $i -lt $all.Length; $i++) {
    $l = $all.GetObjectValue($i)
    if ($l.IsNull) { continue }
    $item = $l.ReadField[int]('<LinkInfoIndex>k__BackingField')
    if ($item -le 0) { continue }
    $out += ,@{ item = $item; health = $l.ReadField[int]('<Health>k__BackingField'); mana = $l.ReadField[int]('<Mana>k__BackingField'); enabled = $l.ReadField[bool]('<Enabled>k__BackingField') }
  }
  return ,$out
}

# Profession levels (Library.ProfessionId: 1 Fishing, 2 Mining, 3 Harvesting, 4 Taming, 5 Cooking, 6 Crafting, 7 Farming).
# The client only loads them once the Professions window (Ctrl+Shift+P) has been opened: null until then.
function Read-Professions($scene) {
  $box = $scene.ReadObjectField('ProfessionsBox')
  if ($box.IsNull) { return $null }
  $snapshot = $box.ReadObjectField('_snapshot')
  if ($snapshot.IsNull) { return $null }
  $out = @()
  foreach ($p in (Read-List ($snapshot.ReadObjectField('<Professions>k__BackingField')))) {
    if ($p.IsNull) { continue }
    $out += @{
      id = [int]$p.ReadField[byte]('<Profession>k__BackingField'); name = $p.ReadStringField('<Name>k__BackingField')
      level = $p.ReadField[int]('<Level>k__BackingField'); usable = $p.ReadField[int]('<UsableLevel>k__BackingField')
      exp = $p.ReadField[long]('<LevelExperience>k__BackingField'); toNext = $p.ReadField[long]('<ExperienceToNextLevel>k__BackingField')
      canGain = $p.ReadField[bool]('<CanGainExperience>k__BackingField'); lockReason = $p.ReadStringField('<GainExperienceLockReason>k__BackingField')
    }
  }
  return ,$out
}

# Weight worn on the body and in hand (the user object's WearWeight and HandWeight, else the scene's), and the most of each.
function Read-Weights($userObject, $scene) {
  try {
    $worn = @{}
    foreach ($name in 'WearWeight', 'HandWeight') {
      $field = $null
      foreach ($obj in $userObject, $scene) { $f = Find-FieldName $obj @($name, "<$name>k__BackingField", "_$name"); if ($f) { $field = @($obj, $f); break } }
      if (-not $field) { return $null }
      $worn[$name] = $field[0].ReadField[int]($field[1])
    }
    return @{ wear = $worn.WearWeight; wearMax = (Read-Stat $userObject $WearWeightStat); hand = $worn.HandWeight; handMax = (Read-Stat $userObject $HandWeightStat) }
  } catch { return $null }
}

# Seconds since the player was last in combat (the game counts you out of combat 10 s after).
function Read-CombatAgo($userObject, $module, $domain) {
  $mask = [uint64]0x3FFFFFFFFFFFFFFF
  $combat = $userObject.ReadValueTypeField('CombatTime').ReadField[uint64]('_dateData') -band $mask
  $now = $module.GetTypeByName('Client.Envir.CEnvir').GetStaticFieldByName('Now').ReadStruct($domain).ReadField[uint64]('_dateData') -band $mask
  if ($combat -eq 0) { return 9999 }
  return [math]::Round(([double]$now - [double]$combat) / 1e7, 1)
}

# The map view: the game's size (Config.GameSize), its map zoom (Config.MapZoom), and how MapControl places the
# character's cell (its static OffSetX/OffSetY in cells and PixelOffsetX/PixelOffsetY): a bigger window shows more map.
function Read-View($scene, $module, $domain) {
  $config = $module.GetTypeByName('Client.Envir.Config')
  $size = $config.GetStaticFieldByName('<GameSize>k__BackingField').ReadStruct($domain)
  $map = $module.GetTypeByName('Client.Scenes.Views.MapControl')
  $int = { param($name) $map.GetStaticFieldByName($name).Read[int]($domain) }
  return @{
    width = $size.ReadField[int]('width'); height = $size.ReadField[int]('height')
    zoom = $config.GetStaticFieldByName('_MapZoom').Read[single]($domain); uiScale = $script:uiScale
    offsetX = (& $int 'OffSetX'); offsetY = (& $int 'OffSetY'); pixelX = (& $int 'PixelOffsetX'); pixelY = (& $int 'PixelOffsetY')
  }
}

# Objects further than this (in tiles, either way) from the player aren't sent, NPCs apart: on a crowded map (300 and more
# monsters) reading and sending them all made readings come too late. The screen shows about 27 either way at 2560x1440.
$ObjectRange = 40

$kinds = @{ 'Client.Models.MonsterObject' = 'monster'; 'Client.Models.ItemObject' = 'item'; 'Client.Models.PlayerObject' = 'player'; 'Client.Models.NPCObject' = 'npc'; 'Client.Models.GatheringNodeObject' = 'node' }

while ($true) {
  $game = Get-Process -Name Xtreme -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $game) {
    Write-State @{ inGame = $false; reason = 'Game not running' }
    Start-Sleep -Seconds 2
    continue
  }
  $target = $null
  try {
    $target = [Microsoft.Diagnostics.Runtime.DataTarget]::AttachToProcess($game.Id, $false)
    $runtime = $target.ClrVersions[0].CreateRuntime()
    $domain = $runtime.AppDomains[0]
    $module = $runtime.EnumerateModules() | Where-Object { $_.Name -like '*Xtreme.dll' } | Select-Object -First 1
    $script:cardsByImage = $null
    $script:wallsSent = $null
    $script:windowFields = $null
    $sceneField = $module.GetTypeByName('Client.Scenes.GameScene').GetStaticFieldByName('Game')
    $uiScaleField = $module.GetTypeByName('Client.Rendering.RenderingPipelineManager').GetStaticFieldByName('_displayScale')
    # Reads go straight to the game's live memory; attach afresh now and then all the same.
    $attachedAt = [Diagnostics.Stopwatch]::StartNew()
    while (-not $game.HasExited -and $attachedAt.Elapsed.TotalSeconds -lt 30) {
      $scene = $sceneField.ReadObject($domain)
      try { $k = $uiScaleField.Read[single]($domain); $script:uiScale = $(if ($k -gt 0) { [double]$k } else { 1.0 }) } catch { $script:uiScale = 1.0 }
      if ($scene.IsNull) {
        Write-State @{ inGame = $false; reason = 'Not in game' }
      } else {
        $list = $scene.ReadObjectField('MapControl').ReadObjectField('Objects')
        $size = $list.ReadField[int]('_size')
        $items = $list.ReadObjectField('_items').AsArray()
        $user = $null
        $objects = [System.Collections.Generic.List[object]]::new()
        # Where the player is, for leaving out what's far off.
        $me = $null
        try { $meObject = $scene.ReadObjectField('_User'); if (-not $meObject.IsNull) { $l = $meObject.ReadValueTypeField('_CurrentLocation'); $me = @($l.ReadField[int]('x'), $l.ReadField[int]('y')) } } catch {}
        for ($i = 0; $i -lt $size; $i++) {
          $o = $items.GetObjectValue($i)
          if ($o.IsNull) { continue }
          $location = $o.ReadValueTypeField('_CurrentLocation')
          $x = $location.ReadField[int]('x'); $y = $location.ReadField[int]('y')
          if ($me -and ([math]::Abs($x - $me[0]) -gt $ObjectRange -or [math]::Abs($y - $me[1]) -gt $ObjectRange) -and $o.Type.Name -ne 'Client.Models.NPCObject' -and $o.Type.Name -ne 'Client.Models.UserObject') { continue }
          $name = $o.ReadStringField('_Name')
          if ($o.Type.Name -eq 'Client.Models.UserObject') { $user = @{ name = $name; x = $x; y = $y; pickUpRadius = (Read-Stat $o $PickUpRadius); level = $o.ReadField[int]('_level'); class = [int]$o.ReadField[byte]('_Class'); mounted = $o.ReadField[byte]('horse') -ne 0; dead = $o.ReadField[bool]('_Dead'); experience = $(try { [double]$o.ReadField[decimal]('_Experience') } catch { $null }); maxExperience = $(try { [double]$o.ReadField[decimal]('_MaxExperience') } catch { $null }); hasMount = (Read-HasMount $scene); hp = $o.ReadField[int]('_CurrentHP'); maxHp = (Read-Stat $o $HealthStat); combat = $(try { $c = @{}; foreach ($k in $CombatStats.Keys) { $c[$k] = Read-Stat $o $CombatStats[$k] }; $c } catch { $null }); percents = $(try { $p = @{}; foreach ($n in $PercentStats) { $p["$n"] = Read-Stat $o $n }; $p } catch { $null }); weights = (Read-Weights $o $scene); combatAgo = $(try { Read-CombatAgo $o $module $domain } catch { $null }); mouseTile = $(try { $ml = $scene.ReadObjectField('MapControl').ReadValueTypeField('MapLocation'); @{ x = $ml.ReadField[int]('x'); y = $ml.ReadField[int]('y') } } catch { $null }) }; continue }
          $kind = $kinds[$o.Type.Name]
          if (-not $kind) { continue }
          $objects.Add(@{
            id = $o.ReadField[uint32]('ObjectID'); kind = $kind; name = $name; x = $x; y = $y
            dead = $o.ReadField[bool]('_Dead'); experience = $(try { [double]$o.ReadField[decimal]('_Experience') } catch { $null }); maxExperience = $(try { [double]$o.ReadField[decimal]('_MaxExperience') } catch { $null }); level = $o.ReadField[int]('<Level>k__BackingField')
            pet = [bool]$o.ReadStringField('_PetOwner')
            # Library.CombatTargetDisposition: 4 Hostile (can be attacked); guards and the like are something else.
            disposition = $(try { [int]$o.ReadField[byte]('<CombatDisposition>k__BackingField') } catch { $null })
          })
          if ($kind -eq 'monster') {
            # Health: the most it has (its Health stat), and the damage seen land on it, as 0 going negative (the client isn't told its real health).
            $monster = $objects[$objects.Count - 1]
            $monster.maxHp = $(try { Read-Stat $o $HealthStat } catch { $null })
            $monster.hp = $(try { $o.ReadField[int]('<CurrentHP>k__BackingField') } catch { $null })
          }
          if ($kind -eq 'node') {
            # Gathering nodes: which node it is (GatheringNodeInfo), plant (0) or ore (1), and whether it's been picked.
            $node = $objects[$objects.Count - 1]
            $node.node = $o.ReadField[int]('<NodeIndex>k__BackingField')
            $node.mining = $o.ReadField[int]('<Kind>k__BackingField') -eq 1
            $node.harvested = $o.ReadField[bool]('_harvested')
          }
        }
        $triad = $null
        try { $triad = Read-Triad $scene $module $domain } catch { $triad = @{ open = $true; error = $_.Exception.Message } }
        $collection = $null
        try { $collection = Read-Collection $scene $module $domain } catch { $collection = @{ error = $_.Exception.Message } }
        $map = $null
        try { $map = Read-Map $scene } catch { $script:wallsSent = $null }
        $waypoints = $null
        try { $waypoints = Read-Waypoints $scene } catch { $waypoints = @{ error = $_.Exception.Message } }
        $windows = $null
        try { $windows = Read-Windows $scene } catch { $script:windowFields = $null }
        # The quest log changes rarely: read it once a second.
        if (-not $script:questsAt -or $script:questsAt.ElapsedMilliseconds -gt 1000) {
          try { $script:questTargets = @(Read-QuestTargets $scene) } catch { $script:questTargets = $null; $script:questLog = $null }
          try { $script:professions = Read-Professions $scene } catch { $script:professions = $null }
          try { $script:gear = Read-Gear $scene } catch { $script:gear = $null }
          try { $script:bloodline = Read-Bloodline $scene } catch { $script:bloodline = $null }
          try { $script:autoPotion = Read-AutoPotion $scene } catch { $script:autoPotion = $null }
          try { $script:known = @(Read-Known $scene) } catch { $script:known = $null }
          $script:questsAt = [Diagnostics.Stopwatch]::StartNew()
        }
        $survival = $null
        try { $survival = Read-Survival $scene } catch {}
        if ($survival) { try { $survival.messages = @(Read-MessageBoxes $module $domain) } catch {} }
        Write-State @{ inGame = [bool]$user; user = $user; objects = $objects; triad = $triad; collection = $collection; map = $map; waypoints = $waypoints; windows = $windows; questTargets = $script:questTargets; questLog = $script:questLog; questPending = $script:questPending; view = $(try { Read-View $scene $module $domain } catch { $null }); professions = $script:professions; gear = $script:gear; bloodline = $script:bloodline; autoPotion = $script:autoPotion; known = $script:known; survival = $survival }
      }
      Start-Sleep -Milliseconds $IntervalMs
    }
  } catch {
    Write-State @{ inGame = $false; reason = "Reader error: $($_.Exception.Message)" }
    Start-Sleep -Seconds 2
  } finally {
    if ($target) { $target.Dispose() }
    # Hand back what the last attach used: hours of re-attaching otherwise let the reader grow to a gigabyte or more.
    [System.GC]::Collect()
  }
}
