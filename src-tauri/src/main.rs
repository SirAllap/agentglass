// agentglass desktop shell.
//
// The window is a native frame around the same cockpit the browser serves —
// all the work still happens in the Bun server, which runs here as a child
// process rather than something the user starts by hand.
//
// Two obligations the shell has to get right:
//   * Don't stack a second server on a port that already has one. Having a
//     `bun run dev` open in a checkout is normal, and the app should join it
//     instead of failing to bind (or racing it for the database).
//   * Never leave the server running after the window is gone. Killing it from
//     an exit handler only covers a tidy shutdown, so the kernel enforces it
//     too — see spawn_server().

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::MacosLauncher;

/// Matches the server's own default (AGENTGLASS_PORT).
const PORT: u16 = 4000;

/// The server we started, so it can be shut down with the app. Stays None when
/// we attached to one that was already running — that one isn't ours to kill.
struct ServerProcess(Mutex<Option<Child>>);

/// Is something already listening? Cheap TCP probe: the server binds the port
/// before its initial scan, so this answers immediately either way.
fn already_serving() -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, PORT);
    TcpStream::connect_timeout(&addr.into(), Duration::from_millis(300)).is_ok()
}

/// The bundled server binary, which ships next to the app executable.
fn server_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe = std::fs::canonicalize(exe).ok()?;
    let path = exe.parent()?.join("agentglass-server");
    path.exists().then_some(path)
}

/// Defaults that only make sense for the app.
///
/// Started from a checkout the server picks up a .env next to it; started from
/// a desktop icon there is no such file, and it would fall back to pruning
/// history after a week — which for a window whose whole job is showing every
/// project on the machine means quietly hiding most of them. A value already
/// set in the environment still wins.
fn desktop_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    if std::env::var_os("AGENTGLASS_RETENTION_DAYS").is_none() {
        env.insert("AGENTGLASS_RETENTION_DAYS".into(), "0".into());
    }
    if let Some(root) = arg_root() {
        env.insert("AGENTGLASS_ROOT".into(), root);
    }
    env
}

/// A directory passed on the command line: `agentglass ~/code/thing`.
///
/// Opening the app *for a project* is the common case — the alternative is
/// editing a config file to change which one, which is the wrong shape for
/// something you do per window. The server treats it as its whole scope.
fn arg_root() -> Option<String> {
    let arg = std::env::args().nth(1)?;
    if arg.starts_with('-') {
        return None; // a flag, not a path
    }
    let path = std::fs::canonicalize(&arg).ok()?;
    path.is_dir().then(|| path.to_string_lossy().into_owned())
}

/// Start the server as a child that cannot outlive us.
///
/// The exit handler below covers a clean shutdown, but it never runs if the app
/// is killed by a signal or crashes — and an orphaned server keeps holding the
/// port, so the next launch silently attaches to a stale build. On Linux
/// PR_SET_PDEATHSIG makes the kernel signal the child the moment the parent
/// dies, whatever the reason.
fn spawn_server() -> std::io::Result<Child> {
    let path = server_path().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "agentglass-server not found next to the app")
    })?;
    let mut cmd = Command::new(path);
    cmd.envs(desktop_env());

    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            // Also guard the race where the parent died between fork and here.
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() == 1 {
                return Err(std::io::Error::new(std::io::ErrorKind::Other, "parent already gone"));
            }
            Ok(())
        });
    }
    cmd.spawn()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            if already_serving() {
                println!("[agentglass] port {PORT} already served — attaching to it");
                return Ok(());
            }
            match spawn_server() {
                Ok(child) => {
                    println!("[agentglass] server started (pid {})", child.id());
                    app.state::<ServerProcess>().0.lock().unwrap().replace(child);
                }
                // A dead server means an empty window rather than a crash; say
                // why on stderr so it isn't a silent blank screen.
                Err(e) => eprintln!("[agentglass] could not start server: {e}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build agentglass");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<ServerProcess>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait(); // reap, so it never lingers as a zombie
            }
        }
    });
}
