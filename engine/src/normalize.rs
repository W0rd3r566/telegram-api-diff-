//! Volatile-data normalization inspired by Telegram production snapshots.
//!
//! Only documented volatile fragments are removed. Meaningful application
//! data is preserved, including nested config fields.

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

fn patterns() -> &'static [Regex; 6] {
    static PATTERNS: OnceLock<[Regex; 6]> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            Regex::new(r"(?is)<time\b[^>]*>.*?</time\s*>|<time\b[^>]*/\s*>").unwrap(),
            Regex::new(r"(?is)<!--\s*page generated in\s+\d+(?:\.\d+)?\s*ms\s*-->").unwrap(),
            Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}:8888\b").unwrap(),
            Regex::new(r"(?i)(?:hash|token|passport_ssid|nonce)=[^&#\s\x22\x27<>]*&?").unwrap(),
            Regex::new(r"(?i)(sig|se)=[^&;\s,}\x22\x27]+").unwrap(),
            Regex::new(r"(?i)(\.(?:js|css))\?[0-9]+_[0-9]+").unwrap(),
        ]
    })
}

fn clean_query_separators(value: &str) -> String {
    let mut output = value
        .replace("?&", "?")
        .replace("&&", "&")
        .replace("&?", "?");

    for suffix in ["?", "&"] {
        while output.ends_with(suffix) {
            output.pop();
        }
    }

    output
}

/// Remove known volatile fragments from Telegram web resources.
pub fn normalize_text(input: &str) -> String {
    let regex = patterns();
    let mut output = regex[0].replace_all(input, "").into_owned();
    output = regex[1].replace_all(&output, "").into_owned();
    output = regex[2].replace_all(&output, "").into_owned();
    output = regex[3].replace_all(&output, "").into_owned();
    output = regex[4].replace_all(&output, "$1=").into_owned();
    output = regex[5].replace_all(&output, "$1").into_owned();

    clean_query_separators(&output)
}

/// Normalize help.getAppConfig.json while ignoring its known volatile fields.
///
/// Only top-level keys are removed. Nested fields with the same names may carry
/// application data and are therefore preserved.
pub fn normalize_app_config_json(input: &str) -> Result<String, serde_json::Error> {
    let mut value: Value = serde_json::from_str(input)?;

    if let Some(object) = value.as_object_mut() {
        object.remove("hash");
        object.remove("ton_usd_rate");
    }

    serde_json::to_string_pretty(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_volatile_html_fragments() {
        let input = concat!(
            "<main>stable</main>",
            "<time datetime=\"now\">just now</time>",
            "<!-- page generated in 12 ms -->",
            " 10.20.30.40:8888"
        );
        assert_eq!(normalize_text(input), "<main>stable</main> ");
    }

    #[test]
    fn strips_only_known_query_parameters() {
        let input = "/asset.js?hash=secret&lang=en&token=abc";
        assert_eq!(normalize_text(input), "/asset.js?lang=en");
    }

    #[test]
    fn removes_cache_buster_suffixes_from_js_and_css() {
        let input = "/app.js?12345_67890 /theme.css?12_34 /keep.json?123_456";
        assert_eq!(
            normalize_text(input),
            "/app.js /theme.css /keep.json?123_456"
        );
    }

    #[test]
    fn clears_signature_values_but_keeps_keys() {
        let input = "sig=abc123&se=xyz789";
        assert_eq!(normalize_text(input), "sig=&se=");
    }

    #[test]
    fn normalizes_app_config_ignoring_only_top_level_noise() {
        let input = r#"{
            "hash": "random",
            "ton_usd_rate": 1.2,
            "nested": {"hash": "meaningful"},
            "version": 7
        }"#;

        let normalized: Value =
            serde_json::from_str(&normalize_app_config_json(input).unwrap()).unwrap();

        assert!(normalized.get("hash").is_none());
        assert!(normalized.get("ton_usd_rate").is_none());
        assert_eq!(normalized["nested"]["hash"], "meaningful");
        assert_eq!(normalized["version"], 7);
    }

    #[test]
    fn rejects_invalid_app_config_json() {
        assert!(normalize_app_config_json("{broken").is_err());
    }
}
