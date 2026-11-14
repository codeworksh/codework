//! Real CLI + PTY + real Git repo behind a deterministic RPC peer.
#![cfg(unix)]
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{accept_async, tungstenite::Message};
fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success() || result.status.code() == Some(1),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}
#[tokio::test]
async fn reviews_real_git_changes_without_running_git_in_the_tui() {
    let root = std::env::temp_dir().join(format!(
        "codework-tui-git-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "--initial-branch=main"]);
    let original = (1..=25).map(|n| format!("line {n}\n")).collect::<String>();
    std::fs::write(repo.join("src/main.rs"), &original).unwrap();
    std::fs::write(repo.join("obsolete.txt"), "remove me\n").unwrap();
    git(&repo, &["add", "."]);
    git(
        &repo,
        &[
            "-c",
            "user.name=TUI Test",
            "-c",
            "user.email=tui@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
        ],
    );
    std::fs::write(
        repo.join("src/main.rs"),
        original
            .replace("line 2\n", "new value\n")
            .replace("line 22\n", "last hunk\n"),
    )
    .unwrap();
    std::fs::remove_file(repo.join("obsolete.txt")).unwrap();
    std::fs::write(repo.join("notes with spaces.txt"), "New notes\n").unwrap();
    let head = git(&repo, &["rev-parse", "HEAD"]).trim().to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let recorded = calls.clone();
    let patch_reads = Arc::new(AtomicUsize::new(0));
    let thread = json!({"id":"main","session":{"id":"session","spaceId":"space","slug":"Git integration","directory":"/workspace","mainThreadId":"main"}});
    let status = json!({"spaceId":"space","observedAt":1,"available":true,"branch":"main","head":head,"files":[{"file":"notes with spaces.txt","status":"added","additions":1,"deletions":0},{"file":"obsolete.txt","status":"deleted","additions":0,"deletions":1},{"file":"src/main.rs","status":"modified","additions":2,"deletions":2}]});
    let task = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let calls = recorded.clone();
            let thread = thread.clone();
            let status = status.clone();
            let repo = repo.clone();
            let reads = patch_reads.clone();
            tokio::spawn(async move {
                let (mut write, mut read) = accept_async(socket).await.unwrap().split();
                let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
                loop {
                    tokio::select! {
                        Some(value)=rx.recv()=>{if write.send(Message::Text(value.to_string())).await.is_err(){break;}},
                        message=read.next()=>{
                            let Some(Ok(Message::Text(text)))=message else {break;};let request:Value=serde_json::from_str(text.trim()).unwrap();if request["_tag"]!="Request" {continue;}
                            let tag=request["tag"].as_str().unwrap();let id=&request["id"];let payload=&request["payload"];calls.lock().await.push(json!({"tag":tag,"payload":payload}));
                            let value=match tag {
                                "server.info"=>json!({"pid":1,"version":"test","storeId":"store","rev":1}),"model.list"=>json!({"providers":[]}),"thread.list"=>json!([thread]),"thread.info"=>thread.clone(),
                                "index.sync"|"thread.sync"=>{tx.send(json!({"_tag":"Chunk","requestId":id,"values":[{"_tag":"Synced","storeId":"store","rev":1,"floor":1}]})).unwrap();continue;},
                                "event.subscribe"=>{
                                    if payload["types"].as_array().is_some_and(|types|types.iter().any(|t|t=="plugin.git.status")) {
                                        assert!(payload.get("threadId").is_none());
                                        tx.send(json!({"_tag":"Chunk","requestId":id,"values":[{"type":"server.connected","data":{}},{"type":"plugin.git.status","data":status}]})).unwrap();
                                    }continue;
                                },
                                "daemon.call"=>{
                                    assert_eq!(payload["plugin"],"git");assert_eq!(payload["method"],"diff");assert_eq!(payload["spaceId"],"space");
                                    let file=payload["input"]["files"][0].as_str().unwrap();let entry=status["files"].as_array().unwrap().iter().find(|s|s["file"]==file).unwrap();
                                    let patch=if entry["status"]=="added" {git(&repo,&["diff","--no-index","--","/dev/null",file])}else{git(&repo,&["diff","HEAD","--",file])};
                                    let count=reads.fetch_add(1,Ordering::SeqCst);json!({"cached":count>2,"truncated":count>2,"files":[{"file":file,"status":entry["status"],"additions":entry["additions"],"deletions":entry["deletions"],"patch":patch}]})
                                },other=>panic!("unexpected {other}"),
                            };
                            tx.send(json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":value}})).unwrap();
                        }
                    }
                }
            });
        }
    });
    let test_home = root.join("home");
    let script = r#"
import os,pty,select,subprocess,sys,time,fcntl,termios,struct,re
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',26,120,0,0))
child=subprocess.Popen([sys.argv[1]],stdin=slave,stdout=slave,stderr=slave,close_fds=True);os.close(slave);output=bytearray()
def drain(seconds=.2):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if select.select([master],[],[],.02)[0]:
            try:output.extend(os.read(master,65536))
            except OSError:break
def send(text):os.write(master,text);drain()
def wait(text):
    end=time.monotonic()+5
    while text not in output and time.monotonic()<end:drain(.05)
    assert text in output,('missing',text,re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]',b'',bytes(output))[-2000:])
try:
    wait(b'\x1b[?2026l');send(b'\x10');wait(b'Git integration');send(b'\r');drain()
    send(b'unsent draft');send(b'\x07');wait(b'Changes');wait(b'New notes')
    send(b'\x1b[B');wait(b'remove me');send(b'\x1b[B');wait(b'new value');send(b'\r');send(b'n');wait(b'last hunk')
    send(b'v');send(b'r');wait(b'cached');wait(b'truncated');send(b'\x1b');drain();send(b'\x1b');wait(b'unsent draft')
    send(b'\x03');child.wait(timeout=5);assert child.returncode==0
finally:
    if child.poll() is None:child.kill();child.wait()
    os.close(master)
"#;
    let outcome = tokio::task::spawn_blocking(move || {
        Command::new("python3")
            .arg("-c")
            .arg(script)
            .arg(env!("CARGO_BIN_EXE_codework-tui"))
            .env("CODEWORK_RPC_SERVER", url)
            .env("CODEWORK_HOME_DIR", test_home)
            .env("TERM", "xterm-256color")
            .stdin(Stdio::null())
            .output()
            .unwrap()
    });
    let output = tokio::time::timeout(Duration::from_secs(35), outcome)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(
        output.status.success(),
        "{}\n{:?}",
        String::from_utf8_lossy(&output.stderr),
        calls.lock().await
    );
    let calls = calls.lock().await;
    assert!(!calls.iter().any(|c| c["tag"] == "thread.prompt"));
    let reviewed: Vec<_> = calls
        .iter()
        .filter(|c| c["tag"] == "daemon.call")
        .map(|c| c["payload"].clone())
        .collect();
    assert!(reviewed
        .iter()
        .any(|p| p["input"]["files"][0] == "src/main.rs"));
    assert!(reviewed
        .iter()
        .any(|p| p["input"]["files"][0] == "obsolete.txt"));
    let rendered = serde_json::to_string_pretty(&reviewed).unwrap() + "\n";
    let artifact = Path::new(env!("CARGO_MANIFEST_DIR")).join("__artifacts__/git.json");
    if std::env::var_os("UPDATE_ARTIFACTS").is_some() {
        std::fs::write(&artifact, &rendered).unwrap();
    }
    assert_eq!(
        rendered,
        std::fs::read_to_string(artifact).expect("run UPDATE_ARTIFACTS=1 cargo test")
    );
    std::fs::remove_dir_all(root).unwrap();
}
