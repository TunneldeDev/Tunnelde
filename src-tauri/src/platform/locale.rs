// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

/// Read UI language preferences from the OS, independently of the WebView locale.
#[cfg(target_os = "windows")]
pub fn preferred_languages() -> Vec<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserPreferredUILanguages(
            flags: u32,
            count: *mut u32,
            buffer: *mut u16,
            size: *mut u32,
        ) -> i32;
    }
    let mut count = 0;
    let mut size = 0;
    // MUI_LANGUAGE_NAME returns a double-null-terminated list of BCP-47 names.
    unsafe {
        if GetUserPreferredUILanguages(8, &mut count, std::ptr::null_mut(), &mut size) == 0
            || size == 0
        {
            return Vec::new();
        }
        let mut buffer = vec![0u16; size as usize];
        if GetUserPreferredUILanguages(8, &mut count, buffer.as_mut_ptr(), &mut size) == 0 {
            return Vec::new();
        }
        buffer
            .split(|&c| c == 0)
            .filter(|s| !s.is_empty())
            .map(String::from_utf16_lossy)
            .collect()
    }
}

#[cfg(target_os = "macos")]
pub fn preferred_languages() -> Vec<String> {
    use std::ffi::{c_char, c_void, CStr};
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFLocaleCopyPreferredLanguages() -> *const c_void;
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFStringGetCString(
            string: *const c_void,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(value: *const c_void);
    }
    unsafe {
        let languages = CFLocaleCopyPreferredLanguages();
        if languages.is_null() {
            return Vec::new();
        }
        let mut result = Vec::new();
        for index in 0..CFArrayGetCount(languages) {
            let mut buffer = [0 as c_char; 256];
            if CFStringGetCString(
                CFArrayGetValueAtIndex(languages, index),
                buffer.as_mut_ptr(),
                buffer.len() as isize,
                0x08000100,
            ) != 0
            {
                result.push(
                    CStr::from_ptr(buffer.as_ptr())
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        CFRelease(languages);
        result
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn preferred_languages() -> Vec<String> {
    let mut result = Vec::new();
    for key in ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            for language in value.split(':') {
                let name = language
                    .split(['.', '@'])
                    .next()
                    .unwrap_or("")
                    .replace('_', "-");
                if !name.is_empty() && name != "C" && name != "POSIX" && !result.contains(&name) {
                    result.push(name);
                }
            }
        }
    }
    result
}
