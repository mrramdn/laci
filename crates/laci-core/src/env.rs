use crate::platform::{self, Dirs};
use std::path::PathBuf;

/// Locations owned by one installation, injectable for demos and tests.
#[derive(Debug, Clone)]
pub struct Env {
    pub home: PathBuf,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    /// One-run app overrides (`terminal`, `editor`, `files`), from LACI_TERMINAL, LACI_EDITOR and LACI_FILES.
    pub app_overrides: std::collections::HashMap<&'static str, String>,
    /// The installed Laci program: what an agent is told to run as its MCP server.
    pub program: PathBuf,
}

impl Env {
    pub fn for_home(home: PathBuf) -> Self {
        let Dirs { config, data, cache } = Dirs::inside(&home);
        Self {
            config_dir: config,
            data_dir: data,
            cache_dir: cache,
            app_overrides: Default::default(),
            program: PathBuf::from("laci"),
            home,
        }
    }

    pub fn from_process() -> crate::Result<Self> {
        let home = std::env::var_os("LACI_HOME")
            .map(PathBuf::from)
            .or_else(platform::home_dir)
            .filter(|p| p.is_absolute())
            .ok_or(if cfg!(windows) {
                "Set USERPROFILE to an absolute folder path"
            } else {
                "Set HOME to an absolute folder path"
            })?;
        // On macOS and Windows one folder has more than one spelling (/var is /private/var; a Windows folder can go by
        // a short 8.3 name), and the paths Laci reads from the disk come spelled as the disk spells them, so home is
        // spelled that way too. Linux keeps home as given, as it always has.
        #[cfg(not(target_os = "linux"))]
        let home = platform::path::canonical(&home)
            .map_err(|e| format!("Couldn't open the home folder {}: {e}", home.display()))?;
        let mut env = Self::for_home(home);
        // An AppImage runs from a mount that is gone when it closes; the file itself is what stays.
        if let Some(program) = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_file())
            .or_else(|| std::env::current_exe().ok())
        {
            env.program = program;
        }
        for (key, var) in [("terminal", "LACI_TERMINAL"), ("editor", "LACI_EDITOR"), ("files", "LACI_FILES")] {
            if let Some(v) = std::env::var(var).ok().filter(|s| !s.is_empty()) {
                env.app_overrides.insert(key, v);
            }
        }
        // LACI_HOME isolates a demo without changing the caller's HOME or XDG settings.
        if std::env::var_os("LACI_HOME").is_none() {
            let Dirs { config, data, cache } = platform::user_dirs(&env.home)?;
            (env.config_dir, env.data_dir, env.cache_dir) = (config, data, cache);
        }
        Ok(env)
    }
}
