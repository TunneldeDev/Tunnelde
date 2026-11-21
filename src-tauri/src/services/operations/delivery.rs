//! A worker retains resource ownership until its caller accepts the result.
//! Dropping a detached worker's unreceived output must dispose its resource.
pub(crate) struct Delivery<T, Cleanup: FnOnce(&T)> {
    value: Option<T>,
    cleanup: Option<Cleanup>,
    lifetime: super::WorkLifetime,
}

impl<T, Cleanup: FnOnce(&T)> Delivery<T, Cleanup> {
    pub fn new(value: T, cleanup: Cleanup) -> Self {
        Self {
            value: Some(value),
            cleanup: Some(cleanup),
            lifetime: super::WorkLifetime::current(),
        }
    }

    pub fn accept(mut self) -> T {
        self.value.take().expect("delivery accepted once")
    }
}

impl<T, Cleanup: FnOnce(&T)> Drop for Delivery<T, Cleanup> {
    fn drop(&mut self) {
        if let (Some(value), Some(cleanup)) = (self.value.take(), self.cleanup.take()) {
            self.lifetime.clone().retirement().sync(|| cleanup(&value));
        }
    }
}

#[cfg(test)]
mod tests;
