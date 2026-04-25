$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appJsPath = Join-Path $projectRoot "app.js"
$launcherPath = Join-Path $projectRoot "XML_Editor.py"
$distDir = Join-Path $projectRoot "dist"
$releaseDir = Join-Path $projectRoot "release"
$separator = if ($IsWindows) { ";" } else { ":" }

function Get-PythonCommand {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($version in @("3.13", "3.12", "3.11", "3.10")) {
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      & py "-$version" -c "import sys; raise SystemExit(0 if sys.version_info < (3, 14) else 1)" *> $null
      $exitCode = $LASTEXITCODE
      $ErrorActionPreference = $previousErrorActionPreference
      if ($exitCode -eq 0) {
        return @("py", "-$version")
      }
    }
  }

  if (Get-Command python -ErrorAction SilentlyContinue) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    python -c "import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] < (3, 14) else 1)" *> $null
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    if ($exitCode -eq 0) {
      return @("python")
    }
  }

  throw "Python 3.10-3.13 was not found. Install a supported Python runtime first."
}

function Invoke-Python {
  param(
    [string[]]$PythonCommand,
    [string[]]$Arguments
  )

  $exe = $PythonCommand[0]
  $prefixArgs = @()
  if ($PythonCommand.Length -gt 1) {
    $prefixArgs = $PythonCommand[1..($PythonCommand.Length - 1)]
  }

  & $exe @($prefixArgs + $Arguments)
}

function Get-AppVersion {
  $content = Get-Content $appJsPath -Raw
  $match = [regex]::Match($content, "const APP_VERSION = '([^']+)'")
  if (-not $match.Success) {
    throw "Could not find APP_VERSION in app.js."
  }
  return $match.Groups[1].Value
}

$pythonCmd = Get-PythonCommand
$version = Get-AppVersion
$outputName = "XML_Editor_Desktop_$version.exe"
$distExePath = Join-Path $distDir "XML_Editor_Desktop.exe"

Write-Host "Building XML Editor Desktop $version"

try {
  Invoke-Python -PythonCommand $pythonCmd -Arguments @("-m", "PyInstaller", "--version") | Out-Null
} catch {
  throw "PyInstaller is not available. Install it with: py -3 -m pip install pyinstaller"
}

try {
  Invoke-Python -PythonCommand $pythonCmd -Arguments @("-c", "import webview") | Out-Null
} catch {
  throw "pywebview is not available. Install dependencies with a supported runtime, for example: py -3.13 -m pip install -r requirements.txt"
}

foreach ($path in @(
  (Join-Path $projectRoot "build"),
  $distDir,
  $releaseDir
)) {
  if (Test-Path $path) {
    Remove-Item -LiteralPath $path -Recurse -Force
  }
}

Invoke-Python -PythonCommand $pythonCmd -Arguments @(
  "-m", "PyInstaller",
  "--clean",
  "--noconfirm",
  "--onefile",
  "--windowed",
  "--name", "XML_Editor_Desktop",
  "--add-data", ("{0}{1}." -f (Join-Path $projectRoot "index.html"), $separator),
  "--add-data", ("{0}{1}." -f (Join-Path $projectRoot "app.js"), $separator),
  "--add-data", ("{0}{1}." -f (Join-Path $projectRoot "style.css"), $separator),
  $launcherPath
)

if (-not (Test-Path $distExePath)) {
  throw "PyInstaller completed without creating $distExePath"
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$releaseExePath = Join-Path $releaseDir $outputName
Copy-Item $distExePath $releaseExePath -Force

if (-not (Test-Path $releaseExePath)) {
  throw "Expected release executable was not created: $releaseExePath"
}

Write-Host "Created:" $releaseExePath
