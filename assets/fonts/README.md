# Editor CJK fonts

The editor uses locally installed CJK fonts by default and calibrates their actual
advances to two cells of the selected Latin monospace face. No CJK font file is
bundled or downloaded. Settings → Appearance offers system font selection and
TTF, OTF, WOFF and WOFF2 import for UI, monospace and editor CJK fallback fonts.
Imported files are copied into managed application data and are not installed
into the operating system. Font files are not included in settings exports.

A machine with no suitable CJK font uses its WebView fallback. Glyph appearance
and coverage depend on the fonts installed or imported by the user.
