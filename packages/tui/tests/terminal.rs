//! Spawn the real terminal binary against a deterministic wire peer. Verifies the
//! actual stdin → RPC → terminal rendering path, including OSC 52 over a PTY.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn terminal_conversation_queue_fork_copy_and_page() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let thread = json!({"id":"main","session":{"id":"session","spaceId":"space","slug":"Terminal test","directory":"/workspace","mainThreadId":"main"},"parked":true});
    let entry = |id: &str, seq: u64, role: &str, text: &str| json!({"id":id,"threadId":"main","seq":seq,"role":role,"state":"committed","createdAt":1000,"updatedAt":2000,"parts":[{"type":"text","text":text}]});
    let user = entry("u", 8, "user", "Question");
    let answer = entry("a", 9, "assistant", "Terminal answer");
    let older = entry("old", 1, "user", "Older question");
    let queued = json!({"id":"q","text":"Queued question","delivery":"followUp"});
    let subscribers = Arc::new(Mutex::new(Vec::<mpsc::UnboundedSender<Value>>::new()));
    let recorded = calls.clone();
    let task = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let calls = recorded.clone();
            let thread = thread.clone();
            let user = user.clone();
            let answer = answer.clone();
            let older = older.clone();
            let queued = queued.clone();
            let subscribers = subscribers.clone();
            tokio::spawn(async move {
                let (mut write, mut read) = accept_async(socket).await.unwrap().split();
                let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
                loop {
                    tokio::select! {
                        Some(item)=rx.recv()=>{if write.send(Message::Text(item.to_string())).await.is_err() {break;}},
                        message=read.next()=>{
                            let Some(Ok(Message::Text(text)))=message else {break;};
                            let request:Value=serde_json::from_str(text.trim()).unwrap();
                            if request["_tag"]!="Request" {continue;}
                            calls.lock().await.push(json!({"tag":request["tag"],"payload":request["payload"]}));
                            let id=&request["id"];let payload=&request["payload"];
                            let value=match request["tag"].as_str().unwrap() {
                                "server.info"=>json!({"pid":1,"version":"test","storeId":"store","rev":10}),
                                "model.list"=>json!({"providers":[]}),
                                "thread.list"=>json!([thread]),
                                "thread.info"=>thread.clone(),
                                "thread.sync"=>{
                                    subscribers.lock().await.push(tx.clone());
                                    let items=if payload["threadId"]=="fork" {vec![json!({"_tag":"Synced","storeId":"store","rev":10,"floor":1})]}
                                    else {vec![json!({"_tag":"Entry","entry":user,"rev":8}),json!({"_tag":"Entry","entry":answer,"rev":9}),json!({"_tag":"Inbox","prompt":queued,"state":"pending","rev":10}),json!({"_tag":"Synced","storeId":"store","rev":10,"floor":8})]};
                                    tx.send(json!({"_tag":"Chunk","requestId":id,"values":items})).unwrap();continue;
                                },
                                "event.subscribe"=>continue,
                                "thread.cancel"=>json!({"cancelled":true}),
                                "thread.update"=>json!({"updated":true}),
                                "thread.page"=>json!({"entries":[older]}),
                                "thread.fork"=>{let mut fork=thread.clone();fork["id"]=json!("fork");json!({"thread":fork,"text":"Question"})},
                                other=>panic!("unexpected RPC {other}"),
                            };
                            tx.send(json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":value}})).unwrap();
                        }
                    }
                }
            });
        }
    });
    // Python's standard-library PTY keeps this test independent of a terminal emulator.
    let script = r#"
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
import fcntl, termios, struct
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
child = subprocess.Popen([sys.argv[1]], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
output = bytearray()
def drain(seconds=.2):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if select.select([master],[],[],.02)[0]:
            try: output.extend(os.read(master,65536))
            except OSError: break
def send(text):
    os.write(master,text); drain()
def wait(text):
    end=time.monotonic()+5
    while text not in output and time.monotonic()<end: drain(.05)
    assert text in output, ('missing',text,bytes(output[-3000:]))
try:
    drain()
    send(b'/session\r'); wait(b'Terminal test'); send(b'\r'); wait(b'Terminal answer')
    send(b'\x19'); wait(b'\x1b]52;c;VGVybWluYWwgYW5zd2Vy\x07')
    send(b'\x1b[5~'); drain() # PageUp loads older history even when it fits the viewport
    send(b'\x1b[A') # empty composer Up; focus queue through the explicit command below
    send(b'/queue\r'); send(b'l'); send(b'e'); send(b'\x15rewritten\r'); send(b'w')
    send(b'\x15/fork\r'); send(b'b'); wait(b'Question')
    send(b'\x03'); child.wait(timeout=5)
    assert child.returncode == 0, bytes(output[-3000:])
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
"#;
    let binary = env!("CARGO_BIN_EXE_codework-tui");
    let outcome = tokio::task::spawn_blocking(move || {
        Command::new("python3")
            .arg("-c")
            .arg(script)
            .arg(binary)
            .env("CODEWORK_RPC_SERVER", url)
            .env("TERM", "xterm-256color")
            .stdin(Stdio::null())
            .output()
            .unwrap()
    });
    let output = tokio::time::timeout(Duration::from_secs(30), outcome)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let calls = calls.lock().await;
    for tag in [
        "thread.sync",
        "thread.update",
        "thread.cancel",
        "thread.fork",
        "thread.page",
    ] {
        assert!(
            calls.iter().any(|c| c["tag"] == tag),
            "missing {tag}: {calls:?}"
        );
    }
    let selected: Vec<_> = calls
        .iter()
        .filter(|c| {
            matches!(
                c["tag"].as_str(),
                Some("thread.update" | "thread.cancel" | "thread.fork" | "thread.page")
            )
        })
        .cloned()
        .collect();
    let rendered = serde_json::to_string_pretty(&selected).unwrap() + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("__artifacts__/terminal.json");
    if std::env::var_os("UPDATE_ARTIFACTS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &rendered).unwrap();
    }
    assert_eq!(
        rendered,
        std::fs::read_to_string(path).expect("run UPDATE_ARTIFACTS=1 cargo test")
    );
}
