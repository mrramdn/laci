//! Disk engine shared by the desktop app, command line and MCP server.
pub mod activity;
pub mod agents;
pub mod assistant;
pub mod config;
pub mod create;
pub mod deletion;
pub mod env;
pub mod files;
mod git;
pub mod launch;
pub mod mcp_setup;
pub mod ops;
mod orphan;
pub mod paths;
pub mod process;
pub mod providers;
pub mod readers;
pub mod reports;
pub mod scan;
pub mod service;
pub mod sidecar;
pub mod storage;

pub type Result<T> = std::result::Result<T, String>;
