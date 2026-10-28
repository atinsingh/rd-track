//! RFC 3339 UTC timestamp helpers used by every wire type.
//!
//! Timestamps are serialized as `YYYY-MM-DDTHH:MM:SS[.mmm]Z`: always UTC with a `Z`
//! suffix, millisecond precision at most, and no fractional part when it is zero (so a
//! minute-aligned `bucket_start` reads `2026-10-28T09:41:00Z`).

use chrono::{DateTime, DurationRound, SecondsFormat, TimeDelta, Utc};
use serde::{Deserialize, Deserializer, Serializer};

/// Truncates a timestamp to whole milliseconds.
pub fn to_millis(t: DateTime<Utc>) -> DateTime<Utc> {
    t.duration_trunc(TimeDelta::milliseconds(1)).unwrap_or(t)
}

/// Truncates a timestamp to the start of its UTC minute.
pub fn floor_minute(t: DateTime<Utc>) -> DateTime<Utc> {
    t.duration_trunc(TimeDelta::minutes(1)).unwrap_or(t)
}

/// Formats a timestamp the way the wire contract expects.
pub fn format(t: &DateTime<Utc>) -> String {
    to_millis(*t).to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

/// Parses an RFC 3339 timestamp (any offset) into UTC.
pub fn parse(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// `serde(with = "crate::ts")` support for `DateTime<Utc>`.
pub fn serialize<S: Serializer>(t: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format(t))
}

/// `serde(with = "crate::ts")` support for `DateTime<Utc>`.
pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
    let s = String::deserialize(d)?;
    parse(&s).ok_or_else(|| serde::de::Error::custom("invalid RFC 3339 timestamp"))
}

/// `serde(with = "crate::ts::option")` support for `Option<DateTime<Utc>>`.
pub mod option {
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer, Serializer};

    /// Serializes `Some(t)` as a timestamp string and `None` as `null`.
    pub fn serialize<S: Serializer>(t: &Option<DateTime<Utc>>, s: S) -> Result<S::Ok, S::Error> {
        match t {
            Some(t) => s.serialize_str(&super::format(t)),
            None => s.serialize_none(),
        }
    }

    /// Lenient: an unparseable or missing timestamp becomes `None`.
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<DateTime<Utc>>, D::Error> {
        let s = Option::<String>::deserialize(d)?;
        Ok(s.as_deref().and_then(super::parse))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn formats_utc_with_z_and_optional_millis() {
        let t = Utc.with_ymd_and_hms(2026, 10, 28, 9, 41, 0).unwrap();
        assert_eq!(format(&t), "2026-10-28T09:41:00Z");
        let t = t + TimeDelta::microseconds(1_234_567);
        assert_eq!(format(&t), "2026-10-28T09:41:01.234Z");
    }

    #[test]
    fn floors_to_minute() {
        let t = Utc.with_ymd_and_hms(2026, 10, 28, 9, 41, 59).unwrap() + TimeDelta::milliseconds(999);
        assert_eq!(
            floor_minute(t),
            Utc.with_ymd_and_hms(2026, 10, 28, 9, 41, 0).unwrap()
        );
    }

    #[test]
    fn parses_offsets_into_utc() {
        let t = parse("2026-10-28T11:41:00+02:00").unwrap();
        assert_eq!(format(&t), "2026-10-28T09:41:00Z");
        assert!(parse("yesterday").is_none());
    }
}
