use serde_json::value::RawValue;
use std::{collections::BTreeMap, io, sync::Arc};
use tokio::io::{AsyncRead, AsyncReadExt};

pub const MAX_HOST: usize = 1024 * 1024;
pub const MAX_EXTENSION: usize = 64 * MAX_HOST;
pub type Envelope = BTreeMap<String, Box<RawValue>>;

pub fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

// read_exact retains partial headers/payloads across async reads. Never select!
// against this future: cancel the entire connection task when disconnecting.
pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> io::Result<Option<Option<Envelope>>> {
    let mut header = [0; 4];
    if reader.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    reader
        .read_exact(&mut header[1..])
        .await
        .map_err(truncated)?;
    let length = u32::from_ne_bytes(header) as usize;
    if length == 0 || length > max {
        return Err(invalid(format!("Invalid native message length: {length}")));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).await.map_err(truncated)?;
    let text = std::str::from_utf8(&payload).map_err(|_| invalid("Invalid UTF-8"))?;
    // Opaque values stay raw: preserve escaped UTF-16, numeric literals and deeply
    // nested extension data without reinterpreting them as Rust application data.
    let raw: &RawValue = serde_json::from_str(text).map_err(|_| invalid("Invalid JSON"))?;
    if !raw.get().starts_with('{') {
        return Ok(Some(None));
    }
    let envelope = serde_json::from_str(raw.get()).map_err(|_| invalid("Invalid JSON object"))?;
    Ok(Some(Some(envelope)))
}

fn truncated(error: io::Error) -> io::Error {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        invalid("Truncated native message")
    } else {
        error
    }
}

pub fn encode(message: &Envelope, max: usize) -> io::Result<Arc<Vec<u8>>> {
    let payload = serde_json::to_vec(message).map_err(|_| invalid("Cannot encode JSON"))?;
    if payload.len() > max {
        return Err(invalid(format!("Native message exceeds {max} bytes")));
    }
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&(payload.len() as u32).to_ne_bytes());
    frame.extend_from_slice(&payload);
    Ok(Arc::new(frame))
}

pub fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.to_owned()).expect("internally generated JSON")
}

pub fn is_rpc(message: &Envelope) -> bool {
    message
        .get("jsonrpc")
        .is_some_and(|v| serde_json::from_str::<String>(v.get()).ok().as_deref() == Some("2.0"))
}

pub fn is_string(value: &RawValue) -> bool {
    value.get().starts_with('"')
}

pub fn valid_id(value: &RawValue) -> bool {
    value.get() == "null" || is_string(value) || number(value).is_some()
}

fn number(value: &RawValue) -> Option<f64> {
    serde_json::from_str::<f64>(value.get())
        .ok()
        .filter(|n| n.is_finite())
}

pub fn request(message: &Envelope) -> bool {
    is_rpc(message)
        && message.get("method").is_some_and(|v| is_string(v))
        && message.get("id").is_none_or(|v| valid_id(v))
        && message
            .get("params")
            .is_none_or(|v| v.get().starts_with('{') || v.get().starts_with('['))
}

pub fn response(message: &Envelope) -> bool {
    if !is_rpc(message) || !message.get("id").is_some_and(|v| valid_id(v)) {
        return false;
    }
    match (message.get("result"), message.get("error")) {
        (Some(_), None) => true,
        (None, Some(error)) => {
            let Ok(error) = serde_json::from_str::<Envelope>(error.get()) else {
                return false;
            };
            error
                .get("code")
                .and_then(|v| number(v))
                .is_some_and(|n| n.fract() == 0.0)
                && error.get("message").is_some_and(|v| is_string(v))
        }
        _ => false,
    }
}

pub fn host_id(value: &RawValue) -> Option<u64> {
    // JavaScript Map distinguishes the string "1" from the number 1, but not 1.0.
    let n = number(value)?;
    ((1.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0).then_some(n as u64)
}

pub fn invalid_request(message: Option<&Envelope>) -> Envelope {
    let id = message
        .filter(|m| is_rpc(m))
        .and_then(|m| m.get("id"))
        .filter(|v| valid_id(v))
        .cloned()
        .unwrap_or_else(|| raw("null"));
    BTreeMap::from([
        ("jsonrpc".into(), raw("\"2.0\"")),
        ("id".into(), id),
        (
            "error".into(),
            raw("{\"code\":-32600,\"message\":\"Invalid Request\"}"),
        ),
    ])
}
