# Release Security

## Goal

Every public Windows release artifact should be signed with a trusted Authenticode signature, timestamped, verified, hashed, and then published to GitHub Releases.

This improves trust for every current and future EXE. It does not promise that Microsoft Defender SmartScreen will never warn on a new release. For software distributed outside the Microsoft Store, SmartScreen still evaluates reputation for each new file hash.

## Microsoft Rules That Matter

Microsoft's current guidance for off-Store Windows apps is:

- unsigned EXE files receive the strongest SmartScreen treatment
- signed files show a verified publisher and are treated better than unsigned files
- SmartScreen reputation is file-hash based, so each new build starts with little or no file reputation
- EV certificates no longer provide immediate SmartScreen bypass for first downloads
- Microsoft Store distribution is the only Microsoft-documented route that avoids SmartScreen download warnings by default
- Microsoft Artifact Signing, formerly Trusted Signing, is Microsoft's recommended signing service for non-Store distribution, but it requires an Azure account

Sources:

- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://github.com/Azure/artifact-signing-action

## Non-Azure Path

If Azure is not acceptable, use a public-trust code-signing certificate from a traditional Certificate Authority such as DigiCert, Sectigo, GlobalSign, SSL.com, or another CA in the Microsoft Trusted Root Program.

Modern public code-signing certificates normally keep the private key in protected hardware or a managed cloud signing service. That is a security requirement, not a repo setting. The exact signing method depends on the CA.

The repository includes:

- `scripts/sign-release.ps1`: signs a local EXE with `signtool.exe`
- `scripts/verify-release.ps1`: verifies a local EXE signature and SHA256 hash

Typical local flow:

```powershell
.\build_exe.ps1
.\scripts\sign-release.ps1 -Path .\release\XML_Editor_Desktop_vX.Y.Z.exe
.\scripts\verify-release.ps1 -Path .\release\XML_Editor_Desktop_vX.Y.Z.exe
gh release upload vX.Y.Z .\release\XML_Editor_Desktop_vX.Y.Z.exe --clobber
```

If more than one signing certificate is available, pass the certificate thumbprint:

```powershell
.\scripts\sign-release.ps1 -Path .\release\XML_Editor_Desktop_vX.Y.Z.exe -CertificateThumbprint "<thumbprint>"
```

## Optional Azure Path

The repository also includes `.github/workflows/signed-release.yml`, which supports Microsoft Artifact Signing with GitHub OIDC. This path is inactive unless the required Azure-backed signing secrets are configured.

Required GitHub environment: `release-signing`

Required secrets:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `TRUSTED_SIGNING_ENDPOINT`
- `TRUSTED_SIGNING_ACCOUNT_NAME`
- `TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`

This path is kept as an option, but it is not required if the project chooses a non-Azure CA certificate.

## Version And Release Policy

- Major/minor milestones are published as GitHub Releases, for example `v1.0.0`, `v1.1.0`, or `v2.0.0`.
- Patch versions are pushed as Git tags only, for example `v1.0.1`.
- Patch tags should not publish GitHub Release assets.
- The optional Azure signing workflow is manual-only so a patch tag cannot accidentally create a release.

## Current Releases

Existing pre-1.0 unsigned assets remain available for traceability and are marked superseded. New public downloads should start at `v1.0.0` or later.

## Future Releases

Future major/minor releases should not publish unsigned EXE files for public users when a signing path is available. Build, sign, verify, hash, then upload. Patch versions should be tags only.

## Remaining Reality

Code signing is necessary, but Microsoft does not guarantee immediate no-warning SmartScreen behavior for every new off-Store file. If zero-warning first-download distribution is mandatory, publish through the Microsoft Store.
