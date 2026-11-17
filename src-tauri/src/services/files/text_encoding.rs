//! Strict text encoding detection and conversion for editable files.
use crate::error::{AppError, AppResult};
use encoding_rs::{
    Encoding, BIG5, EUC_JP, EUC_KR, GB18030, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8,
    WINDOWS_1252,
};
use serde::{Deserialize, Serialize};

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
const UTF16LE_BOM: &[u8] = b"\xFF\xFE";
const UTF16BE_BOM: &[u8] = b"\xFE\xFF";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    Gb18030,
    Gbk,
    Big5,
    ShiftJis,
    EucJp,
    EucKr,
    Windows1252,
}

impl TextEncoding {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "utf-8" | "utf8" => Ok(Self::Utf8),
            "utf-16le" | "utf-16-le" => Ok(Self::Utf16Le),
            "utf-16be" | "utf-16-be" => Ok(Self::Utf16Be),
            "gb18030" => Ok(Self::Gb18030),
            "gbk" => Ok(Self::Gbk),
            "big5" => Ok(Self::Big5),
            "shift-jis" | "shift_jis" | "sjis" => Ok(Self::ShiftJis),
            "euc-jp" | "euc_jp" => Ok(Self::EucJp),
            "euc-kr" | "euc_kr" => Ok(Self::EucKr),
            "windows-1252" | "windows1252" | "cp1252" => Ok(Self::Windows1252),
            _ => Err(AppError::validation("sftp.invalidEncoding")),
        }
    }

    #[allow(dead_code, reason = "Used by frontend-facing DTO serialization")]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf16Le => "utf-16le",
            Self::Utf16Be => "utf-16be",
            Self::Gb18030 => "gb18030",
            Self::Gbk => "gbk",
            Self::Big5 => "big5",
            Self::ShiftJis => "shift-jis",
            Self::EucJp => "euc-jp",
            Self::EucKr => "euc-kr",
            Self::Windows1252 => "windows-1252",
        }
    }

    fn encoding(self) -> &'static Encoding {
        match self {
            Self::Utf8 => UTF_8,
            Self::Utf16Le => UTF_16LE,
            Self::Utf16Be => UTF_16BE,
            Self::Gb18030 => GB18030,
            Self::Gbk => GBK,
            Self::Big5 => BIG5,
            Self::ShiftJis => SHIFT_JIS,
            Self::EucJp => EUC_JP,
            Self::EucKr => EUC_KR,
            Self::Windows1252 => WINDOWS_1252,
        }
    }

    fn from_encoding(encoding: &'static Encoding) -> Option<Self> {
        if encoding == GBK || encoding == GB18030 {
            // GB18030 is a byte-compatible superset and a stable save default.
            Some(Self::Gb18030)
        } else if encoding == UTF_8 {
            Some(Self::Utf8)
        } else if encoding == UTF_16LE {
            Some(Self::Utf16Le)
        } else if encoding == UTF_16BE {
            Some(Self::Utf16Be)
        } else if encoding == BIG5 {
            Some(Self::Big5)
        } else if encoding == SHIFT_JIS {
            Some(Self::ShiftJis)
        } else if encoding == EUC_JP {
            Some(Self::EucJp)
        } else if encoding == EUC_KR {
            Some(Self::EucKr)
        } else if encoding == WINDOWS_1252 {
            Some(Self::Windows1252)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone)]
pub struct DecodedText {
    pub content: String,
    pub encoding: TextEncoding,
    pub bom: bool,
}

fn bom(bytes: &[u8]) -> Option<(TextEncoding, usize)> {
    if bytes.starts_with(UTF8_BOM) {
        Some((TextEncoding::Utf8, UTF8_BOM.len()))
    } else if bytes.starts_with(UTF16LE_BOM) {
        Some((TextEncoding::Utf16Le, UTF16LE_BOM.len()))
    } else if bytes.starts_with(UTF16BE_BOM) {
        Some((TextEncoding::Utf16Be, UTF16BE_BOM.len()))
    } else {
        None
    }
}

fn detect(bytes: &[u8]) -> TextEncoding {
    if std::str::from_utf8(bytes).is_ok() {
        return TextEncoding::Utf8;
    }
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    TextEncoding::from_encoding(detector.guess(None, chardetng::Utf8Detection::Deny))
        .unwrap_or(TextEncoding::Windows1252)
}

pub fn decode(bytes: &[u8], requested: Option<TextEncoding>) -> AppResult<DecodedText> {
    let detected_bom = bom(bytes);
    let encoding = detected_bom
        .map(|(encoding, _)| encoding)
        .or(requested)
        .unwrap_or_else(|| detect(bytes));
    let has_utf16_bom = matches!(
        detected_bom,
        Some((TextEncoding::Utf16Le | TextEncoding::Utf16Be, _))
    );
    let requested_utf16 = matches!(encoding, TextEncoding::Utf16Le | TextEncoding::Utf16Be);
    if bytes.contains(&0) && !has_utf16_bom && !requested_utf16 {
        return Err(AppError::validation("sftp.binaryFile"));
    }
    let bom = detected_bom.is_some_and(|(detected, _)| detected == encoding);
    let offset = if bom {
        detected_bom.map_or(0, |(_, length)| length)
    } else {
        0
    };
    let content = encoding
        .encoding()
        .decode_without_bom_handling_and_without_replacement(&bytes[offset..])
        .ok_or_else(|| AppError::validation("sftp.unsupportedEncoding"))?;
    if content.contains('\0') {
        return Err(AppError::validation("sftp.binaryFile"));
    }
    Ok(DecodedText {
        content: content.into_owned(),
        encoding,
        bom,
    })
}

pub fn encode(content: &str, encoding: TextEncoding, bom: bool) -> AppResult<Vec<u8>> {
    let bytes = match encoding {
        TextEncoding::Utf16Le => {
            let mut bytes = Vec::with_capacity(content.len() * 2);
            for unit in content.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes
        }
        TextEncoding::Utf16Be => {
            let mut bytes = Vec::with_capacity(content.len() * 2);
            for unit in content.encode_utf16() {
                bytes.extend_from_slice(&unit.to_be_bytes());
            }
            bytes
        }
        _ => {
            let (bytes, _, had_errors) = encoding.encoding().encode(content);
            if had_errors {
                return Err(AppError::validation("sftp.encodingEncodeFailed"));
            }
            bytes.into_owned()
        }
    };
    let mut result = Vec::with_capacity(bytes.len() + 3);
    if bom {
        match encoding {
            TextEncoding::Utf8 => result.extend_from_slice(UTF8_BOM),
            TextEncoding::Utf16Le => result.extend_from_slice(UTF16LE_BOM),
            TextEncoding::Utf16Be => result.extend_from_slice(UTF16BE_BOM),
            _ => {}
        }
    }
    result.extend_from_slice(&bytes);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_bom_and_legacy_encodings_without_loss() {
        let utf8 = decode(b"\xEF\xBB\xBFhello\n", None).unwrap();
        assert_eq!(
            (utf8.content.as_str(), utf8.encoding, utf8.bom),
            ("hello\n", TextEncoding::Utf8, true)
        );
        let gb18030 = encoding_rs::GB18030.encode("中文\r\n").0;
        let decoded = decode(&gb18030, None).unwrap();
        assert_eq!(decoded.content, "中文\r\n");
        assert_eq!(decoded.encoding, TextEncoding::Gb18030);
        assert!(!decoded.bom);
        let encoded = encode(&decoded.content, decoded.encoding, decoded.bom).unwrap();
        assert_eq!(encoded, gb18030.as_ref());
    }

    #[test]
    fn explicit_encoding_controls_decode_and_round_trip() {
        let big5 = encoding_rs::BIG5.encode("繁體中文").0;
        let decoded = decode(&big5, Some(TextEncoding::Big5)).unwrap();
        assert_eq!(decoded.content, "繁體中文");
        assert_eq!(decoded.encoding, TextEncoding::Big5);
        assert_eq!(
            encode(&decoded.content, decoded.encoding, false).unwrap(),
            big5.as_ref()
        );
        assert_eq!(TextEncoding::parse("UTF-8").unwrap(), TextEncoding::Utf8);
        assert!(TextEncoding::parse("not-an-encoding").is_err());
    }

    #[test]
    fn explicit_utf16_without_bom_is_not_treated_as_binary() {
        for (encoding, bytes) in [
            (TextEncoding::Utf16Le, b"h\0i\0".as_slice()),
            (TextEncoding::Utf16Be, b"\0h\0i".as_slice()),
        ] {
            let decoded = decode(bytes, Some(encoding)).unwrap();
            assert_eq!(decoded.content, "hi");
            assert_eq!(decoded.encoding, encoding);
            assert!(!decoded.bom);
            assert_eq!(encode("hi", encoding, false).unwrap(), bytes);
        }
    }

    #[test]
    fn utf16_bom_round_trips_without_treating_nul_bytes_as_binary() {
        for (encoding, bytes) in [
            (TextEncoding::Utf16Le, b"\xFF\xFEh\0i\0".as_slice()),
            (TextEncoding::Utf16Be, b"\xFE\xFF\0h\0i".as_slice()),
        ] {
            let decoded = decode(bytes, None).unwrap();
            assert_eq!(decoded.content, "hi");
            assert_eq!(decoded.encoding, encoding);
            assert!(decoded.bom);
            assert_eq!(encode("hi", encoding, true).unwrap(), bytes);
        }
    }

    #[test]
    fn rejects_binary_and_wrong_explicit_decodes() {
        assert_eq!(
            decode(b"a\0b", None).unwrap_err().to_string(),
            "sftp.binaryFile"
        );
        assert_eq!(
            decode(&[0x81], Some(TextEncoding::Utf8))
                .unwrap_err()
                .to_string(),
            "sftp.unsupportedEncoding"
        );
    }
}
