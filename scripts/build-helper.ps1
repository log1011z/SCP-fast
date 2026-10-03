$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $projectRoot 'bin'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) {
    throw '.NET Framework 4.x C# compiler not found. Build this helper on Windows with .NET Framework installed.'
}
$sourcePath = Join-Path $projectRoot 'native\AskPass.cs'
$outputPath = Join-Path $outputDir 'scp-fast-askpass.exe'
& $compilerPath /nologo /target:exe /optimize+ /platform:anycpu "/out:$outputPath" /reference:System.Web.Extensions.dll $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'Askpass helper compilation failed.' }
