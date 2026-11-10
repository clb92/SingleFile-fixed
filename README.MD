# SingleFile-fixed

A fork of [SingleFile](https://github.com/gildas-lormeau/SingleFile).

This fork attempts to fix auto-saved pages being missed or getting stuck in
"pending saves" when a page is left or its tab is closed before the save
has finished. The changes are on the `autosave-fix` branch (November 2026).
The patch was developed by Claude Fable 5.2.

This is not the official SingleFile extension. For documentation, releases and
support, see the original project.

## Description of the fix

SingleFile used to capture a page you left early only at the moment it unloaded, and on a closed tab Firefox often kills that capture half-way, or delivers it without tab info, which crashed the save. The fix makes the page send a snapshot to the extension’s background as soon as it is readable, refreshed a few times while it loads. If the page then vanishes without a finished save, the background saves the last snapshot itself.

Alongside that, three smaller repairs stop entries getting stuck in “pending saves”:

- Saves arriving from an already-closed tab no longer crash.
- The first save of each browser session is no longer mistaken for “no task”.
- Entries whose page has gone are cleaned up after 15 seconds.

## Building on Windows

Run `build.bat`, then load the resulting zip in Firefox from
`about:debugging` > This Firefox > Load Temporary Add-on.

## License

AGPL-3.0, same as the original. See [LICENSE](LICENSE).
