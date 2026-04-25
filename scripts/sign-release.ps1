param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [string]$CertificateThumbprint = "",

  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

function Find-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (-not (Test-Path $kitsRoot)) {
    throw "signtool.exe was not found. Install the Windows SDK, or add signtool.exe to PATH."
  }

  $candidate = Get-ChildItem -LiteralPath $kitsRoot -Recurse -Filter signtool.exe |
    Where-Object { $_.FullName -like "*\x64\signtool.exe" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if (-not $candidate) {
    throw "signtool.exe was not found in the Windows SDK."
  }

  return $candidate.FullName
}

$resolvedPath = Resolve-Path -LiteralPath $Path
$signtool = Find-SignTool

$signArgs = @(
  "sign",
  "/fd", "SHA256",
  "/tr", $TimestampUrl,
  "/td", "SHA256",
  "/v"
)

if ($CertificateThumbprint.Trim()) {
  $signArgs += @("/sha1", $CertificateThumbprint.Trim())
} else {
  $signArgs += @("/a")
}

$signArgs += $resolvedPath.Path

& $signtool @signArgs
if ($LASTEXITCODE -ne 0) {
  throw "signtool sign failed with exit code $LASTEXITCODE."
}

& $signtool verify /pa /v $resolvedPath.Path
if ($LASTEXITCODE -ne 0) {
  throw "signtool verify failed with exit code $LASTEXITCODE."
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
if ($signature.Status -ne "Valid") {
  throw "Authenticode signature is not valid: $($signature.Status)."
}

$hash = Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256
[pscustomobject]@{
  Path = $resolvedPath.Path
  SignatureStatus = $signature.Status
  Signer = $signature.SignerCertificate.Subject
  TimestampSigner = $signature.TimeStamperCertificate.Subject
  SHA256 = $hash.Hash
} | Format-List
