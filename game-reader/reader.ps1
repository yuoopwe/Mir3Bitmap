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

# A control's box on the game's screen.
function Read-Box($control) {
  $at = Read-ScreenLocation $control
  $size = $control.ReadValueTypeField('_Size')
  return @{ x = $at[0]; y = $at[1]; width = $size.ReadField[int]('width'); height = $size.ReadField[int]('height') }
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

# The map: its size, its walls (sent when the map changes, and again on each attach in case
# they were read while it was still loading) and its explored blocks (sent when they change).
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
    $script:exploredSent = $null
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
    # The log: each quest, whether it's been handed in, and whether every task is done (ready to hand in).
    $completed = $quest.ReadField[bool]('<Completed>k__BackingField')
    $ready = -not $completed
    foreach ($p in (Read-List ($quest.ReadObjectField('<Tasks>k__BackingField')))) {
      $t = $p.ReadObjectField('<Task>k__BackingField')
      $need = $p.ReadField[int]('<RequiredAmount>k__BackingField')
      if ($need -le 0 -and -not $t.IsNull) { $need = $t.ReadField[int]('_Amount') }
      if ($need -gt 0 -and $p.ReadField[long]('<Amount>k__BackingField') -lt $need) { $ready = $false }
    }
    $script:questLog += ,@{ name = $questName; completed = $completed; ready = $ready }
    if ($completed) { continue }
    $stage = $quest.ReadField[int]('<CurrentStage>k__BackingField')
    foreach ($progress in (Read-List ($quest.ReadObjectField('<Tasks>k__BackingField')))) {
      $task = $progress.ReadObjectField('<Task>k__BackingField')
      if ($task.IsNull) { continue }
      $kind = $task.ReadField[int]('_Task')
      # Some quests leave the per-character requirement at 0: the task's own amount is the target then.
      $required = $progress.ReadField[int]('<RequiredAmount>k__BackingField')
      if ($required -le 0) { $required = $task.ReadField[int]('_Amount') }
      if ($required -gt 0 -and $progress.ReadField[long]('<Amount>k__BackingField') -ge $required) { continue }
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
        if (-not $targets.ContainsKey($key)) { $targets[$key] = @{ name = $name; map = $mapIndex; quest = $questName } }
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
    $label = $box.ReadObjectField('Label')
    $out += ,@{ text = $(if ($label.IsNull) { '' } else { $label.ReadStringField('_Text') }); buttons = $buttons }
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
  }
}
function Read-Gear($scene) {
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
  $inventory = $scene.ReadObjectField('Inventory')
  if (-not $inventory.IsNull) {
    $slots = $inventory.AsArray()
    for ($i = 0; $i -lt $slots.Length; $i++) {
      $item = $slots.GetObjectValue($i)
      if ($item.IsNull) { continue }
      $info = $item.ReadObjectField('Info')
      if ($info.IsNull -or $WearableTypes -notcontains (Read-EnumField $info '_ItemType')) { continue }
      $read = Read-Item $item $i
      if ($read) { if ($cells.ContainsKey("$i")) { $read.cell = $cells["$i"] }; $bag += $read }
    }
  }
  return @{ worn = $worn; bag = $bag }
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

# Seconds since the player was last in combat (the game counts you out of combat 10 s after).
function Read-CombatAgo($userObject, $module, $domain) {
  $mask = [uint64]0x3FFFFFFFFFFFFFFF
  $combat = $userObject.ReadValueTypeField('CombatTime').ReadField[uint64]('_dateData') -band $mask
  $now = $module.GetTypeByName('Client.Envir.CEnvir').GetStaticFieldByName('Now').ReadStruct($domain).ReadField[uint64]('_dateData') -band $mask
  if ($combat -eq 0) { return 9999 }
  return [math]::Round(([double]$now - [double]$combat) / 1e7, 1)
}

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
    # Reads go straight to the game's live memory; attach afresh now and then all the same.
    $attachedAt = [Diagnostics.Stopwatch]::StartNew()
    while (-not $game.HasExited -and $attachedAt.Elapsed.TotalSeconds -lt 30) {
      $scene = $sceneField.ReadObject($domain)
      if ($scene.IsNull) {
        Write-State @{ inGame = $false; reason = 'Not in game' }
      } else {
        $list = $scene.ReadObjectField('MapControl').ReadObjectField('Objects')
        $size = $list.ReadField[int]('_size')
        $items = $list.ReadObjectField('_items').AsArray()
        $user = $null
        $objects = [System.Collections.Generic.List[object]]::new()
        for ($i = 0; $i -lt $size; $i++) {
          $o = $items.GetObjectValue($i)
          if ($o.IsNull) { continue }
          $location = $o.ReadValueTypeField('_CurrentLocation')
          $x = $location.ReadField[int]('x'); $y = $location.ReadField[int]('y')
          $name = $o.ReadStringField('_Name')
          if ($o.Type.Name -eq 'Client.Models.UserObject') { $user = @{ name = $name; x = $x; y = $y; pickUpRadius = (Read-Stat $o $PickUpRadius); level = $o.ReadField[int]('_level'); class = [int]$o.ReadField[byte]('_Class'); mounted = $o.ReadField[byte]('horse') -ne 0; dead = $o.ReadField[bool]('_Dead'); experience = $(try { [double]$o.ReadField[decimal]('_Experience') } catch { $null }); maxExperience = $(try { [double]$o.ReadField[decimal]('_MaxExperience') } catch { $null }); hasMount = (Read-HasMount $scene); hp = $o.ReadField[int]('_CurrentHP'); maxHp = (Read-Stat $o $HealthStat); combat = $(try { $c = @{}; foreach ($k in $CombatStats.Keys) { $c[$k] = Read-Stat $o $CombatStats[$k] }; $c } catch { $null }); combatAgo = $(try { Read-CombatAgo $o $module $domain } catch { $null }); mouseTile = $(try { $ml = $scene.ReadObjectField('MapControl').ReadValueTypeField('MapLocation'); @{ x = $ml.ReadField[int]('x'); y = $ml.ReadField[int]('y') } } catch { $null }) }; continue }
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
          $script:questsAt = [Diagnostics.Stopwatch]::StartNew()
        }
        $survival = $null
        try { $survival = Read-Survival $scene } catch {}
        if ($survival) { try { $survival.messages = @(Read-MessageBoxes $module $domain) } catch {} }
        Write-State @{ inGame = [bool]$user; user = $user; objects = $objects; triad = $triad; collection = $collection; map = $map; waypoints = $waypoints; windows = $windows; questTargets = $script:questTargets; questLog = $script:questLog; questPending = $script:questPending; professions = $script:professions; gear = $script:gear; survival = $survival }
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
