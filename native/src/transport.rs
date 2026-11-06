use std::{io, path::Path};

#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;
#[cfg(windows)]
pub type Stream = tokio::net::windows::named_pipe::NamedPipeServer;

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
    use std::path::PathBuf;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

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
            Ok(std::mem::replace(&mut self.pending, next))
        }
    }
}

pub use platform::Listener;
