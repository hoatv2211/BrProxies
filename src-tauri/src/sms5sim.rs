// 5SIM SMS-verification API client (https://5sim.net/v1).
//
// Used to rent a temporary phone number and pull the SMS one-time code a site
// sends to it, so account flows (verifying a newly created account, etc.) can
// clear an SMS challenge without a real SIM.
//
// The Bearer token lives in its own `sms5sim.json` (see store::sms5sim_path)
// so the Settings page, which round-trips the whole Settings struct, can't
// accidentally wipe it — same pattern as `psapi.rs`.
//
// Typical caller sequence:
//   1. `order = buy_number(...)`         → rent a number, get `order.phone`
//   2. <caller fills order.phone into the target site's form; site sends SMS>
//   3. `code = poll_code(order.id, ...)` → wait for the SMS, return the code
//   4. `finish_order(order.id)`          → release the number (bill it)
//      or `cancel_order(order.id)`       → abort if no SMS ever arrived
//
// The order `id` and the token never leave Rust; a caller that drives a
// browser only ever needs `phone` (to type) and the returned `code`.

use crate::store;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::time::Duration;

const BASE: &str = "https://5sim.net/v1";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Sms5simConfig {
    #[serde(default)]
    pub token: String,
}

/// One rented activation number. `id` is the 5SIM order id used for polling
/// and finish/cancel; `phone` is what the caller types into the target form.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: i64,
    pub phone: String,
    #[serde(default)]
    pub operator: String,
    #[serde(default)]
    pub product: String,
    #[serde(default)]
    pub country: String,
    /// RFC3339 expiry timestamp; drives the countdown timer in the UI.
    #[serde(default)]
    pub expires: String,
}

pub fn load() -> Result<Sms5simConfig> {
    let path = store::sms5sim_path()?;
    if !path.exists() {
        return Ok(Sms5simConfig::default());
    }
    let body = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&body).unwrap_or_default())
}

fn save(c: &Sms5simConfig) -> Result<()> {
    fs::write(store::sms5sim_path()?, serde_json::to_string_pretty(c)?)?;
    Ok(())
}

pub fn get_token() -> Result<String> {
    Ok(load()?.token)
}

pub fn set_token(token: String) -> Result<()> {
    let mut c = load()?;
    c.token = token.trim().to_string();
    save(&c)
}

pub fn has_token() -> bool {
    load().map(|c| !c.token.is_empty()).unwrap_or(false)
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(Into::into)
}

/// Authenticated GET against the 5SIM API. Every endpoint is a GET; the API
/// returns either a JSON object or a bare text sentinel (e.g. "no free phones")
/// with a 200, so callers must inspect the parsed value, not just the status.
async fn get(path: &str) -> Result<Value> {
    let token = get_token()?;
    if token.is_empty() {
        return Err(anyhow!("5SIM API token not set"));
    }
    let url = format!("{BASE}{path}");
    let resp = client()?
        .get(&url)
        .bearer_auth(&token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .context("request to 5SIM failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        if status.as_u16() == 401 {
            return Err(anyhow!("Unauthorized — check your 5SIM API token"));
        }
        let msg = if text.trim().is_empty() {
            status.as_str().to_string()
        } else {
            text.trim().to_string()
        };
        return Err(anyhow!("5SIM error: {msg}"));
    }

    // 5SIM signals some soft failures as a plain-text 200 body.
    let trimmed = text.trim();
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        return Err(anyhow!("5SIM: {trimmed}"));
    }
    serde_json::from_str(trimmed).context("5SIM returned invalid JSON")
}

/// Unauthenticated GET against a `/guest/*` endpoint. These need only the
/// `Accept` header (no token), so the price browser works before a token is
/// even saved.
async fn get_guest(path: &str) -> Result<Value> {
    let url = format!("{BASE}{path}");
    let resp = client()?
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .context("request to 5SIM failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let msg = if text.trim().is_empty() {
            status.as_str().to_string()
        } else {
            text.trim().to_string()
        };
        return Err(anyhow!("5SIM error: {msg}"));
    }
    let trimmed = text.trim();
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        return Err(anyhow!("5SIM: {trimmed}"));
    }
    serde_json::from_str(trimmed).context("5SIM returned invalid JSON")
}

/// One price row flattened from the nested `country → product → operator`
/// guest-prices response, ready to render in a sortable table.
#[derive(Debug, Clone, Serialize)]
pub struct PriceRow {
    pub country: String,
    pub operator: String,
    pub product: String,
    pub cost: f64,
    pub count: u64,
    pub rate: f64,
}

/// Fetch guest prices, optionally narrowed by `product` and/or `country`, and
/// flatten the nested response into a flat, sortable list of rows.
///
/// The guest-prices JSON nests differently depending on which filter is set:
/// - `?product=X`      → `{ product: { country: { operator: {cost,count,rate} } } }`
/// - `?country=Y`      → `{ country: { product: { operator: {cost,count,rate} } } }`
/// - both / neither    → same two-level-then-operator shapes
///
/// Rather than special-case each, we walk the tree to the leaf objects that
/// carry `cost`/`count`/`rate` and recover `country`/`product` from context.
pub async fn prices(product: Option<&str>, country: Option<&str>) -> Result<Vec<PriceRow>> {
    let mut q: Vec<String> = Vec::new();
    if let Some(p) = product.filter(|s| !s.is_empty()) {
        q.push(format!("product={}", urlencode(p)));
    }
    if let Some(c) = country.filter(|s| !s.is_empty() && *s != "any") {
        q.push(format!("country={}", urlencode(c)));
    }
    let path = if q.is_empty() {
        "/guest/prices".to_string()
    } else {
        format!("/guest/prices?{}", q.join("&"))
    };
    let v = get_guest(&path).await?;

    let mut rows = Vec::new();
    // Top level is either country-keyed or product-keyed. We disambiguate per
    // leaf: whichever of the two filters is fixed pins that dimension, and the
    // key names tell us the rest. We collect (country, product) by trying both.
    let fixed_product = product.filter(|s| !s.is_empty());
    let fixed_country = country.filter(|s| !s.is_empty() && *s != "any");

    if let Value::Object(top) = &v {
        for (k1, v1) in top {
            let Value::Object(mid) = v1 else { continue };
            for (k2, v2) in mid {
                let Value::Object(ops) = v2 else { continue };
                // ops may be operator→leaf, OR another level. Detect a leaf by
                // presence of a "cost" child one level down.
                for (op, leaf) in ops {
                    let Value::Object(fields) = leaf else { continue };
                    if !fields.contains_key("cost") {
                        continue;
                    }
                    // Resolve country/product from the two outer keys using the
                    // fixed filter as the anchor.
                    let (country_name, product_name) = if fixed_product.is_some() {
                        // shape: product → country → operator
                        (k2.clone(), k1.clone())
                    } else if fixed_country.is_some() {
                        // shape: country → product → operator
                        (k1.clone(), k2.clone())
                    } else {
                        // no filter: top is country → product → operator
                        (k1.clone(), k2.clone())
                    };
                    rows.push(PriceRow {
                        country: country_name,
                        product: product_name,
                        operator: op.clone(),
                        cost: fields.get("cost").and_then(|x| x.as_f64()).unwrap_or(0.0),
                        count: fields.get("count").and_then(|x| x.as_u64()).unwrap_or(0),
                        rate: fields.get("rate").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    });
                }
            }
        }
    }
    Ok(rows)
}

/// Available products (services) for a country/operator, with quantity + price.
/// Returned as the raw `{ slug: { Category, Qty, Price } }` map.
pub async fn products(country: &str, operator: &str) -> Result<Value> {
    let c = if country.is_empty() { "any" } else { country };
    let o = if operator.is_empty() { "any" } else { operator };
    get_guest(&format!("/guest/products/{c}/{o}")).await
}

/// One service (product) for the service picker.
#[derive(Debug, Clone, Serialize)]
pub struct Service {
    pub slug: String,
    pub category: String,
    pub qty: u64,
    pub price: f64,
}

/// Full activation-service catalogue (`/guest/products/any/any`), flattened and
/// sorted by availability so the picker shows the most-stocked first.
pub async fn service_list() -> Result<Vec<Service>> {
    let v = get_guest("/guest/products/any/any").await?;
    let mut out = Vec::new();
    if let Value::Object(map) = v {
        for (slug, meta) in map {
            let category = meta
                .get("Category")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            // Only activation services can be rented for SMS; skip hosting.
            if category != "activation" {
                continue;
            }
            out.push(Service {
                slug,
                category,
                qty: meta.get("Qty").and_then(|q| q.as_u64()).unwrap_or(0),
                price: meta.get("Price").and_then(|p| p.as_f64()).unwrap_or(0.0),
            });
        }
    }
    out.sort_by(|a, b| b.qty.cmp(&a.qty).then_with(|| a.slug.cmp(&b.slug)));
    Ok(out)
}

/// One country for flag/name lookup.
#[derive(Debug, Clone, Serialize)]
pub struct Country {
    pub slug: String,
    pub iso: String,
    pub name: String,
}

/// Country catalogue (`/guest/countries`): maps a 5SIM country slug to its ISO
/// two-letter code (for flag images) and English name.
pub async fn country_list() -> Result<Vec<Country>> {
    let v = get_guest("/guest/countries").await?;
    let mut out = Vec::new();
    if let Value::Object(map) = v {
        for (slug, meta) in map {
            // `iso` is an object like { "af": 1 }; take the first key.
            let iso = meta
                .get("iso")
                .and_then(|i| i.as_object())
                .and_then(|o| o.keys().next())
                .cloned()
                .unwrap_or_default();
            let name = meta
                .get("text_en")
                .and_then(|t| t.as_str())
                .unwrap_or(&slug)
                .to_string();
            out.push(Country { slug, iso, name });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Minimal percent-encoding for path/query segments (slugs are ASCII, but be
/// safe about spaces and the odd separator).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Current account balance, as reported by `GET /user/profile`. Handy for a
/// "test connection" button on the settings screen.
pub async fn balance() -> Result<f64> {
    let v = get("/user/profile").await?;
    Ok(v.get("balance").and_then(|b| b.as_f64()).unwrap_or(0.0))
}

/// Account profile summary for the header (balance, rating, email).
#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    pub email: String,
    pub balance: f64,
    pub rating: f64,
    pub frozen_balance: f64,
}

pub async fn profile() -> Result<Profile> {
    let v = get("/user/profile").await?;
    let f = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    Ok(Profile {
        email: v.get("email").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        balance: f("balance"),
        rating: f("rating"),
        frozen_balance: f("frozen_balance"),
    })
}

/// One row of order history.
#[derive(Debug, Clone, Serialize)]
pub struct OrderRow {
    pub id: i64,
    pub phone: String,
    pub operator: String,
    pub product: String,
    pub country: String,
    pub price: f64,
    pub status: String,
    pub created_at: String,
    /// RFC3339 expiry timestamp (empty for finished/expired orders).
    pub expires: String,
    /// The first received SMS code, if any.
    pub code: Option<String>,
}

/// Order history (`GET /user/orders?category=activation`), newest first.
pub async fn orders(limit: u32) -> Result<Vec<OrderRow>> {
    let v = get(&format!("/user/orders?category=activation&limit={limit}&order=id&reverse=true")).await?;
    let arr = v.get("Data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let s = |o: &Value, k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Ok(arr
        .iter()
        .map(|o| OrderRow {
            id: o.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
            phone: s(o, "phone"),
            operator: s(o, "operator"),
            product: s(o, "product"),
            country: s(o, "country"),
            price: o.get("price").and_then(|x| x.as_f64()).unwrap_or(0.0),
            status: s(o, "status"),
            created_at: s(o, "created_at"),
            expires: s(o, "expires"),
            code: o
                .get("sms")
                .and_then(|s| s.as_array())
                .and_then(|a| a.first())
                .and_then(|m| m.get("code"))
                .and_then(|c| c.as_str())
                .filter(|c| !c.is_empty())
                .map(|c| c.to_string()),
        })
        .collect())
}

/// One row of payments history.
#[derive(Debug, Clone, Serialize)]
pub struct PaymentRow {
    pub id: i64,
    #[serde(rename = "type")]
    pub type_name: String,
    pub provider: String,
    pub amount: f64,
    pub balance: f64,
    pub created_at: String,
}

/// Payments history (`GET /user/payments`), newest first.
pub async fn payments(limit: u32) -> Result<Vec<PaymentRow>> {
    let v = get(&format!("/user/payments?limit={limit}&order=id&reverse=true")).await?;
    let arr = v.get("Data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let s = |o: &Value, k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Ok(arr
        .iter()
        .map(|o| PaymentRow {
            id: o.get("ID").and_then(|x| x.as_i64()).unwrap_or(0),
            type_name: s(o, "TypeName"),
            provider: s(o, "ProviderName"),
            amount: o.get("Amount").and_then(|x| x.as_f64()).unwrap_or(0.0),
            balance: o.get("Balance").and_then(|x| x.as_f64()).unwrap_or(0.0),
            created_at: s(o, "CreatedAt"),
        })
        .collect())
}

/// Rent an activation number. `country`/`operator` may be `"any"` to let 5SIM
/// pick the cheapest; `product` is the service slug (e.g. "facebook", "google",
/// "openai"). Errors surface 5SIM's own wording ("no free phones", balance,
/// bad country/operator/product, …).
pub async fn buy_number(country: &str, operator: &str, product: &str) -> Result<Order> {
    let path = format!("/user/buy/activation/{country}/{operator}/{product}");
    let v = get(&path).await?;
    let id = v
        .get("id")
        .and_then(|i| i.as_i64())
        .ok_or_else(|| anyhow!("5SIM response missing order id"))?;
    let phone = v
        .get("phone")
        .and_then(|p| p.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("5SIM response missing phone"))?
        .to_string();
    let s = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    Ok(Order {
        id,
        phone,
        operator: s("operator"),
        product: s("product"),
        country: s("country"),
        expires: s("expires"),
    })
}

/// Fetch the latest known SMS code for an order without waiting. Returns
/// `Ok(None)` while the order is still PENDING (no SMS yet). Prefer
/// `poll_code` for the common "wait until it arrives" case.
pub async fn check_code(id: i64) -> Result<Option<String>> {
    let v = get(&format!("/user/check/{id}")).await?;
    Ok(extract_code(&v))
}

/// Poll `GET /user/check/{id}` every `interval` until an SMS code arrives or
/// `timeout` elapses. On timeout the order is NOT cancelled — the caller
/// decides whether to `cancel_order` (no charge) or keep waiting.
pub async fn poll_code(id: i64, timeout: Duration, interval: Duration) -> Result<String> {
    let start = std::time::Instant::now();
    loop {
        if let Some(code) = check_code(id).await? {
            return Ok(code);
        }
        if start.elapsed() >= timeout {
            return Err(anyhow!("timed out waiting for SMS on order {id}"));
        }
        tokio::time::sleep(interval).await;
    }
}

/// Mark the order finished (bills it). Call after the code was used
/// successfully so the number is released.
pub async fn finish_order(id: i64) -> Result<()> {
    get(&format!("/user/finish/{id}")).await.map(|_| ())
}

/// Cancel the order. Only valid before any SMS arrives; 5SIM rejects cancel
/// once the order has an SMS. Use to avoid being billed for an unused number.
pub async fn cancel_order(id: i64) -> Result<()> {
    get(&format!("/user/cancel/{id}")).await.map(|_| ())
}

/// Ban the number (reports it as bad and blocks re-issue). Use when the number
/// is compromised/spammed; unlike cancel it works even after an SMS.
pub async fn ban_order(id: i64) -> Result<()> {
    get(&format!("/user/ban/{id}")).await.map(|_| ())
}

/// Pull the first SMS `code` out of a `/user/check` response, if the order has
/// received one. 5SIM returns `sms: null` until a message arrives.
fn extract_code(v: &Value) -> Option<String> {
    v.get("sms")
        .and_then(|s| s.as_array())
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("code"))
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_code_reads_first_sms() {
        let v = json!({
            "status": "RECEIVED",
            "sms": [{ "sender": "Facebook", "text": "code 09363", "code": "09363" }]
        });
        assert_eq!(extract_code(&v), Some("09363".to_string()));
    }

    #[test]
    fn extract_code_none_while_pending() {
        assert_eq!(extract_code(&json!({ "status": "PENDING", "sms": null })), None);
        assert_eq!(extract_code(&json!({ "status": "PENDING", "sms": [] })), None);
    }

    // Verify the tree-walk in `prices` by exercising the same leaf-collection
    // logic against each guest-prices shape. (`prices` itself does the HTTP;
    // this mirrors its flattening so the shape handling is covered.)
    fn flatten(v: &Value, product_fixed: bool, country_fixed: bool) -> Vec<PriceRow> {
        let mut rows = Vec::new();
        if let Value::Object(top) = v {
            for (k1, v1) in top {
                let Value::Object(mid) = v1 else { continue };
                for (k2, v2) in mid {
                    let Value::Object(ops) = v2 else { continue };
                    for (op, leaf) in ops {
                        let Value::Object(f) = leaf else { continue };
                        if !f.contains_key("cost") { continue; }
                        let (country, product) = if product_fixed {
                            (k2.clone(), k1.clone())
                        } else if country_fixed {
                            (k1.clone(), k2.clone())
                        } else {
                            (k1.clone(), k2.clone())
                        };
                        rows.push(PriceRow {
                            country, product, operator: op.clone(),
                            cost: f["cost"].as_f64().unwrap_or(0.0),
                            count: f["count"].as_u64().unwrap_or(0),
                            rate: f.get("rate").and_then(|x| x.as_f64()).unwrap_or(0.0),
                        });
                    }
                }
            }
        }
        rows
    }

    #[test]
    fn flatten_product_shape() {
        // ?product=telegram → product → country → operator
        let v = json!({ "telegram": { "france": { "virtual51": { "cost": 5.8, "count": 778, "rate": 41.67 } } } });
        let rows = flatten(&v, true, false);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].country, "france");
        assert_eq!(rows[0].product, "telegram");
        assert_eq!(rows[0].operator, "virtual51");
        assert_eq!(rows[0].count, 778);
    }

    #[test]
    fn flatten_country_shape() {
        // ?country=england → country → product → operator
        let v = json!({ "england": { "facebook": { "vodafone": { "cost": 4.0, "count": 1260, "rate": 99.99 } } } });
        let rows = flatten(&v, false, true);
        assert_eq!(rows[0].country, "england");
        assert_eq!(rows[0].product, "facebook");
    }
}
