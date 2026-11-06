mod protocol;
mod transport;

use protocol::{encode, invalid, read_frame, Envelope, MAX_EXTENSION, MAX_HOST};
use serde_json::value::RawValue;
use std::{
    collections::{HashMap, HashSet},
    io,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
    time::timeout,
};

const MAX_CLIENTS: usize = 32;
const MAX_PENDING_PER_CLIENT: usize = 1024;
const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;

enum Event {
    Message(u64, Option<Envelope>),
    End(u64, io::Result<()>),
    WriteError(u64, io::Error),
}

struct Packet {
    bytes: Arc<Vec<u8>>,
    _local: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

struct Outbox {
    sender: mpsc::Sender<Packet>,
    local: Arc<Semaphore>,
    global: Arc<Semaphore>,
}

impl Outbox {
    fn send(&self, bytes: Arc<Vec<u8>>) -> io::Result<()> {
        let len = bytes.len() as u32;
        let local = self
            .local
            .clone()
            .try_acquire_many_owned(len)
            .map_err(|_| invalid("Output byte budget exceeded"))?;
        let global = self
            .global
            .clone()
            .try_acquire_many_owned(len)
            .map_err(|_| invalid("Global output byte budget exceeded"))?;
        self.sender
            .try_send(Packet {
                bytes,
                _local: local,
                _global: global,
            })
            .map_err(|_| invalid("Output queue full or disconnected"))
    }
}

fn writer<W: AsyncWrite + Unpin + Send + 'static>(
    mut output: W,
    id: u64,
    events: mpsc::Sender<Event>,
    global: Arc<Semaphore>,
    budget: usize,
    deadline: Duration,
) -> (Outbox, JoinHandle<()>) {
    let (sender, mut receiver) = mpsc::channel::<Packet>(8);
    let outbox = Outbox {
        sender,
        local: Arc::new(Semaphore::new(budget)),
        global,
    };
    let task = tokio::spawn(async move {
        while let Some(packet) = receiver.recv().await {
            // Flush matters for Tokio's blocking stdout adapter; write_all alone
            // can return before the final blocking write completes or fails.
            let write = async {
                output.write_all(&packet.bytes).await?;
                output.flush().await
            };
            let result = timeout(deadline, write).await.unwrap_or_else(|_| {
                Err(io::Error::new(io::ErrorKind::TimedOut, "Write timed out"))
            });
            if let Err(error) = result {
                let _ = events.send(Event::WriteError(id, error)).await;
                return;
            }
        }
    });
    (outbox, task)
}

fn reader<R: AsyncRead + Unpin + Send + 'static>(
    mut input: R,
    id: u64,
    max: usize,
    events: mpsc::Sender<Event>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match read_frame(&mut input, max).await {
                Ok(Some(message)) => {
                    if events.send(Event::Message(id, message)).await.is_err() {
                        return;
                    }
                }
                result => {
                    let _ = events.send(Event::End(id, result.map(|_| ()))).await;
                    return;
                }
            }
        }
    })
}

struct Client {
    output: Outbox,
    tasks: [JoinHandle<()>; 2],
    requests: HashSet<u64>,
}

impl Drop for Client {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

struct Pending {
    client: u64,
    original: Box<RawValue>,
    _id_budget: OwnedSemaphorePermit,
}

struct Router {
    clients: HashMap<u64, Client>,
    pending: HashMap<u64, Pending>,
    next_request: u64,
    chrome: Outbox,
    id_budget: Arc<Semaphore>,
}

impl Router {
    fn disconnect(&mut self, id: u64) {
        if let Some(client) = self.clients.remove(&id) {
            for request in &client.requests {
                self.pending.remove(request);
            }
        }
    }

    fn handle_client(&mut self, id: u64, message: Option<Envelope>) {
        if !self.clients.contains_key(&id) {
            return;
        }
        let result = self.forward_client(id, message);
        if result.is_err() {
            self.disconnect(id);
        }
    }

    fn forward_client(&mut self, id: u64, message: Option<Envelope>) -> io::Result<()> {
        let Some(mut message) = message.filter(protocol::request) else {
            return Err(invalid("Invalid request dispatch"));
        };
        let original = message.remove("id");
        let wire_id = self.next_request;
        if let Some(original) = original {
            if wire_id > MAX_SAFE_ID || self.clients[&id].requests.len() >= MAX_PENDING_PER_CLIENT {
                return Err(invalid("Too many pending requests"));
            }
            message.insert("id".into(), protocol::raw(&wire_id.to_string()));
            let id_budget = self
                .id_budget
                .clone()
                .try_acquire_many_owned(original.get().len() as u32)
                .map_err(|_| invalid("Pending request ID byte budget exceeded"))?;
            self.chrome.send(encode(&message, MAX_HOST)?)?;
            self.next_request += 1;
            self.pending.insert(
                wire_id,
                Pending {
                    client: id,
                    original,
                    _id_budget: id_budget,
                },
            );
            self.clients.get_mut(&id).unwrap().requests.insert(wire_id);
        } else {
            self.chrome.send(encode(&message, MAX_HOST)?)?;
        }
        Ok(())
    }

    fn handle_chrome(&mut self, message: Option<Envelope>) -> io::Result<()> {
        let Some(mut message) = message.filter(protocol::is_rpc) else {
            return Err(invalid("Invalid native message"));
        };
        if let Some(id) = message.get("id") {
            if !protocol::response(&message) {
                return Err(invalid("Invalid native response"));
            }
            let Some(id) = protocol::host_id(id) else {
                return Ok(());
            };
            let Some(pending) = self.pending.remove(&id) else {
                return Ok(());
            };
            let Some(client) = self.clients.get_mut(&pending.client) else {
                return Ok(());
            };
            client.requests.remove(&id);
            message.insert("id".into(), pending.original);
            let result =
                encode(&message, MAX_EXTENSION).and_then(|frame| client.output.send(frame));
            if result.is_err() {
                self.disconnect(pending.client);
            }
        } else if message
            .get("method")
            .is_some_and(|v| protocol::is_string(v))
        {
            let frame = encode(&message, MAX_EXTENSION)?;
            let failed: Vec<_> = self
                .clients
                .iter()
                .filter_map(|(&id, client)| client.output.send(frame.clone()).err().map(|_| id))
                .collect();
            for id in failed {
                self.disconnect(id);
            }
        } else {
            return Err(invalid("Invalid native notification"));
        }
        Ok(())
    }
}

async fn stop_signal() -> io::Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        Ok(())
    }
    #[cfg(windows)]
    {
        tokio::signal::ctrl_c().await
    }
}

async fn run(socket: PathBuf, deadline: Duration) -> io::Result<()> {
    let mut listener = transport::Listener::bind(&socket).await?;
    let (events, mut incoming) = mpsc::channel(4);
    let global = Arc::new(Semaphore::new(128 * MAX_HOST));
    let (chrome, chrome_writer) = writer(
        tokio::io::stdout(),
        0,
        events.clone(),
        global.clone(),
        4 * MAX_HOST,
        deadline,
    );
    let chrome_reader = reader(tokio::io::stdin(), 0, MAX_EXTENSION, events.clone());
    let mut router = Router {
        clients: HashMap::new(),
        pending: HashMap::new(),
        next_request: 1,
        chrome,
        id_budget: Arc::new(Semaphore::new(16 * MAX_HOST)),
    };
    let mut next_client = 1_u64;
    let signal = stop_signal();
    tokio::pin!(signal);
    let result = loop {
        tokio::select! {
            result = &mut signal => break result,
            accepted = listener.accept() => {
                let stream = match accepted { Ok(stream) => stream, Err(error) => break Err(error) };
                if router.clients.len() >= MAX_CLIENTS { continue; }
                let id = next_client;
                next_client = match next_client.checked_add(1) {
                    Some(next) => next, None => break Err(invalid("Client ID space exhausted")),
                };
                let (input, output) = tokio::io::split(stream);
                let (output, writer) = writer(output, id, events.clone(), global.clone(), MAX_EXTENSION + 4, deadline);
                let reader = reader(input, id, MAX_HOST, events.clone());
                router.clients.insert(id, Client { output, tasks: [reader, writer], requests: HashSet::new() });
            }
            event = incoming.recv() => match event {
                Some(Event::Message(0, message)) => {
                    if let Err(error) = router.handle_chrome(message) { break Err(error); }
                }
                Some(Event::Message(id, message)) => {
                    if !message.as_ref().is_some_and(protocol::request) {
                        if let Some(client) = router.clients.get(&id) {
                            let result = encode(&protocol::invalid_request(message.as_ref()), MAX_EXTENSION)
                                .and_then(|frame| client.output.send(frame));
                            if result.is_err() { router.disconnect(id); }
                        }
                    } else { router.handle_client(id, message); }
                }
                Some(Event::End(0, result)) => break result,
                Some(Event::WriteError(0, error)) => break Err(error),
                Some(Event::End(id, _)) | Some(Event::WriteError(id, _)) => router.disconnect(id),
                None => break Ok(()),
            }
        }
    };
    router.clients.clear();
    chrome_reader.abort();
    chrome_writer.abort();
    drop(listener);
    result
}

fn options() -> io::Result<(PathBuf, Duration)> {
    let mut args = std::env::args_os().skip(1);
    let mut socket = None;
    let mut deadline = Duration::from_secs(10);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--socket") => socket = args.next().map(PathBuf::from),
            Some("--write-timeout-ms") => {
                let ms = args
                    .next()
                    .and_then(|s| s.to_str().and_then(|s| s.parse::<u64>().ok()))
                    .filter(|ms| *ms > 0 && *ms <= 600_000)
                    .ok_or_else(|| invalid("Invalid write timeout"))?;
                deadline = Duration::from_millis(ms);
            }
            _ => return Err(invalid("Unknown host option")),
        }
    }
    Ok((socket.ok_or_else(|| invalid("Missing --socket"))?, deadline))
}

fn main() {
    // SAFETY: done once, before creating any runtime/blocking threads. Restrict
    // permissions at bind time, rather than leaving a chmod exposure window.
    #[cfg(unix)]
    unsafe {
        libc::umask(0o077);
    }
    let result = options().and_then(|(socket, deadline)| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(run(socket, deadline));
        // stdin/stdout use blocking adapters that cannot cancel a pending OS read
        // or write. Bound runtime teardown after closing clients/the listener.
        runtime.shutdown_timeout(Duration::from_millis(50));
        result
    });
    if let Err(error) = result {
        eprintln!("Blade host: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    fn envelope(text: &str) -> Envelope {
        serde_json::from_str(text).unwrap()
    }

    fn outbox(local: usize, global: Arc<Semaphore>) -> (Outbox, mpsc::Receiver<Packet>) {
        let (sender, receiver) = mpsc::channel(8);
        (
            Outbox {
                sender,
                local: Arc::new(Semaphore::new(local)),
                global,
            },
            receiver,
        )
    }

    #[test]
    fn ids_and_envelopes_match_javascript_rpc_rules() {
        for id in ["null", "1", "1.0", "-1.5", "\"abc\"", "\"\\ud800\""] {
            assert!(protocol::valid_id(&protocol::raw(id)), "{id}");
        }
        for id in ["true", "{}", "[]", "1e400"] {
            assert!(!protocol::valid_id(&protocol::raw(id)), "{id}");
        }
        assert_eq!(protocol::host_id(&protocol::raw("1.0")), Some(1));
        assert_eq!(protocol::host_id(&protocol::raw("\"1\"")), None);
        assert!(protocol::request(&envelope(
            r#"{"jsonrpc":"2.0","method":"ping","params":[]}"#
        )));
        for text in [
            r#"{"method":"ping"}"#,
            r#"{"jsonrpc":"2.0","method":"ping","params":null}"#,
            r#"{"jsonrpc":"2.0","id":true,"method":"ping"}"#,
        ] {
            assert!(!protocol::request(&envelope(text)));
        }
    }

    #[test]
    fn response_validation_requires_exactly_one_result_or_valid_error() {
        for text in [
            r#"{"jsonrpc":"2.0","id":1,"result":null}"#,
            r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32000.0,"message":"oops"}}"#,
        ] {
            assert!(protocol::response(&envelope(text)));
        }
        for text in [
            r#"{"jsonrpc":"2.0","id":1}"#,
            r#"{"jsonrpc":"2.0","id":1,"result":1,"error":{}}"#,
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":1.5,"message":"oops"}}"#,
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":null}}"#,
        ] {
            assert!(!protocol::response(&envelope(text)));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn framing_handles_each_header_payload_split_and_coalescing() {
        let expected = envelope(r#"{"jsonrpc":"2.0","method":"🌍"}"#);
        let frame = encode(&expected, MAX_HOST).unwrap();
        for split in 1..frame.len() {
            let (mut a, mut b) = tokio::io::duplex(1);
            let frame = frame.clone();
            let task = tokio::spawn(async move {
                a.write_all(&frame[..split]).await.unwrap();
                tokio::task::yield_now().await;
                a.write_all(&frame[split..]).await.unwrap();
                a.write_all(&frame).await.unwrap();
            });
            for _ in 0..2 {
                let message = read_frame(&mut b, MAX_HOST)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    serde_json::to_string(&message).unwrap(),
                    serde_json::to_string(&expected).unwrap()
                );
            }
            task.await.unwrap();
            assert!(read_frame(&mut b, MAX_HOST).await.unwrap().is_none());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn headers_enforce_zero_and_directional_limits_before_payload_allocation() {
        for max in [MAX_HOST, MAX_EXTENSION] {
            for size in [0, max + 1] {
                let header = (size as u32).to_ne_bytes();
                let error = read_frame(&mut &header[..], max).await.unwrap_err();
                assert!(error.to_string().contains("Invalid native message length"));
            }
        }
        let message = envelope(r#"{"x":1}"#);
        let frame = encode(&message, 7).unwrap();
        assert!(read_frame(&mut &frame[..], 7).await.is_ok());
        assert!(encode(&message, 6).is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn eof_distinguishes_clean_end_from_truncated_header_and_payload() {
        assert!(read_frame(&mut &b""[..], MAX_HOST).await.unwrap().is_none());
        let frame = encode(&envelope(r#"{"x":1}"#), MAX_HOST).unwrap();
        for end in 1..frame.len() {
            let error = read_frame(&mut &frame[..end], MAX_HOST).await.unwrap_err();
            assert_eq!(error.to_string(), "Truncated native message");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn strict_utf8_json_rejects_corruption_and_trailing_values() {
        for payload in [
            &b"!"[..],
            &b"\"\xff\""[..],
            &b"{} {}"[..],
            &b"\xef\xbb\xbf{}"[..],
        ] {
            let mut bytes = (payload.len() as u32).to_ne_bytes().to_vec();
            bytes.extend_from_slice(payload);
            assert!(read_frame(&mut &bytes[..], MAX_HOST).await.is_err());
        }
    }

    #[test]
    fn bounded_output_returns_byte_permits_on_failure_and_drop() {
        let global = Arc::new(Semaphore::new(10));
        let (a, mut receiver) = outbox(8, global.clone());
        a.send(Arc::new(vec![0; 8])).unwrap();
        assert!(a.send(Arc::new(vec![0; 1])).is_err());
        let (b, _) = outbox(8, global.clone());
        assert!(b.send(Arc::new(vec![0; 3])).is_err());
        assert_eq!(
            b.local.available_permits(),
            8,
            "failed enqueue must refund local permits"
        );
        drop(receiver.try_recv().unwrap());
        assert_eq!(global.available_permits(), 10);
        drop(receiver);
        assert!(a.send(Arc::new(vec![0; 8])).is_err());
        assert_eq!(global.available_permits(), 10);
        assert_eq!(a.local.available_permits(), 8);
    }

    #[test]
    fn bounded_output_limits_message_count_even_for_tiny_frames() {
        let global = Arc::new(Semaphore::new(100));
        let (output, receiver) = outbox(100, global.clone());
        for _ in 0..8 {
            output.send(Arc::new(vec![0])).unwrap();
        }
        assert!(output.send(Arc::new(vec![0])).is_err());
        assert_eq!(global.available_permits(), 92);
        drop(receiver);
        assert_eq!(global.available_permits(), 100);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stalled_writer_times_out_and_releases_output_budget() {
        let (output, _unread_peer) = tokio::io::duplex(1);
        let (events, mut receiver) = mpsc::channel(4);
        let global = Arc::new(Semaphore::new(64));
        let (output, task) = writer(
            output,
            9,
            events,
            global.clone(),
            64,
            Duration::from_millis(10),
        );
        output.send(Arc::new(vec![0; 32])).unwrap();
        match timeout(Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap()
        {
            Event::WriteError(9, error) => assert_eq!(error.kind(), io::ErrorKind::TimedOut),
            _ => panic!("expected writer timeout"),
        }
        task.await.unwrap();
        assert_eq!(global.available_permits(), 64);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn broken_writer_reports_error_instead_of_panicking() {
        let (output, peer) = tokio::io::duplex(1);
        drop(peer);
        let (events, mut receiver) = mpsc::channel(4);
        let (output, task) = writer(
            output,
            7,
            events,
            Arc::new(Semaphore::new(64)),
            64,
            Duration::from_secs(1),
        );
        output.send(Arc::new(vec![0; 32])).unwrap();
        assert!(matches!(
            receiver.recv().await,
            Some(Event::WriteError(7, _))
        ));
        task.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn request_id_exhaustion_and_pending_limits_fail_without_id_reuse() {
        let global = Arc::new(Semaphore::new(4096));
        let (chrome, mut chrome_rx) = outbox(4096, global.clone());
        let mut router = Router {
            clients: HashMap::new(),
            pending: HashMap::new(),
            next_request: MAX_SAFE_ID,
            chrome,
            id_budget: Arc::new(Semaphore::new(4096)),
        };
        let original_budget = router.id_budget.clone();
        let (output, _rx) = outbox(4096, global);
        router.clients.insert(
            1,
            Client {
                output,
                tasks: [
                    tokio::spawn(std::future::pending()),
                    tokio::spawn(std::future::pending()),
                ],
                requests: HashSet::new(),
            },
        );
        let request = || {
            Some(envelope(
                r#"{"jsonrpc":"2.0","id":"original","method":"ping"}"#,
            ))
        };
        router.forward_client(1, request()).unwrap();
        assert_eq!(router.pending.len(), 1);
        assert!(router.forward_client(1, request()).is_err());
        assert_eq!(router.pending.len(), 1);
        assert!(chrome_rx.try_recv().is_ok());
        assert!(chrome_rx.try_recv().is_err());
        router.next_request = 1;
        router.id_budget = Arc::new(Semaphore::new(2));
        assert!(
            router.forward_client(1, request()).is_err(),
            "oversized saved ID must be rejected before forwarding"
        );
        assert!(chrome_rx.try_recv().is_err());
        router.id_budget = Arc::new(Semaphore::new(4096));
        router.next_request = 1;
        router
            .clients
            .get_mut(&1)
            .unwrap()
            .requests
            .extend(1..MAX_PENDING_PER_CLIENT as u64);
        assert!(router.forward_client(1, request()).is_err());
        router.disconnect(1);
        assert!(router.pending.is_empty());
        assert_eq!(router.id_budget.available_permits(), 4096);
        assert_eq!(original_budget.available_permits(), 4096);
    }
}
