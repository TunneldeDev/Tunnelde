//! Bounded local-protocol client, independent of CLI parsing or desktop UI.
mod deadline;
use super::contract::*;
use serde_json::Value;
use std::{
    io::{BufRead, Read, Write},
    net::TcpStream,
    time::Duration,
};

fn network(error: std::io::Error) -> Failure {
    match error.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
            Failure::new("timeout", "Local API request timed out")
        }
        _ => Failure::new(
            "unavailable",
            "Cannot contact the running application; restart it or select its endpoint",
        ),
    }
}

pub(super) fn exchange(
    endpoint: Endpoint,
    method: String,
    params: Value,
) -> Result<Response, Failure> {
    let stream =
        TcpStream::connect_timeout(&endpoint.address, Duration::from_secs(3)).map_err(network)?;
    let budget = exchange_budget(&method);
    exchange_stream(stream, endpoint.token, method, params, budget)
}

fn exchange_stream(
    stream: TcpStream,
    token: String,
    method: String,
    params: Value,
    budget: Duration,
) -> Result<Response, Failure> {
    let mut stream = deadline::Stream::new(stream, budget);
    let id = uuid::Uuid::new_v4().to_string();
    let request = Request {
        version: VERSION,
        id: id.clone(),
        token,
        method,
        params,
    };
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| Failure::new("invalid_request", "Cannot encode request"))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_REQUEST {
        return Err(Failure::new(
            "invalid_request",
            "Request exceeds 32 KiB limit",
        ));
    }
    stream.write_all(&bytes).map_err(network)?;
    let mut bytes = Vec::new();
    std::io::BufReader::new(stream)
        .take((MAX_RESPONSE + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(network)?;
    if bytes.is_empty() {
        return Err(Failure::new(
            "unavailable",
            "The application closed the connection without a response; it may be busy or shutting down",
        ));
    }
    if bytes.len() > MAX_RESPONSE || bytes.last() != Some(&b'\n') {
        return Err(Failure::new(
            "invalid_response",
            "Invalid local API response length or framing",
        ));
    }
    let response: Response = serde_json::from_slice(&bytes)
        .map_err(|_| Failure::new("invalid_response", "Malformed local API response"))?;
    if response.version != VERSION || response.id != id {
        return Err(Failure::new(
            "invalid_response",
            "Local API response does not match the request",
        ));
    }
    Ok(response)
}

#[cfg(test)]
mod tests;
