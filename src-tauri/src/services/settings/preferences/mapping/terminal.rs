//! Explicit public field to private preference mapping.
pub(super) const FIELDS: &[(&str, &str)] = &[
    ("scrollback", "terminalScrollback"),
    ("lineHeight", "terminalLineHeight"),
    ("cursorStyle", "terminalCursorStyle"),
    ("cursorBlink", "terminalCursorBlink"),
    ("inactiveCursorStyle", "terminalInactiveCursorStyle"),
    ("scrollSensitivity", "terminalScrollSensitivity"),
    ("smoothScrolling", "terminalSmoothScrolling"),
    ("scrollOnInput", "terminalScrollOnInput"),
    ("copyOnSelect", "terminalCopyOnSelect"),
    ("applicationClipboard", "terminalApplicationClipboard"),
    ("rightClick", "terminalRightClick"),
    ("renderer", "terminalRenderer"),
    ("recordHistory", "recordTerminalHistory"),
];
