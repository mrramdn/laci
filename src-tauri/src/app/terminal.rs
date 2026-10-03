use laci_core::Result;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
pub struct Info {
    pub id: String,
    pub cwd: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exited: Option<u32>,
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Output {
    Data { data: String },
    Exit { code: u32 },
}
struct Terminal {
    info: Info,
    recent: String,
    output: Option<Channel<Output>>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}
#[derive(Clone, Default)]
pub struct Terminals {
    tabs: Arc<Mutex<BTreeMap<String, Terminal>>>,
}
impl Terminals {
    pub fn open(&self, cwd: &Path, title: &str, command: Option<String>, run: bool) -> Result<Info> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "bash".into()));
        cmd.arg("-l");
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env_remove("ELECTRON_RUN_AS_NODE");
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let id = format!("{:x}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
        let info = Info { id: id.clone(), cwd: cwd.to_string_lossy().into_owned(), title: title.into(), exited: None };
        self.tabs.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            Terminal {
                info: info.clone(),
                recent: String::new(),
                output: None,
                writer,
                master: pair.master,
                killer: child.clone_killer(),
            },
        );
        let state = self.clone();
        let reading = id.clone();
        thread::spawn(move || {
            let mut bytes = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                let length = match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                pending.extend_from_slice(&bytes[..length]);
                // Keep a partial UTF-8 sequence until the next pty chunk arrives.
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) if e.error_len().is_none() => e.valid_up_to(),
                    Err(_) => pending.len(),
                };
                if valid == 0 {
                    continue;
                }
                let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                if let Ok(mut tabs) = state.tabs.lock() {
                    if let Some(tab) = tabs.get_mut(&reading) {
                        tab.recent.push_str(&text);
                        if tab.recent.len() > 256 * 1024 {
                            let mut cut = tab.recent.len() - 256 * 1024;
                            while !tab.recent.is_char_boundary(cut) {
                                cut += 1;
                            }
                            tab.recent.drain(..cut);
                        }
                        if tab.output.as_ref().is_some_and(|c| c.send(Output::Data { data: text }).is_err()) {
                            tab.output = None;
                        }
                    } else {
                        break;
                    }
                }
            }
        });
        let state = self.clone();
        let exiting = id.clone();
        thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            if let Ok(mut tabs) = state.tabs.lock()
                && let Some(t) = tabs.get_mut(&exiting)
            {
                t.info.exited = Some(code);
                if let Some(c) = &t.output {
                    let _ = c.send(Output::Exit { code });
                }
            }
        });
        if let Some(command) = command {
            let state = self.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(400));
                let _ = state.input(&id, &format!("{command}{}", if run { "\r" } else { "" }));
            });
        }
        Ok(info)
    }
    pub fn list(&self) -> Vec<Info> {
        self.tabs.lock().map(|m| m.values().map(|t| t.info.clone()).collect()).unwrap_or_default()
    }
    pub fn attach(&self, id: &str, output: Channel<Output>) -> Result<()> {
        let mut tabs = self.tabs.lock().map_err(|e| e.to_string())?;
        let tab = tabs.get_mut(id).ok_or("That terminal is gone")?;
        if !tab.recent.is_empty() {
            output.send(Output::Data { data: tab.recent.clone() }).map_err(|e| e.to_string())?;
        }
        if let Some(code) = tab.info.exited {
            output.send(Output::Exit { code }).map_err(|e| e.to_string())?;
        }
        tab.output = Some(output);
        Ok(())
    }
    pub fn input(&self, id: &str, data: &str) -> Result<()> {
        let mut tabs = self.tabs.lock().map_err(|e| e.to_string())?;
        let tab = tabs.get_mut(id).ok_or("That terminal is gone")?;
        if tab.info.exited.is_some() {
            return Err("That shell has exited".into());
        }
        tab.writer.write_all(data.as_bytes()).and_then(|()| tab.writer.flush()).map_err(|e| e.to_string())
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let tabs = self.tabs.lock().map_err(|e| e.to_string())?;
        let tab = tabs.get(id).ok_or("That terminal is gone")?;
        tab.master
            .resize(PtySize { cols: cols.clamp(2, 500), rows: rows.clamp(2, 300), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }
    pub fn close(&self, id: &str) {
        if let Ok(mut tabs) = self.tabs.lock()
            && let Some(mut tab) = tabs.remove(id)
        {
            let _ = tab.killer.kill();
        }
    }
    pub fn close_all(&self) {
        let ids: Vec<_> = self.list().into_iter().map(|i| i.id).collect();
        for id in ids {
            self.close(&id);
        }
    }
}
