//! Socket inactivity alone cannot bound a peer that keeps sending partial JSON.
use std::{
    io::{self, Read, Write},
    net::TcpStream,
    time::{Duration, Instant},
};

pub(super) struct Stream {
    socket: TcpStream,
    deadline: Instant,
}

impl Stream {
    pub fn new(socket: TcpStream, budget: Duration) -> Self {
        Self {
            socket,
            deadline: Instant::now() + budget,
        }
    }

    fn remaining(&self) -> io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::ErrorKind::TimedOut.into())
    }
}

impl Read for Stream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.socket.set_read_timeout(Some(self.remaining()?))?;
        self.socket.read(bytes)
    }
}

impl Write for Stream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.socket
            .set_write_timeout(Some(self.remaining()?.min(Duration::from_secs(3))))?;
        self.socket.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.remaining()?;
        self.socket.flush()
    }
}
