# Release versioning

`version.json` is the only manually edited application version. After changing
it, synchronize the generated manifest values:

```powershell
npm run version:sync
```

This updates `package.json`, `package-lock.json`, the Cargo package and lockfile,
and the Tauri bundle. `npm run check` rejects version drift through
`npm run version:check`.

Release tags are annotated tags named exactly `v<version>`. Create a tag only
from a clean commit after the release workflow passes and a matching heading is
present in `CHANGELOG.md`:

```powershell
$version = (Get-Content version.json -Raw | ConvertFrom-Json).version
git tag -a "v$version" -m "Notgram $version"
git push origin "v$version"
```

Stable releases use `MAJOR.MINOR.PATCH`; candidates use a SemVer prerelease such
as `0.5.0-rc.1`. Never move or replace a published tag. Publish a new patch or
prerelease when a release must be superseded.

The `Windows release` workflow requires repository secrets
`NOTGRAM_WINDOWS_CERTIFICATE_BASE64`, `NOTGRAM_WINDOWS_CERTIFICATE_PASSWORD`,
`NOTGRAM_API_ID`, and `NOTGRAM_API_HASH`. Manual runs produce retained workflow
artifacts; matching `v<version>` tag runs also create the GitHub release. Missing
signing inputs fail before a release build starts.
