# Downloads the libraries game-reader/reader.ps1 needs (Microsoft's ClrMD and what it loads) into game-reader/lib.
# Run once: pwsh -File scripts/setup-game-reader.ps1
$ErrorActionPreference = 'Stop'
$lib = Join-Path $PSScriptRoot '..\game-reader\lib'
$temp = Join-Path ([IO.Path]::GetTempPath()) 'bitmat-game-reader'
New-Item -ItemType Directory -Force $lib, $temp | Out-Null
$packages = @(
  @('Microsoft.Diagnostics.Runtime', '4.1.745802'),
  @('Microsoft.Diagnostics.NETCore.Client', '0.2.661903'),
  @('Azure.Core', '1.53.0'),
  @('Azure.Identity', '1.21.0'),
  @('System.ClientModel', '1.10.0')
)
foreach ($p in $packages) {
  $id = $p[0].ToLower(); $version = $p[1]
  $zip = Join-Path $temp "$id.$version.zip"
  Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/$id/$version/$id.$version.nupkg" -OutFile $zip
  $out = Join-Path $temp $id
  Expand-Archive $zip $out -Force
  foreach ($tfm in 'net10.0', 'net9.0', 'net8.0', 'netstandard2.0') {
    $dir = Join-Path $out "lib\$tfm"
    if (Test-Path $dir) {
      Copy-Item (Join-Path $dir '*.dll') $lib -Force
      Write-Host "$($p[0]) $version ($tfm)"
      break
    }
  }
}
Write-Host "Libraries are in $((Resolve-Path $lib).Path)"
