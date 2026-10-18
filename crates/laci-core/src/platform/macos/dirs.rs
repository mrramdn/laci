//! Where Laci keeps its settings, data and cache on macOS: where it keeps them on Linux, so ~/.config/laci and the
//! other XDG folders hold the same files, and the README and agents name one place.
pub use crate::platform::unix::user_dirs;
