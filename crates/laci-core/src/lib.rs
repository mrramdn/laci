//! Disk engine shared by the desktop app, command line and MCP server.
pub mod activity;
pub mod agents;
pub mod config;
pub mod create;
pub mod deletion;
pub mod env;
pub mod files;
pub mod ops;
pub mod paths;
pub mod process;
pub mod readers;
pub mod scan;
pub mod service;
pub mod sidecar;

pub type Result<T> = std::result::Result<T, String>;
