//! Real-binary PTY coverage of multiline sending, live browser updates and restart persistence.
#![cfg(unix)]
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn multiline_drafts_and_live_browser_survive_a_real_restart() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let recorded = calls.clone();
    let renamed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let task = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let calls = recorded.clone();
            let renamed = renamed.clone();
            tokio::spawn(async move {
                let (mut write, mut read) = accept_async(socket).await.unwrap().split();
                let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
                loop {
                    tokio::select! {
                        Some(item)=rx.recv()=>{if write.send(Message::Text(item.to_string())).await.is_err(){break;}},
                        message=read.next()=>{
                            let Some(Ok(Message::Text(text)))=message else {break;};
                            let request:Value=serde_json::from_str(text.trim()).unwrap();if request["_tag"]!="Request" {continue;}
                            let tag=request["tag"].as_str().unwrap();let id=&request["id"];let payload=&request["payload"];
                            calls.lock().await.push(json!({"tag":tag,"payload":payload}));
                            let thread=|id:&str|json!({"id":id,"title":if id=="main" {if renamed.load(std::sync::atomic::Ordering::SeqCst) {"Updated conversation"} else {"Original conversation"}}else{"Fork conversation"},"createdAt":1,"session":{"id":"session","spaceId":"space","slug":"Chat","directory":"/workspace","mainThreadId":"main","project":{"id":"project","name":"CodeWork"}},"origin":if id=="main"{json!({"kind":"main"})}else{json!({"kind":"fork","threadId":"main","entryId":"u","cut":1})}});
                            let value=match tag {
                                "server.info"=>json!({"pid":1,"version":"test","storeId":"store","rev":2}),
                                "model.list"=>json!({"providers":[]}),
                                "thread.list"=>json!([thread("main"),thread("fork")]),
                                "thread.info"=>thread(payload["threadId"].as_str().unwrap()),
                                "index.sync"=>{
                                    let id=id.clone();tx.send(json!({"_tag":"Chunk","requestId":id,"values":[{"_tag":"Synced","storeId":"store","rev":1}]})).unwrap();
                                    if !renamed.load(std::sync::atomic::Ordering::SeqCst) {let tx=tx.clone();let renamed=renamed.clone();tokio::spawn(async move {tokio::time::sleep(Duration::from_millis(700)).await;renamed.store(true,std::sync::atomic::Ordering::SeqCst);let _=tx.send(json!({"_tag":"Chunk","requestId":id,"values":[{"_tag":"Synced","storeId":"store","rev":2}]}));});}
                                    continue;
                                },
                                "thread.sync"=>{tx.send(json!({"_tag":"Chunk","requestId":id,"values":[{"_tag":"Synced","storeId":"store","rev":2,"floor":1}]})).unwrap();continue;},
                                "event.subscribe"=>continue,
                                "thread.prompt"=>json!({"threadId":payload["threadId"]}),
                                other=>panic!("unexpected {other}"),
                            };
                            let _=tx.send(json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":value}}));
                        }
                    }
                }
            });
        }
    });
    let home = std::env::temp_dir().join(format!(
        "codework-tui-composer-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let test_home = home.clone();
    let script = r#"
import os, pty, select, subprocess, sys, time, fcntl, termios, struct
output=bytearray()
def start():
    global master, child, output
    output=bytearray()
    master,slave=pty.openpty()
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',28,110,0,0))
    child=subprocess.Popen([sys.argv[1]],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
    os.close(slave);wait(b'\x1b[?2026l')
def drain(seconds=.18):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if select.select([master],[],[],.02)[0]:
            try:output.extend(os.read(master,65536))
            except OSError:break
def send(text):os.write(master,text);drain()
def wait(text):
    end=time.monotonic()+5
    while text not in output and time.monotonic()<end:drain(.05)
    import re
    assert text in output,('missing',text,re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]',b'',bytes(output))[-1500:])
def stop():
    send(b'\x03');child.wait(timeout=5);os.close(master)
    assert child.returncode==0,bytes(output[-3000:])
try:
    start();send(b'\x10');wait(b'Original conversation');send(b'CodeWork');wait(b'Updated')
    send(b'\r');wait(b'Updated')
    send(b'\x1b[200~fn main() {\n    '+ '🦀'.encode()+b'\n}\x1b[201~')
    send(b'\n');send(b'tail') # Ctrl+J inserts a newline, not a send
    send(b'\x10');wait(b'Fork conversation');send(b'\x1b[B');send(b'\r');send(b'fork draft');stop()
    start();send(b'\x10');wait(b'Updated');send(b'\r');wait(b'fn main()')
    send(b'\r');drain(.4);stop()
finally:
    if child.poll() is None:child.kill();child.wait()
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
        "{}\nRPCs: {:?}",
        String::from_utf8_lossy(&output.stderr),
        calls.lock().await
    );
    let calls = calls.lock().await;
    assert!(calls.iter().filter(|c| c["tag"] == "thread.list").count() >= 4);
    let sent: Vec<_> = calls
        .iter()
        .filter(|c| c["tag"] == "thread.prompt")
        .collect();
    assert_eq!(sent.len(), 1, "{calls:?}");
    assert_eq!(sent[0]["payload"]["text"], "fn main() {\n    🦀\n}\ntail");
    assert_eq!(sent[0]["payload"]["threadId"], "main");
    let mut saved = Vec::<Value>::new();
    fn drafts(path: &std::path::Path, out: &mut Vec<Value>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                drafts(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                out.push(serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap());
            }
        }
    }
    drafts(&home.join("tui/drafts"), &mut saved);
    assert!(saved.iter().any(|s| s["text"] == "fork draft"));
    let artifact = json!({"sent":{"sessionId":"session","threadId":"main","text":sent[0]["payload"]["text"],"delivery":sent[0]["payload"]["delivery"]},"savedDrafts":saved});
    let rendered = serde_json::to_string_pretty(&artifact).unwrap() + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("__artifacts__/composer.json");
    if std::env::var_os("UPDATE_ARTIFACTS").is_some() {
        std::fs::write(&path, &rendered).unwrap();
    }
    assert_eq!(
        rendered,
        std::fs::read_to_string(path).expect("run UPDATE_ARTIFACTS=1 cargo test")
    );
    std::fs::remove_dir_all(home).unwrap();
}
