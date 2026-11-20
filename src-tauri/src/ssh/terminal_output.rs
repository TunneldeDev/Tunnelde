use std::collections::VecDeque;

// Keep ordinary background commands running without keeping a WebView alive.
// At the limit, stop consuming the SSH channel rather than drop ANSI/UTF-8 bytes.
pub(super) const MAX_BUFFERED_OUTPUT: usize = 4 * 1024 * 1024;

pub(super) struct TerminalOutput {
    attached: bool,
    started: bool,
    sequence: u64,
    buffered: VecDeque<Vec<u8>>,
    buffered_bytes: usize,
}

impl TerminalOutput {
    pub fn new(startup: Vec<u8>) -> Self {
        let buffered_bytes = startup.len();
        let mut buffered = VecDeque::new();
        if !startup.is_empty() {
            buffered.push_back(startup);
        }
        Self {
            attached: false,
            started: false,
            sequence: 0,
            buffered,
            buffered_bytes,
        }
    }

    pub fn can_read(&self) -> bool {
        self.started && (self.attached || self.buffered_bytes < MAX_BUFFERED_OUTPUT)
    }

    pub fn attached(&self) -> bool {
        self.attached
    }

    pub fn detach(&mut self) -> u64 {
        self.attached = false;
        self.sequence
    }

    pub fn attach(&mut self, emit: &mut impl FnMut(u64, &[u8])) {
        self.try_attach(&mut |sequence, bytes| {
            emit(sequence, bytes);
            true
        });
    }

    /// A revoked window or failed delivery is backpressure, never dropped bytes.
    pub fn try_attach(&mut self, emit: &mut impl FnMut(u64, &[u8]) -> bool) {
        if self.attached {
            return;
        }
        self.attached = true;
        self.started = true;
        while let Some(bytes) = self.buffered.pop_front() {
            if !emit(self.sequence + 1, &bytes) {
                self.buffered.push_front(bytes);
                self.attached = false;
                break;
            }
            self.sequence += 1;
            self.buffered_bytes -= bytes.len();
        }
    }

    #[cfg(test)]
    pub fn receive(&mut self, bytes: &[u8], emit: &mut impl FnMut(u64, &[u8])) {
        self.try_receive(bytes, &mut |sequence, bytes| {
            emit(sequence, bytes);
            true
        });
    }

    pub fn try_receive(&mut self, bytes: &[u8], emit: &mut impl FnMut(u64, &[u8]) -> bool) {
        if bytes.is_empty() {
            return;
        }
        if self.attached && emit(self.sequence + 1, bytes) {
            self.sequence += 1;
        } else {
            self.attached = false;
            self.buffered_bytes += bytes.len();
            self.buffered.push_back(bytes.to_vec());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detach_is_an_emission_barrier_and_attach_replays_exact_bytes_once() {
        let mut output = TerminalOutput::new(b"\x1b[32mready".to_vec());
        let mut received = Vec::new();
        let mut emit = |sequence, bytes: &[u8]| received.push((sequence, bytes.to_vec()));
        assert!(!output.can_read());
        assert_eq!(output.detach(), 0);
        output.attach(&mut emit);
        output.receive(&[0xe4, 0xb8], &mut emit);
        assert_eq!(output.detach(), 2);
        output.receive(&[0xad, 0x1b, b'['], &mut emit);
        output.receive(b"0m\r\nbackground finished", &mut emit);
        assert_eq!(output.detach(), 2);
        output.attach(&mut emit);
        output.attach(&mut emit);
        assert!(output.buffered.is_empty());
        assert_eq!(output.buffered_bytes, 0);
        assert_eq!(received.len(), 4);
        assert_eq!(
            received.iter().map(|item| item.0).collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
        assert_eq!(
            received
                .into_iter()
                .flat_map(|(_, bytes)| bytes)
                .collect::<Vec<_>>(),
            "\x1b[32mready中\x1b[0m\r\nbackground finished".as_bytes()
        );
    }

    #[test]
    fn a_full_detached_buffer_applies_backpressure_and_resume_releases_it() {
        let mut output = TerminalOutput::new(Vec::new());
        output.attach(&mut |_, _| {});
        output.detach();
        let packet = vec![b'x'; 32768];
        let mut packets = 0;
        while output.can_read() {
            output.receive(&packet, &mut |_, _| panic!("detached output must not emit"));
            packets += 1;
        }
        assert_eq!(output.buffered_bytes, MAX_BUFFERED_OUTPUT);
        let mut replayed = 0;
        output.attach(&mut |sequence, bytes| {
            replayed += 1;
            assert_eq!(sequence, replayed);
            assert_eq!(bytes, packet);
        });
        assert_eq!(replayed, packets);
        assert!(output.can_read());
    }
    #[test]
    fn revoked_or_failed_sink_preserves_sequence_and_exact_bytes_for_a_new_owner() {
        let mut output = TerminalOutput::new(b"prompt".to_vec());
        let mut delivered = Vec::new();
        output.try_attach(&mut |sequence, bytes| {
            delivered.push((sequence, bytes.to_vec()));
            true
        });
        assert_eq!(output.detach(), 1);
        output.try_receive(&[0xe4, 0xb8], &mut |_, _| panic!("detached"));
        output.try_receive(&[0xad, 0x1b], &mut |_, _| panic!("detached"));
        let mut attempts = 0;
        output.try_attach(&mut |sequence, bytes| {
            attempts += 1;
            if attempts == 1 {
                delivered.push((sequence, bytes.to_vec()));
                true
            } else {
                false
            }
        });
        assert!(!output.attached());
        assert_eq!(output.detach(), 2);
        output.try_receive(b"[0m", &mut |_, _| {
            panic!("failed sink must remain detached")
        });
        output.try_attach(&mut |sequence, bytes| {
            delivered.push((sequence, bytes.to_vec()));
            true
        });
        assert_eq!(
            delivered,
            vec![
                (1, b"prompt".to_vec()),
                (2, vec![0xe4, 0xb8]),
                (3, vec![0xad, 0x1b]),
                (4, b"[0m".to_vec())
            ]
        );
        assert_eq!(output.buffered_bytes, 0);
        output.try_receive(b"late", &mut |_, _| false);
        assert_eq!(output.detach(), 4);
        assert_eq!(output.buffered_bytes, 4);
        output.try_attach(&mut |sequence, bytes| {
            assert_eq!((sequence, bytes), (5, b"late".as_slice()));
            true
        });
        assert_eq!(output.buffered_bytes, 0);
    }
}
