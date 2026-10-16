# Reads what's around the player straight from the running game's memory (read-only, using Microsoft's ClrMD) and
# prints it as one JSON line a tick (one every 50 ms, start to start), for the bot to use instead of reading the screen.
# The reading itself is C# (the .cs files here: Reader.cs is where it starts), compiled once and kept in the temp
# folder until those files or ClrMD change: reading field by field from PowerShell made every read slow.
# reader-legacy.ps1 is the old all-PowerShell reader (BITMAT_LEGACY_READER=1 runs it instead), and stays the
# specification of every key the reading has.
# Needs the libraries in .\lib (scripts/setup-game-reader.ps1 downloads them). Runs until the bot (-ParentPid) is gone,
# so a bot that was closed or killed never leaves it reading the game in the background.
param([int]$IntervalMs = 50, [int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
$lib = Join-Path $PSScriptRoot 'lib'
# ClrMD's helpers (Azure.Core is only used for symbol downloads, but has to load).
Get-ChildItem $lib -Filter *.dll | Where-Object { $_.Name -ne 'Microsoft.Diagnostics.Runtime.dll' } | ForEach-Object { try { Add-Type -Path $_.FullName } catch {} }
$clrmd = Join-Path $lib 'Microsoft.Diagnostics.Runtime.dll'
Add-Type -Path $clrmd

# The compiled reader, by a hash of its sources, the ClrMD it's built against and this PowerShell (its .NET).
$sources = @(Get-ChildItem $PSScriptRoot -Filter *.cs | Sort-Object Name)
$hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
foreach ($source in $sources) {
  $hash.AppendData([Text.Encoding]::UTF8.GetBytes($source.Name))
  $hash.AppendData([IO.File]::ReadAllBytes($source.FullName))
}
$hash.AppendData([Text.Encoding]::UTF8.GetBytes("$([Reflection.AssemblyName]::GetAssemblyName($clrmd).Version)/$((Get-Item $clrmd).Length)/$($PSVersionTable.PSVersion)"))
$key = [Convert]::ToHexString($hash.GetHashAndReset()).Substring(0, 16).ToLowerInvariant()
$folder = Join-Path ([IO.Path]::GetTempPath()) "bitmat-game-reader/$key"
$dll = Join-Path $folder 'GameReader.dll'
if (-not (Test-Path $dll)) {
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  # Built under a name of its own and then moved into place, so a reader starting meanwhile never loads half a file.
  # (Add-Type leaves an empty file behind when compiling fails, and won't write over one.)
  $building = Join-Path $folder "GameReader.$PID.dll"
  Remove-Item -Path $building -ErrorAction SilentlyContinue
  # Add-Type references only the core of .NET unless told: the rest the reader uses is named here.
  $references = @($clrmd, 'System.Collections', 'System.Collections.Immutable', 'System.ComponentModel.Primitives', 'System.Console', 'System.Diagnostics.Process',
    'System.Linq', 'System.Memory', 'System.Text.Encodings.Web', 'System.Text.Json', 'System.Threading', 'System.Threading.Thread')
  Add-Type -Path ($sources | ForEach-Object { $_.FullName }) -ReferencedAssemblies $references -OutputAssembly $building -OutputType Library
  try { Move-Item -Path $building -Destination $dll -Force } catch { if (-not (Test-Path $dll)) { throw } }
  Remove-Item -Path $building -ErrorAction SilentlyContinue
}
Add-Type -Path $dll
[Bitmat.GameReader.Reader]::Run($IntervalMs, $ParentPid)
