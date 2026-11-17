# Editor CJK font

`noto-cjk-editor.woff2` is a Unicode subset of **Noto Sans Mono CJK SC Regular**,
licensed under the [SIL Open Font License](OFL.txt). It supplies Han, kana and
fullwidth punctuation to the text editor without relying on platform CJK fonts.
The editor scales its 1em advances to two cells of the selected Latin mono face.
Latin text continues to use the appearance setting.

Source: [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk),
`Sans/Mono/NotoSansMonoCJKsc-Regular.otf`, Git blob
`5ff7011ee3c76bb800e3c7ed0ed496427c3477de` (16,393,784 bytes).

Reproduce with `fonttools[woff]==4.60.2` and `brotli==1.2.1`:

```sh
pyftsubset NotoSansMonoCJKsc-Regular.otf \
  --unicodes='U+2E80-9FFF,U+F900-FAFF,U+FE10-FE1F,U+FE30-FE4F,U+FF01-FF60,U+FFE0-FFE6,U+20000-323AF' \
  --flavor=woff2 --output-file=noto-cjk-editor.woff2 \
  --layout-features='*' --name-IDs='*' --name-languages='*'
```
