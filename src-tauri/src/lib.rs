use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;
use tokio::sync::Mutex;
use url::Url;

#[derive(Default)] pub struct AppState { pub downloads: Mutex<Vec<DownloadRequest>> }
#[derive(Clone, Serialize, Deserialize)] pub struct DownloadRequest { pub id: String, pub url: String, pub destination: String, pub connections: u8 }

fn safe_url(input: &str) -> Result<Url, String> { let u=Url::parse(input).map_err(|_| "Invalid URL".to_string())?; if !matches!(u.scheme(), "http"|"https") { return Err("Only HTTP and HTTPS downloads are supported".into()); } Ok(u) }

#[tauri::command] pub async fn enqueue_download(state: State<'_, AppState>, request: DownloadRequest) -> Result<String, String> { safe_url(&request.url)?; if request.destination.contains("..") { return Err("Unsafe destination".into()); } state.downloads.lock().await.push(request.clone()); Ok(request.id) }
#[tauri::command] pub async fn pause_download(_id: String) -> Result<(), String> { Ok(()) }
#[tauri::command] pub async fn resume_download(_id: String) -> Result<(), String> { Ok(()) }
#[tauri::command] pub async fn app_health() -> Result<String, String> { Ok("connected".into()) }

pub fn run() { tauri::Builder::default().manage(AppState::default()).invoke_handler(tauri::generate_handler![enqueue_download,pause_download,resume_download,app_health]).run(tauri::generate_context!()).expect("error while running Meldrix"); }
