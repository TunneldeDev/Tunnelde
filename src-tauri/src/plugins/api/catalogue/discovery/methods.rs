use super::ApiMethod;

pub const METHODS: &[ApiMethod] = &[
    method!("extensions.describe", [], "{}", "Discover implemented extension points, their domain, permissions, registration methods, composition and runtime ownership. The experimental directory is not a completeness or authorization claim; use api.describe for individual method contracts."),
    stable_method!("api.describe", [], "{}", "List the fixed versioned host API; every request still checks runtime authorization.", "0.21.0"),
];
