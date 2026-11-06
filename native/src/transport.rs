use std::{io, path::Path};

#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;
#[cfg(windows)]
pub use platform::Stream;

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{
        fs,
        os::{
            fd::AsRawFd,
            unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        },
        path::PathBuf,
        time::Duration,
    };
    use tokio::{
        net::{UnixListener, UnixStream},
        time::timeout,
    };

    pub struct Listener {
        inner: UnixListener,
        path: PathBuf,
        identity: fs::Metadata,
        _lock: fs::File,
    }

    fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
        a.dev() == b.dev() && a.ino() == b.ino() && a.uid() == b.uid() && b.file_type().is_socket()
    }

    fn owned_socket(path: &Path) -> io::Result<fs::Metadata> {
        let stat = fs::symlink_metadata(path)?;
        // SAFETY: geteuid has no arguments or side effects.
        if !stat.file_type().is_socket() || stat.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "EADDRINUSE: path is not an owned socket",
            ));
        }
        Ok(stat)
    }

    fn host_lock(path: &Path) -> io::Result<fs::File> {
        let mut name = path.as_os_str().to_owned();
        name.push(".lock");
        // Never truncate/unlink an existing lock, or follow a symlink. Keeping the
        // inode after shutdown avoids two processes locking different new files.
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(name)?;
        let stat = file.metadata()?;
        // SAFETY: geteuid has no side effects; flock uses a live file descriptor.
        if !stat.is_file() || stat.nlink() != 1 || stat.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "EADDRINUSE: unsafe host lock",
            ));
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "EADDRINUSE: host lock held",
            ));
        }
        Ok(file)
    }

    impl Listener {
        pub async fn bind(path: &Path) -> io::Result<Self> {
            let lock = host_lock(path)?;
            let inner = match UnixListener::bind(path) {
                Ok(listener) => listener,
                Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                    let before = owned_socket(path)?;
                    match timeout(Duration::from_millis(500), UnixStream::connect(path)).await {
                        Ok(Err(e))
                            if matches!(
                                e.kind(),
                                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                            ) => {}
                        _ => {
                            return Err(io::Error::new(
                                io::ErrorKind::AddrInUse,
                                "EADDRINUSE: active or unresponsive host",
                            ))
                        }
                    }
                    let current = owned_socket(path)?;
                    if !same(&before, &current) {
                        return Err(io::Error::new(
                            io::ErrorKind::AddrInUse,
                            "EADDRINUSE: socket changed while probing",
                        ));
                    }
                    fs::remove_file(path)?;
                    UnixListener::bind(path)?
                }
                Err(error) => return Err(error),
            };
            let identity = owned_socket(path)?;
            let listener = Self {
                inner,
                path: path.to_owned(),
                identity,
                _lock: lock,
            };
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            Ok(listener)
        }

        pub async fn accept(&mut self) -> io::Result<Stream> {
            self.inner.accept().await.map(|(stream, _)| stream)
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            if fs::symlink_metadata(&self.path).is_ok_and(|stat| same(&self.identity, &stat)) {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        path::PathBuf,
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::{
        io::{AsyncRead, AsyncWrite, ReadBuf},
        net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    };

    // Mio accepts an entire slice as soon as it queues an overlapped write.
    // Bound that hidden copy, and keep the host's packet permits until the last
    // write has actually completed. NamedPipeServer::poll_flush is a no-op.
    const WRITE_CHUNK: usize = 64 * 1024;

    pub struct Stream {
        inner: NamedPipeServer,
        abort_on_drop: bool,
    }

    impl AsyncRead for Stream {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for Stream {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.inner).poll_write(cx, &buf[..buf.len().min(WRITE_CHUNK)])
        }

        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            // A zero-byte write adds no bytes to this byte-mode pipe. Mio will
            // accept it only after the previous overlapped write finishes, or
            // return its error. Polling writable alone can observe stale readiness.
            Pin::new(&mut self.inner).poll_write(cx, &[]).map_ok(|_| ())
        }

        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            match self.as_mut().poll_flush(cx) {
                Poll::Ready(Ok(())) => {
                    // A completed drain closes normally. DisconnectNamedPipe
                    // discards unread data, so reserve it for aborted output.
                    self.abort_on_drop = false;
                    Poll::Ready(Ok(()))
                }
                result => result,
            }
        }
    }

    impl Drop for Stream {
        fn drop(&mut self) {
            // Mio deliberately leaves pending writes alive on drop. Disconnect
            // first so a timed-out/aborted client cannot retain the pipe/buffer.
            if self.abort_on_drop {
                let _ = self.inner.disconnect();
            }
        }
    }

    pub struct Listener {
        pending: NamedPipeServer,
        path: PathBuf,
    }

    impl Listener {
        pub async fn bind(path: &Path) -> io::Result<Self> {
            let pending = ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(path)
                .map_err(|error| {
                    if error.kind() == io::ErrorKind::PermissionDenied {
                        io::Error::new(
                            error.kind(),
                            format!("EADDRINUSE: cannot acquire named pipe: {error}"),
                        )
                    } else {
                        error
                    }
                })?;
            Ok(Self {
                pending,
                path: path.to_owned(),
            })
        }

        pub async fn accept(&mut self) -> io::Result<Stream> {
            self.pending.connect().await?;
            // Keep at least one handle alive so another host cannot claim the name.
            let next = ServerOptions::new()
                .reject_remote_clients(true)
                .create(&self.path)?;
            Ok(Stream {
                inner: std::mem::replace(&mut self.pending, next),
                abort_on_drop: true,
            })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::windows::named_pipe::{ClientOptions, NamedPipeClient},
            time::{timeout, Duration},
        };

        async fn pair() -> (PathBuf, Stream, NamedPipeClient) {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = PathBuf::from(format!(
                r"\\.\pipe\blade-transport-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let mut listener = Listener::bind(&path).await.unwrap();
            let peer = ClientOptions::new().open(&path).unwrap();
            let stream = listener.accept().await.unwrap();
            drop(listener);
            (path, stream, peer)
        }

        #[tokio::test(flavor = "current_thread")]
        async fn completion_fence_waits_for_pending_write_and_observes_broken_peer() {
            let (_, mut stream, peer) = pair().await;
            // Deliberately use the underlying adapter to recreate Mio's early
            // acceptance of a single large pending overlapped write.
            stream
                .inner
                .write_all(&vec![1; 2 * 1024 * 1024])
                .await
                .unwrap();
            assert!(timeout(Duration::from_millis(20), stream.flush())
                .await
                .is_err());
            drop(peer);
            assert!(timeout(Duration::from_secs(1), stream.flush())
                .await
                .unwrap()
                .is_err());
        }

        #[tokio::test(flavor = "current_thread")]
        async fn each_transport_copy_is_bounded_to_one_chunk() {
            let (_, mut stream, _unread_peer) = pair().await;
            let count = stream.write(&vec![1; 2 * 1024 * 1024]).await.unwrap();
            assert_eq!(count, WRITE_CHUNK);
        }

        #[tokio::test(flavor = "current_thread")]
        async fn abort_discards_pending_output_before_the_peer_resumes() {
            let (_, mut stream, mut peer) = pair().await;
            let size = 2 * 1024 * 1024;
            stream.inner.write_all(&vec![1; size]).await.unwrap();
            drop(stream);
            // No reads until after cancellation. Letting the entire queued frame
            // drain would mask Mio's default behavior of retaining pending writes.
            let mut received = Vec::new();
            if let Err(error) = timeout(Duration::from_secs(1), peer.read_to_end(&mut received))
                .await
                .unwrap()
            {
                assert!(matches!(
                    error.kind(),
                    io::ErrorKind::BrokenPipe
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::NotConnected
                ));
            }
            assert!(
                received.len() < size,
                "aborted write was still delivered in full"
            );
        }

        #[tokio::test(flavor = "current_thread")]
        async fn graceful_shutdown_preserves_the_last_bytes() {
            let (_, mut stream, mut peer) = pair().await;
            let expected = vec![7; 2 * 1024 * 1024];
            let bytes = expected.clone();
            let task = tokio::spawn(async move {
                stream.write_all(&bytes).await.unwrap();
                stream.shutdown().await.unwrap();
            });
            let mut received = Vec::new();
            timeout(Duration::from_secs(2), peer.read_to_end(&mut received))
                .await
                .unwrap()
                .unwrap();
            task.await.unwrap();
            assert_eq!(received, expected);
        }
    }
}

pub use platform::Listener;
