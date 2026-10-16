// Compiles the memory reader's C# (game-reader/*.cs) as C# 10 against the ClrMD in game-reader/lib, to catch a
// mistake before it reaches the game (reader.ps1 compiles the same files with Add-Type when the bot starts). Needs the
// .NET SDK (a developer tool: players don't need it) and scripts/setup-game-reader.ps1 run once.
// Usage: node scripts/check-game-reader.js
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reader = path.join(__dirname, '..', 'game-reader');
const clrmd = path.join(reader, 'lib', 'Microsoft.Diagnostics.Runtime.dll');
if (!fs.existsSync(clrmd)) {
  console.error(`No ${clrmd}: run scripts/setup-game-reader.ps1 first.`);
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitmat-reader-check-'));
fs.writeFileSync(path.join(dir, 'Check.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
    <LangVersion>10</LangVersion>
    <Nullable>disable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <MSBuildWarningsAsMessages>MSB3277</MSBuildWarningsAsMessages>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${path.join(reader, '*.cs')}" />
    <Reference Include="Microsoft.Diagnostics.Runtime"><HintPath>${clrmd}</HintPath></Reference>
  </ItemGroup>
</Project>
`);
const build = spawnSync('dotnet', ['build', '-nologo', '-v', 'q', dir], { stdio: 'inherit' });
fs.rmSync(dir, { recursive: true, force: true });
if (build.error) console.error(`Couldn't run dotnet (is the .NET SDK installed?): ${build.error.message}`);
process.exit(build.status ?? 1);
