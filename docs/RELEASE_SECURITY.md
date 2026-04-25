# Release Security

## Goal

Every Windows release artifact should be built reproducibly in GitHub Actions, signed with a trusted Microsoft-backed Authenticode signature, timestamped, verified, hashed, and then published to GitHub Releases.

This improves trust for every current and future EXE. It does not promise that Microsoft Defender SmartScreen will never warn on a new release. For software distributed outside the Microsoft Store, SmartScreen still evaluates reputation for each new file hash.

## Microsoft Rules That Matter

Microsoft's current guidance for off-Store Windows apps is:

- unsigned EXE files receive the strongest SmartScreen treatment
- signed files show a verified publisher and are treated better than unsigned files
- SmartScreen reputation is file-hash based, so each new build starts with little or no file reputation
- EV certificates no longer provide immediate SmartScreen bypass for first downloads
- Microsoft Store distribution is the only Microsoft-documented route that avoids SmartScreen download warnings by default
- Microsoft Trusted Signing is the recommended Microsoft signing service for non-Store distribution

Sources:

- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://github.com/marketplace/actions/trusted-signing

## Implemented Release Path

The repository includes `.github/workflows/signed-release.yml`.

For every `v*` tag, or for a manually dispatched existing tag, the workflow:

1. checks out the release source
2. installs Python 3.13 dependencies
3. builds `XML_Editor_Desktop_<version>.exe`
4. signs the EXE with Microsoft Trusted Signing
5. verifies the Authenticode signature
6. writes `SHA256SUMS.txt`
7. creates or updates the GitHub release
8. uploads the signed EXE and hash file

The helper script `scripts/verify-release.ps1` verifies a local release asset's Authenticode signature and SHA256 hash.

## Required One-Time Microsoft Setup

The workflow cannot sign until a Microsoft Trusted Signing account and certificate profile exist.

Required GitHub repository secrets:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `TRUSTED_SIGNING_ENDPOINT`
- `TRUSTED_SIGNING_ACCOUNT_NAME`
- `TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`

The Azure identity must have the Trusted Signing Certificate Profile Signer role for the certificate profile.

## Current Releases

Existing unsigned assets such as `v0.9.0` and `v0.9.1` should be replaced by running the `Signed Release` workflow manually for each tag after signing is configured. The workflow uses `gh release upload --clobber`, so the release asset will be replaced by a signed binary with the same name.

## Future Releases

Future releases should be created by pushing a `vX.Y.Z` tag and allowing the `Signed Release` workflow to publish the release asset. Avoid manually uploading unsigned EXE files to GitHub Releases.

## Remaining Reality

Code signing is necessary, but Microsoft does not guarantee immediate no-warning SmartScreen behavior for every new off-Store file. If zero-warning first-run distribution is mandatory, publish through the Microsoft Store.
