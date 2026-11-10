# SingleFile-fixed

A fork of [SingleFile](https://github.com/gildas-lormeau/SingleFile).

This fork attempts to fix auto-saved pages being missed or getting stuck in
"pending saves" when a page is left or its tab is closed before the save
has finished. The changes are on the `autosave-fix` branch (November 2026).

This is not the official SingleFile extension. For documentation, releases and
support, see the original project.

## Building on Windows

Run `build.bat`, then load the resulting zip in Firefox from
`about:debugging` > This Firefox > Load Temporary Add-on.

## License

AGPL-3.0, same as the original. See [LICENSE](LICENSE).
