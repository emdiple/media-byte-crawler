use anyhow::Result;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

// Only these embedded assets are served; no user-selected file leaves the browser.
fn asset(path: &str) -> Option<(&'static str, &'static [u8])> {
    match path {
        "/" | "/index.html" => Some((
            "text/html; charset=utf-8",
            include_bytes!("../web/index.html"),
        )),
        "/styles.css" => Some((
            "text/css; charset=utf-8",
            include_bytes!("../web/styles.css"),
        )),
        "/app.js" => Some((
            "text/javascript; charset=utf-8",
            include_bytes!("../web/app.js"),
        )),
        "/parser.mjs" => Some((
            "text/javascript; charset=utf-8",
            include_bytes!("../web/parser.mjs"),
        )),
        "/knowledge.mjs" => Some((
            "text/javascript; charset=utf-8",
            include_bytes!("../web/knowledge.mjs"),
        )),
        "/sample.mp4" => Some(("video/mp4", include_bytes!("../sample/vid_s_01.mp4"))),
        _ => None,
    }
}

pub fn serve() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:7878")?;
    println!("Media Byte Crawler: http://127.0.0.1:7878");
    println!("Open this address in your browser. Press Ctrl+C to stop.");
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                std::thread::spawn(move || {
                    if let Err(error) = respond(stream) {
                        eprintln!("UI connection: {error}");
                    }
                });
            }
            Err(error) => eprintln!("UI connection: {error}"),
        }
    }
    Ok(())
}

fn respond(mut stream: TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    while request.len() < 8192 && !request.windows(4).any(|part| part == b"\r\n\r\n") {
        let length = stream.read(&mut buffer)?;
        if length == 0 {
            return Ok(());
        }
        request.extend_from_slice(&buffer[..length]);
    }
    let request = String::from_utf8_lossy(&request);
    let mut words = request.lines().next().unwrap_or("").split_whitespace();
    let method = words.next().unwrap_or("");
    let path = words.next().unwrap_or("").split('?').next().unwrap_or("");
    let (status, content_type, body): (&str, &str, &[u8]) = if method != "GET" && method != "HEAD" {
        ("405 Method Not Allowed", "text/plain", b"Use GET or HEAD")
    } else if let Some((content_type, body)) = asset(path) {
        ("200 OK", content_type, body)
    } else {
        ("404 Not Found", "text/plain", b"Not found")
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-cache\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\r\n\r\n",
        body.len()
    )?;
    if method != "HEAD" {
        stream.write_all(body)?;
    }
    Ok(())
}
