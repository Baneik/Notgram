# TDLib runtime

Run `npm run tdlib:fetch` from the repository root to download the pinned
Windows x64 runtime from the matching GitHub Release. The archive and each DLL
are checked against `scripts/tdlib/version.json` before this directory changes.
Run `npm run tdlib:build` instead to build the pinned official TDLib source and
populate this directory locally. Runtime files remain ignored by Git.

Expected JSON dynamic library names:

- Windows: `tdjson.dll`
- macOS: `libtdjson.dylib`
- Linux: `libtdjson.so`

You can instead set `NOTGRAM_TDLIB_PATH` to the dynamic library or its containing directory.

Windows builds also include the OpenSSL and zlib runtime DLLs required by
`tdjson.dll`. Dependency licenses are stored in `licenses/` and packaged with
the application. The pinned TDLib commit, vcpkg baseline, prebuilt archive, and
required runtime files are recorded in `scripts/tdlib/version.json`; verify a
populated runtime with `npm run verify:tdlib`.
