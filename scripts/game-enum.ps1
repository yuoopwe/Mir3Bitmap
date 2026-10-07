# Lists a game enum's names and numbers, from the game's LibraryCore.dll (the game must be running). Example: pwsh scripts/game-enum.ps1 -Name Library.Stat
param([string]$Name)
$exe = (Get-Process -Name Xtreme | Select-Object -First 1).Path
$asm = [System.Reflection.Assembly]::LoadFile((Join-Path (Split-Path $exe) 'LibraryCore.dll'))
$t = $asm.GetType($Name)
foreach ($n in [Enum]::GetNames($t)) { "$n = $([long][Enum]::Parse($t, $n).value__)" }
