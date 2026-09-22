//! 测试用的极小 HTTP 桩（仅 `#[cfg(test)]`）：单连接、按脚本回答，并把收到的
//! 请求原文交回调用方断言——凭据桥与会话换取的线上字节都在这里被钉住，
//! 不必启动真的 dsh。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver};

/// 起一个只服务一个连接的桩：返回监听端口与「收到的请求原文」接收端。
/// 响应由调用方整段给定（自行写全 `Content-Length` / `Connection: close`）。
pub(crate) fn one_shot(response: &str) -> (u16, Receiver<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind stub listener");
    let port = listener.local_addr().expect("stub addr").port();
    let (sender, receiver) = mpsc::channel();
    let response = response.to_string();
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let request = read_request(&mut stream);
        let _ = sender.send(request);
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    });
    (port, receiver)
}

/// 读到请求结束：请求头 + 按 `Content-Length` 声明的正文（客户端在等响应，
/// 读满即收手，不会挂住）
fn read_request(stream: &mut TcpStream) -> String {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                if let Some(head_end) = find_head_end(&buffer) {
                    if buffer.len() >= head_end + content_length(&buffer[..head_end]) {
                        break;
                    }
                }
            }
        }
    }
    String::from_utf8_lossy(&buffer).to_string()
}

/// 请求头结束位置（`\r\n\r\n` 之后的正文起点）
fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n").map(|at| at + 4)
}

/// `Content-Length` 头的值（大小写不敏感）；缺失按 0
fn content_length(head: &[u8]) -> usize {
    String::from_utf8_lossy(head)
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())?
        })
        .unwrap_or(0)
}
