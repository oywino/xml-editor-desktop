param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"

$resolvedPath = Resolve-Path -LiteralPath $Path
$signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
$hash = Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256

[pscustomobject]@{
  Path = $resolvedPath.Path
  SignatureStatus = $signature.Status
  Signer = $signature.SignerCertificate.Subject
  TimestampSigner = $signature.TimeStamperCertificate.Subject
  SHA256 = $hash.Hash
} | Format-List

if ($signature.Status -ne "Valid") {
  throw "Signature is not valid: $($signature.Status)"
}
