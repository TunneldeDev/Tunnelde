# Settings, theme coverage and terminal remainder review (0.21.1)

The main background now defines the global surface palette as well as workspace backgrounds.
Dropdown portals, dialogs, context menus and other root-level controls inherit coherent elevated
surfaces, borders, hover colors and native color schemes. Overrides limited to one region keep
their scope. Root aliases still isolate nested regions, and generated preferences stay before
user CSS. Preview cancellation and preference resets restore the original palette.

The terminal grid only occupies whole character rows. xterm's remaining viewport pixels used
its default black background; making that layer transparent reveals the configured host
background in both WebGL and DOM modes. The change applies to previews and connected terminal
hosts without changing row fitting, scrolling or the renderer lifecycle.

Appearance, Workspace, Terminal and Files now organize related preferences into inline groups.
Indented category navigation jumps to those groups within the current settings page. Files
separates Browsing, Sorting and Preloading, keeping the preload switch and dependent count
together. Group names participate in bilingual search. Category/filter changes scroll back to
the top. Narrow layouts retain inline groups while hiding nested navigation in the horizontal
category strip. Theme customization adds indentation, guide lines and differentiated headings
for the theme preference, customization disclosure, region groups and individual colors.

## Validation

- TypeScript, ESLint and all 531 frontend tests passed. Three new regressions cover global
  palette preview/reset, same-page group navigation/category scrolling and bilingual group search.
- All 793 translation keys match between English and Chinese. Version manifests match 0.21.1.
- Changed frontend, JSON and documentation files pass Prettier. Repository-wide formatting
  still reports seven pre-existing warnings in unchanged files, including the lockfile.
- A development frontend in the isolated WebView passed 24 layout and palette checks.
- The embedded production frontend in a separate Windows application passed 44 native checks:
  saved application of seven built-in and two plugin themes; dropdown and dialog colors for
  all nine themes; both terminal renderers with graphite, white, black and gray backgrounds;
  preloading enable/count dependency; inline navigation; category scroll reset; customization
  hierarchy; and 800/1100/1600 px viewport overflow checks.
- Screenshots and result records are in `.tmp/qa/0211/`, including `native-results.json`,
  `native-graphite-dropdown.png`, `native-terminal.png`, `native-files.png` and
  `native-hierarchy.png`. The final QA instance closed normally.

The QA application used separate data, plugins and WebView directories. It did not replace or
close the installed application, access the clipboard or connect to a remote server. Native
macOS/Linux interactions were not manually tested on this Windows machine; platform compilation
and packaging are checked by CI and the release workflow.
