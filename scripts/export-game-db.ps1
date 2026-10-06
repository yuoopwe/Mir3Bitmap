# Exports every table of the game's database to JSON Lines (_work/gamedb/export/*.jsonl), using the game's
# own LibraryCore.dll to decrypt and read it. Works on a copy: the game's files are never touched.
# Run: pwsh -File scripts/export-game-db.ps1 [game folder]; then node scripts/game-data.js for the summaries.
param([string]$root = 'E:\Games\Mir3 Servers\Mir 3 - Xtreme Edition (All in One)')
$ErrorActionPreference = 'Stop'
$work = Join-Path $PSScriptRoot '..\_work\gamedb'
New-Item -ItemType Directory -Force $work | Out-Null
$work = (Resolve-Path $work).Path
Copy-Item (Join-Path $root 'Data\System.db') (Join-Path $work 'System.db') -Force
Copy-Item (Join-Path $root 'LibraryCore.key') (Join-Path $work 'LibraryCore.key') -Force

# The game's code looks for LibraryCore.key in the current folder.
Set-Location $work
[Environment]::CurrentDirectory = $work
$asm = [System.Reflection.Assembly]::LoadFrom((Join-Path $root 'LibraryCore.dll'))
$sessionType = $asm.GetType('MirDB.Session')
$dbObjectType = $asm.GetType('MirDB.DBObject')
$mode = [Enum]::Parse($asm.GetType('MirDB.SessionMode'), 'System')
$session = [Activator]::CreateInstance($sessionType, @($mode, "$work\", "$work\Backup\"))
$session.BackUp = $false
$session.Initialize([System.Reflection.Assembly[]]@($asm))
$collections = $sessionType.GetField('Collections', [System.Reflection.BindingFlags]'NonPublic,Instance').GetValue($session)

$out = Join-Path $work 'export'
New-Item -ItemType Directory -Force $out | Out-Null

# A referenced record is written as { Index, Name }, with the first of these that it has as its name.
$nameProps = 'MonsterName', 'ItemName', 'QuestName', 'DisplayName', 'NPCName', 'Name', 'Title', 'Description', 'FileName', 'RegionName', 'Identity'
$propCache = @{}
function Get-Props([Type]$t) {
  if (-not $propCache.ContainsKey($t)) {
    $propCache[$t] = @($t.GetProperties([System.Reflection.BindingFlags]'Public,Instance') | Where-Object {
      $_.CanRead -and $_.GetIndexParameters().Count -eq 0 -and $_.DeclaringType -ne $dbObjectType -and $_.DeclaringType.Namespace -notlike 'MirDB*'
    })
  }
  $propCache[$t]
}
function Get-Name($o) {
  foreach ($n in $nameProps) {
    $p = $o.GetType().GetProperty($n)
    if ($p -and $p.PropertyType -eq [string]) {
      $v = $p.GetValue($o)
      if ($v) { return $v }
    }
  }
  $null
}
# Plain values, enums as text and references to other records; lists and bulky internals are left out.
function Convert-Row($o) {
  $row = [ordered]@{ Index = $o.Index }
  foreach ($p in (Get-Props $o.GetType())) {
    try { $v = $p.GetValue($o) } catch { continue }
    if ($null -eq $v) { continue }
    $t = $p.PropertyType
    if ($t.IsPrimitive -or $t -eq [string] -or $t -eq [decimal]) {
      if ($v -is [string] -and $v.Length -eq 0) { continue }
      $row[$p.Name] = $v
    } elseif ($t.IsEnum) {
      $row[$p.Name] = $v.ToString()
    } elseif ($dbObjectType.IsAssignableFrom($t)) {
      $row[$p.Name] = [ordered]@{ Index = $v.Index; Name = (Get-Name $v) }
    }
  }
  $row
}

$options = [System.Text.Json.JsonSerializerOptions]::new()
$options.Encoder = [System.Text.Encodings.Web.JavaScriptEncoder]::UnsafeRelaxedJsonEscaping
$tables = 0
foreach ($kv in $collections.GetEnumerator()) {
  $items = $kv.Value.Binding
  if ($null -eq $items) { continue }
  $writer = [System.IO.StreamWriter]::new((Join-Path $out "$($kv.Key.Name).jsonl"), $false, [System.Text.UTF8Encoding]::new($false))
  foreach ($o in $items) { $writer.WriteLine([System.Text.Json.JsonSerializer]::Serialize((Convert-Row $o), $options)) }
  $writer.Dispose()
  $tables++
}
Write-Host "Exported $tables tables to $out"
