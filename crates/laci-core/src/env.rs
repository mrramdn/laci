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
        Self {
            config_dir: home.join(".config/laci"),
            data_dir: home.join(".local/share/laci"),
            cache_dir: home.join(".cache/laci"),
            app_overrides: Default::default(),
            program: PathBuf::from("laci"),
            home,
        }
    }

    pub fn from_process() -> crate::Result<Self> {
        let home = std::env::var_os("LACI_HOME")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or("Set HOME to an absolute folder path")?;
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
            for (key, dest) in [("XDG_CONFIG_HOME", &mut env.config_dir), ("XDG_CACHE_HOME", &mut env.cache_dir)] {
                if let Some(base) = std::env::var_os(key).map(PathBuf::from).filter(|p| p.is_absolute()) {
                    *dest = base.join("laci");
                }
            }
        }
        Ok(env)
    }
}
