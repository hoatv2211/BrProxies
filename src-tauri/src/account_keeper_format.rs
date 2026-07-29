use anyhow::{bail, Result};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

const UPPERCASE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE: &str = "abcdefghijklmnopqrstuvwxyz";
const DIGITS: &str = "0123456789";
const SYMBOLS: &str = "!@#$%^&*_-+=?";
const PASSWORD_CHARACTERS: &str =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*_-+=?";
const MAX_UNIQUE_ATTEMPTS: usize = 128;

pub trait RandomSource {
    fn fill_bytes(&mut self, destination: &mut [u8]) -> Result<()>;
}

pub struct OsRandom;

impl RandomSource for OsRandom {
    fn fill_bytes(&mut self, destination: &mut [u8]) -> Result<()> {
        getrandom::getrandom(destination).map_err(|_| anyhow::anyhow!("OS random source failed"))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PasswordTemplate {
    prefix: String,
    random_len: usize,
    suffix: String,
    final_len: usize,
}

impl PasswordTemplate {
    pub fn parse(value: &str) -> Result<Self> {
        const START: &str = "{random:";

        let mut placeholders = value.match_indices(START);
        let Some((placeholder_start, _)) = placeholders.next() else {
            bail!("password template requires exactly one random placeholder");
        };
        if placeholders.next().is_some() {
            bail!("password template requires exactly one random placeholder");
        }

        let length_start = placeholder_start + START.len();
        let Some(close_offset) = value[length_start..].find('}') else {
            bail!("invalid random placeholder");
        };
        let placeholder_end = length_start + close_offset;
        let length_text = &value[length_start..placeholder_end];
        if length_text.is_empty() || !length_text.bytes().all(|byte| byte.is_ascii_digit()) {
            bail!("invalid random placeholder");
        }

        let random_len: usize = length_text
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid random placeholder"))?;
        if !(8..=64).contains(&random_len) {
            bail!("random length must be between 8 and 64");
        }

        let prefix = value[..placeholder_start].to_string();
        let suffix = value[placeholder_end + 1..].to_string();
        let final_len = prefix.chars().count() + random_len + suffix.chars().count();
        if !(12..=128).contains(&final_len) {
            bail!("final password length must be between 12 and 128");
        }

        Ok(Self {
            prefix,
            random_len,
            suffix,
            final_len,
        })
    }

    pub fn final_len(&self) -> usize {
        self.final_len
    }

    pub fn generate<R: RandomSource>(
        &self,
        random: &mut R,
        used_passwords: &mut HashSet<String>,
    ) -> Result<String> {
        for _ in 0..MAX_UNIQUE_ATTEMPTS {
            let mut random_characters = Vec::with_capacity(self.random_len);
            random_characters.push(random_character(random, UPPERCASE)?);
            random_characters.push(random_character(random, LOWERCASE)?);
            random_characters.push(random_character(random, DIGITS)?);
            random_characters.push(random_character(random, SYMBOLS)?);
            while random_characters.len() < self.random_len {
                random_characters.push(random_character(random, PASSWORD_CHARACTERS)?);
            }
            for index in (1..random_characters.len()).rev() {
                let swap_index = random_index(random, index + 1)?;
                random_characters.swap(index, swap_index);
            }

            let random_section: String = random_characters.into_iter().collect();
            let password = format!("{}{}{}", self.prefix, random_section, self.suffix);
            if used_passwords.insert(password.clone()) {
                return Ok(password);
            }
        }

        bail!("could not generate a unique password")
    }
}

fn random_character<R: RandomSource>(random: &mut R, characters: &str) -> Result<char> {
    let index = random_index(random, characters.len())?;
    Ok(characters.as_bytes()[index] as char)
}

fn random_index<R: RandomSource>(random: &mut R, upper_bound: usize) -> Result<usize> {
    let accepted_range = 256 - (256 % upper_bound);
    loop {
        let mut byte = [0u8; 1];
        random.fill_bytes(&mut byte)?;
        let value = usize::from(byte[0]);
        if value < accepted_range {
            return Ok(value % upper_bound);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportedAccount {
    pub line: usize,
    pub account: String,
    pub normalized_account: String,
    pub current_password: String,
    pub totp_secret: String,
}

pub fn parse_input(text: &str) -> Result<Vec<ImportedAccount>> {
    let mut accounts = Vec::new();
    let mut normalized_accounts = HashSet::new();

    for (index, line) in text.lines().enumerate() {
        let line_number = index + 1;
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }

        let Some(first_delimiter) = line.find('|') else {
            bail!("line {line_number}: expected account|password|totp");
        };
        let Some(last_delimiter) = line.rfind('|') else {
            bail!("line {line_number}: expected account|password|totp");
        };
        if first_delimiter == last_delimiter {
            bail!("line {line_number}: expected account|password|totp");
        }

        let account = line[..first_delimiter].trim().to_string();
        if account.is_empty() {
            bail!("line {line_number}: account is empty");
        }
        let normalized_account = normalize_account(&account);
        if !normalized_accounts.insert(normalized_account.clone()) {
            bail!(
                "line {line_number}: duplicate account {}",
                mask_account(&account)
            );
        }

        let current_password = line[first_delimiter + 1..last_delimiter].to_string();
        let totp_secret = line[last_delimiter + 1..].trim().to_string();
        if !totp_secret.is_empty() && decode_base32(&totp_secret).is_err() {
            bail!("line {line_number}: invalid TOTP secret");
        }

        accounts.push(ImportedAccount {
            line: line_number,
            account,
            normalized_account,
            current_password,
            totp_secret,
        });
    }

    Ok(accounts)
}

pub fn normalize_account(value: &str) -> String {
    value.trim().to_lowercase()
}

pub fn mask_account(value: &str) -> String {
    let value = value.trim();
    if let Some((name, domain)) = value.split_once('@') {
        return format!("{}@{domain}", mask_identifier(name));
    }
    mask_identifier(value)
}

fn mask_identifier(value: &str) -> String {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return "***".to_string();
    };
    let last = characters.last();
    match last {
        Some(last) => format!("{first}***{last}"),
        None => format!("{first}***"),
    }
}

pub fn decode_base32(value: &str) -> Result<Vec<u8>> {
    let compact: Vec<char> = value
        .chars()
        .filter(|character| *character != ' ' && *character != '-')
        .collect();
    if compact.is_empty() {
        bail!("invalid Base32");
    }

    let padding_start = compact
        .iter()
        .position(|character| *character == '=')
        .unwrap_or(compact.len());
    if compact[padding_start..]
        .iter()
        .any(|character| *character != '=')
    {
        bail!("invalid Base32");
    }

    let data = &compact[..padding_start];
    let remainder = data.len() % 8;
    let expected_padding = match remainder {
        0 => 0,
        2 => 6,
        4 => 4,
        5 => 3,
        7 => 1,
        _ => bail!("invalid Base32"),
    };
    let padding = compact.len() - padding_start;
    if padding != 0 && padding != expected_padding {
        bail!("invalid Base32");
    }

    let mut decoded = Vec::with_capacity(data.len() * 5 / 8);
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for character in data {
        let value = match character.to_ascii_uppercase() {
            'A'..='Z' => character.to_ascii_uppercase() as u8 - b'A',
            '2'..='7' => character.to_ascii_uppercase() as u8 - b'2' + 26,
            _ => bail!("invalid Base32"),
        };
        buffer = (buffer << 5) | u32::from(value);
        bits += 5;
        while bits >= 8 {
            bits -= 8;
            decoded.push((buffer >> bits) as u8);
            buffer &= (1u32 << bits).wrapping_sub(1);
        }
    }

    if bits > 0 && buffer != 0 {
        bail!("invalid Base32");
    }
    if decoded.is_empty() {
        bail!("invalid Base32");
    }

    Ok(decoded)
}

pub fn totp_now(secret: &str) -> Result<String> {
    let secret = decode_base32(secret)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| anyhow::anyhow!("system clock is before the Unix epoch"))?
        .as_secs();
    totp_from_bytes_at(&secret, timestamp, 6)
}

pub fn totp_from_bytes_at(secret: &[u8], timestamp: u64, digits: u32) -> Result<String> {
    if secret.is_empty() {
        bail!("TOTP secret is empty");
    }
    if !(1..=9).contains(&digits) {
        bail!("TOTP digits must be between 1 and 9");
    }

    let counter = timestamp / 30;
    let mut mac =
        Hmac::<Sha1>::new_from_slice(secret).map_err(|_| anyhow::anyhow!("invalid TOTP key"))?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = usize::from(digest[digest.len() - 1] & 0x0f);
    let binary = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    let code = binary % 10u32.pow(digits);

    Ok(format!("{code:0width$}", width = digits as usize))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    struct SequenceRandom {
        bytes: Vec<u8>,
        offset: usize,
    }

    impl SequenceRandom {
        fn new(bytes: Vec<u8>) -> Self {
            Self { bytes, offset: 0 }
        }
    }

    impl RandomSource for SequenceRandom {
        fn fill_bytes(&mut self, destination: &mut [u8]) -> Result<()> {
            for byte in destination {
                *byte = self.bytes[self.offset % self.bytes.len()];
                self.offset += 1;
            }
            Ok(())
        }
    }

    #[test]
    fn parses_password_containing_pipe() {
        let rows = parse_input("owner@example.test|part|two|JBSWY3DPEHPK3PXP\n").unwrap();

        assert_eq!(rows[0].current_password, "part|two");
    }

    #[test]
    fn skips_blank_and_comment_lines_and_preserves_password_exactly() {
        let rows = parse_input(
            "\n  # synthetic comment\n  Owner@Example.Test  |  päss word | value  |  \n",
        )
        .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].line, 3);
        assert_eq!(rows[0].account, "Owner@Example.Test");
        assert_eq!(rows[0].normalized_account, "owner@example.test");
        assert_eq!(rows[0].current_password, "  päss word | value  ");
        assert_eq!(rows[0].totp_secret, "");
    }

    #[test]
    fn accepts_spaced_and_hyphenated_base32() {
        let rows = parse_input("owner@example.test|password|JBSW Y3DP-EHPK3PXP").unwrap();

        assert_eq!(rows[0].totp_secret, "JBSW Y3DP-EHPK3PXP");
    }

    #[test]
    fn invalid_base32_error_redacts_secret() {
        let secret = "INVALID-SECRET-0189";
        let error = parse_input(&format!("owner@example.test|password|{secret}"))
            .unwrap_err()
            .to_string();

        assert!(error.contains("line 1"));
        assert!(error.contains("invalid TOTP secret"));
        assert!(!error.contains("password"));
        assert!(!error.contains(secret));
    }

    #[test]
    fn duplicate_error_redacts_secrets() {
        let error = parse_input("A@x.test|alpha|JBSWY3DPEHPK3PXP\na@x.test|beta|JBSWY3DPEHPK3PXP")
            .unwrap_err()
            .to_string();

        assert!(error.contains("duplicate account"));
        assert!(error.contains("line 2"));
        assert!(!error.contains("alpha"));
        assert!(!error.contains("beta"));
        assert!(!error.contains("JBSWY3DPEHPK3PXP"));
    }

    #[test]
    fn rejects_lines_without_two_delimiters_without_echoing_input() {
        let error = parse_input("owner@example.test|secret-value")
            .unwrap_err()
            .to_string();

        assert!(error.contains("line 1"));
        assert!(error.contains("expected account|password|totp"));
        assert!(!error.contains("secret-value"));
    }

    #[test]
    fn normalizes_and_masks_accounts() {
        assert_eq!(
            normalize_account("  Owner@Example.Test "),
            "owner@example.test"
        );
        assert_eq!(mask_account("owner@example.test"), "o***r@example.test");
        assert_eq!(mask_account("xy"), "x***y");
        assert_eq!(mask_account("x"), "x***");
    }

    #[test]
    fn template_requires_one_random_placeholder() {
        assert!(PasswordTemplate::parse("BrP@{random:16}!").is_ok());
        assert!(PasswordTemplate::parse("fixed").is_err());
        assert!(PasswordTemplate::parse("{random:8}-{random:8}").is_err());
        assert!(PasswordTemplate::parse("{random:not-a-number}").is_err());
    }

    #[test]
    fn template_enforces_random_and_final_length_limits() {
        assert!(PasswordTemplate::parse("abcd{random:8}").is_ok());
        assert!(PasswordTemplate::parse("abcd{random:7}").is_err());
        assert!(PasswordTemplate::parse("abcd{random:65}").is_err());
        assert!(PasswordTemplate::parse("abc{random:8}").is_err());
        assert!(PasswordTemplate::parse(&format!("{}{{random:64}}", "x".repeat(65))).is_err());
        assert_eq!(
            PasswordTemplate::parse("éééé{random:8}")
                .unwrap()
                .final_len(),
            12
        );
    }

    #[test]
    fn generated_passwords_are_unique_and_include_all_categories() {
        let template = PasswordTemplate::parse("pre-{random:16}-post").unwrap();
        let mut source = SequenceRandom::new(
            std::iter::repeat_n(0, 31)
                .chain(std::iter::repeat_n(0, 31))
                .chain(std::iter::repeat_n(1, 31))
                .collect(),
        );
        let mut used = HashSet::new();

        let first = template.generate(&mut source, &mut used).unwrap();
        let second = template.generate(&mut source, &mut used).unwrap();

        assert_ne!(first, second);
        assert_eq!(used.len(), 2);
        for password in [first, second] {
            assert_eq!(password.chars().count(), 25);
            assert!(password
                .chars()
                .any(|character| character.is_ascii_uppercase()));
            assert!(password
                .chars()
                .any(|character| character.is_ascii_lowercase()));
            assert!(password.chars().any(|character| character.is_ascii_digit()));
            assert!(password
                .chars()
                .any(|character| SYMBOLS.contains(character)));
        }
    }

    #[test]
    fn matches_rfc_6238_sha1_vectors() {
        let secret = b"12345678901234567890";
        let vectors = [
            (59, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
            (20_000_000_000, "65353130"),
        ];

        for (timestamp, expected) in vectors {
            assert_eq!(totp_from_bytes_at(secret, timestamp, 8).unwrap(), expected);
        }
    }

    #[test]
    fn totp_now_returns_six_digits() {
        let code = totp_now("JBSWY3DPEHPK3PXP").unwrap();

        assert_eq!(code.len(), 6);
        assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
    }
}
