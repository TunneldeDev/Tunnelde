//! Placement uses physical bounds. Hit testing requires one coherent native
//! desktop space: physical on Windows/Linux; normalized Cocoa points on macOS.
//! Browser screenX/screenY and CSS pixels are never accepted as drop authority.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
    fn contains(self, x: f64, y: f64) -> bool {
        self.valid()
            && x >= self.x
            && x < self.x + self.width
            && y >= self.y
            && y < self.y + self.height
    }
    fn overlap(self, other: Self) -> f64 {
        let width =
            ((self.x + self.width).min(other.x + other.width) - self.x.max(other.x)).max(0.0);
        let height =
            ((self.y + self.height).min(other.y + other.height) - self.y.max(other.y)).max(0.0);
        width * height
    }
}
/// Tauri's macOS outer bounds are multiplied by each window's backing scale,
/// while its desktop cursor uses the primary monitor's scale. Normalize both
/// before hit testing; comparing these nominally "physical" values directly is
/// incorrect when a window is on a monitor with a different backing scale.
#[cfg(any(target_os = "macos", test))]
pub(super) fn desktop_points(rect: Rect, scale: f64) -> Option<Rect> {
    if !rect.valid() || !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let result = Rect {
        x: rect.x / scale,
        y: rect.y / scale,
        width: rect.width / scale,
        height: rect.height / scale,
    };
    result.valid().then_some(result)
}
#[derive(Clone, Copy)]
pub(super) struct Monitor {
    pub work_area: Rect,
    pub scale: f64,
}
#[derive(Clone, Copy)]
pub(super) struct SavedBounds {
    pub rect: Rect,
    pub scale: f64,
}
#[derive(Clone, Copy)]
pub(super) struct WindowBounds<'a> {
    pub id: &'a str,
    pub rect: Rect,
    pub visible: bool,
}

/// Windows are supplied frontmost-first from native focus/stack tracking. The
/// caller only includes registered application windows, never browser payloads.
pub(super) fn drop_target<'a>(x: f64, y: f64, windows: &[WindowBounds<'a>]) -> Option<&'a str> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    windows
        .iter()
        .find(|window| window.visible && window.rect.contains(x, y))
        .map(|window| window.id)
}

/// Preserve logical dimensions when a screen's DPI changes; keep every edge in
/// the current work area, including when the saved display was disconnected.
pub(super) fn restore(saved: SavedBounds, monitors: &[Monitor]) -> Option<Rect> {
    let monitors: Vec<_> = monitors
        .iter()
        .filter(|monitor| {
            monitor.work_area.valid() && monitor.scale.is_finite() && monitor.scale > 0.0
        })
        .collect();
    let first = *monitors.first()?;
    let valid = saved.rect.valid() && saved.scale.is_finite() && saved.scale > 0.0;
    let rect = if valid {
        saved.rect
    } else {
        Rect {
            x: first.work_area.x,
            y: first.work_area.y,
            width: 720.0 * first.scale,
            height: 520.0 * first.scale,
        }
    };
    let monitor = monitors
        .iter()
        .copied()
        .max_by(|a, b| {
            let overlap = rect
                .overlap(a.work_area)
                .total_cmp(&rect.overlap(b.work_area));
            if !overlap.is_eq() {
                return overlap;
            }
            // Prefer the closest work area when all intersections are empty.
            let distance = |area: Rect| {
                let x = rect.x.clamp(area.x, area.x + area.width);
                let y = rect.y.clamp(area.y, area.y + area.height);
                (rect.x - x).hypot(rect.y - y)
            };
            distance(b.work_area).total_cmp(&distance(a.work_area))
        })
        .unwrap();
    let area = monitor.work_area;
    let ratio = if valid {
        monitor.scale / saved.scale
    } else {
        1.0
    };
    let width = (rect.width * ratio).clamp((320.0 * monitor.scale).min(area.width), area.width);
    let height = (rect.height * ratio).clamp((240.0 * monitor.scale).min(area.height), area.height);
    Some(Rect {
        x: rect.x.clamp(area.x, area.x + area.width - width),
        y: rect.y.clamp(area.y, area.y + area.height - height),
        width,
        height,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }
    #[test]
    fn physical_hit_testing_handles_negative_coordinates_overlap_hidden_windows_and_edges() {
        let windows = [
            WindowBounds {
                id: "hidden",
                rect: rect(-1200.0, 0.0, 1000.0, 800.0),
                visible: false,
            },
            WindowBounds {
                id: "front",
                rect: rect(-900.0, 0.0, 600.0, 800.0),
                visible: true,
            },
            WindowBounds {
                id: "back",
                rect: rect(-1200.0, 0.0, 1000.0, 800.0),
                visible: true,
            },
            WindowBounds {
                id: "main",
                rect: rect(0.0, 0.0, 1920.0, 1080.0),
                visible: true,
            },
        ];
        assert_eq!(drop_target(-700.0, 100.0, &windows), Some("front"));
        assert_eq!(drop_target(-1100.0, 100.0, &windows), Some("back"));
        assert_eq!(drop_target(0.0, 100.0, &windows), Some("main"));
        assert_eq!(drop_target(1920.0, 100.0, &windows), None);
        assert_eq!(drop_target(-100.0, 100.0, &windows), None);
        assert_eq!(drop_target(f64::NAN, 100.0, &windows), None);
    }
    #[test]
    fn restore_uses_largest_overlap_and_rescales_logical_size_not_the_entire_desktop() {
        let monitors = [
            Monitor {
                work_area: rect(0.0, 24.0, 1920.0, 1056.0),
                scale: 1.0,
            },
            Monitor {
                work_area: rect(-2560.0, -300.0, 2560.0, 1400.0),
                scale: 2.0,
            },
        ];
        let restored = restore(
            SavedBounds {
                rect: rect(-1800.0, -200.0, 720.0, 520.0),
                scale: 1.0,
            },
            &monitors,
        )
        .unwrap();
        assert_eq!(restored, rect(-1800.0, -200.0, 1440.0, 1040.0));
        let restored = restore(
            SavedBounds {
                rect: rect(-1800.0, -200.0, 1440.0, 1040.0),
                scale: 2.0,
            },
            &monitors[..1],
        )
        .unwrap();
        assert_eq!(restored, rect(0.0, 24.0, 720.0, 520.0));
    }
    #[test]
    fn disconnected_screens_oversize_and_corrupt_preferences_never_leave_unreachable_chrome() {
        let monitor = Monitor {
            work_area: rect(100.0, 40.0, 800.0, 600.0),
            scale: 1.5,
        };
        for (saved, scale) in [
            (rect(-8000.0, -9000.0, 5000.0, 4000.0), 1.0),
            (rect(f64::NAN, 0.0, 300.0, 300.0), 1.0),
            (rect(300.0, 300.0, 300.0, 300.0), 0.0),
        ] {
            let result = restore(SavedBounds { rect: saved, scale }, &[monitor]).unwrap();
            assert!(result.x >= 100.0 && result.y >= 40.0);
            assert!(result.x + result.width <= 900.0 && result.y + result.height <= 640.0);
        }
        assert!(restore(
            SavedBounds {
                rect: monitor.work_area,
                scale: 1.0
            },
            &[]
        )
        .is_none());
    }
}

#[cfg(test)]
mod mixed_scale_tests {
    use super::*;
    #[test]
    fn cocoa_desktop_normalization_uses_each_native_geometrys_own_scale() {
        let retina = desktop_points(
            Rect {
                x: -2400.0,
                y: -200.0,
                width: 1800.0,
                height: 1400.0,
            },
            2.0,
        )
        .unwrap();
        let external = desktop_points(
            Rect {
                x: 1000.0,
                y: 0.0,
                width: 700.0,
                height: 600.0,
            },
            1.0,
        )
        .unwrap();
        let windows = [
            WindowBounds {
                id: "retina",
                rect: retina,
                visible: true,
            },
            WindowBounds {
                id: "external",
                rect: external,
                visible: true,
            },
        ];
        // Desktop cursor is scaled by the primary monitor, not the hovered one.
        assert_eq!(
            drop_target(-2000.0 / 2.0, 100.0 / 2.0, &windows),
            Some("retina")
        );
        assert_eq!(
            drop_target(2200.0 / 2.0, 200.0 / 2.0, &windows),
            Some("external")
        );
        assert_eq!(drop_target(1800.0 / 2.0, 200.0 / 2.0, &windows), None);
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(desktop_points(retina, scale).is_none());
        }
    }
}
