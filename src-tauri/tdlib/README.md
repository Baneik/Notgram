# TDLib runtime

Run `powershell -ExecutionPolicy Bypass -File scripts/build-tdlib.ps1` from the
repository root to build the pinned official TDLib source and populate this
directory. The runtime files are intentionally ignored by Git.

Expected JSON dynamic library names:

- Windows: `tdjson.dll`
- macOS: `libtdjson.dylib`
- Linux: `libtdjson.so`

You can instead set `NOTGRAM_TDLIB_PATH` to the dynamic library or its containing directory.

Windows builds also include the OpenSSL and zlib runtime DLLs required by
`tdjson.dll`. Dependency licenses are stored in `licenses/` and packaged with
the application.
