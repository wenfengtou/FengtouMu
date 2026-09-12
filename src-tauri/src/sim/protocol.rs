//! 仿真子进程的 JSON Lines 线协议：消息的构造与解析。
//!
//! 线格式（每行一个 JSON，stdin/stdout）：
//!   主进程 → 子进程：`{"id":<n>,"cmd":"<stop|pause|resume|pin_write|uart_send|pins|status|uart_poll|set_apin>", ...}`
//!   子进程 → 主进程：`{"reply":<n>,"ok":true,"data":..}` / `{"event":"<名>","payload":..}` / `{"log":".."}`
//!
//! 这个模块不依赖 QEMU DLL，纯函数，供单元测试与协议级测试矩阵使用。

use serde_json::{json, Value};

/// 构造主进程 → 子进程的命令帧
pub fn cmd_json(id: u64, cmd: &str, extra: serde_json::Map<String, Value>) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".into(), json!(id));
    map.insert("cmd".into(), json!(cmd));
    for (k, v) in extra {
        map.insert(k, v);
    }
    Value::Object(map)
}

/// 构造子进程 → 主进程的成功响应帧
pub fn reply_json(id: u64, data: Option<Value>) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("reply".into(), json!(id));
    m.insert("ok".into(), json!(true));
    if let Some(d) = data {
        m.insert("data".into(), d);
    }
    Value::Object(m)
}

/// 构造子进程 → 主进程的错误响应帧
pub fn err_json(id: u64, message: &str) -> Value {
    json!({ "reply": id, "ok": false, "error": message })
}

/// 构造子进程 → 主进程的事件帧
pub fn event_json(name: &str, payload: Value) -> Value {
    json!({ "event": name, "payload": payload })
}

/// 一行线消息的分类解析结果。
#[derive(Debug, Clone, PartialEq)]
pub enum WireMessage {
    /// `{"reply":<id>,"ok":..,"data":..}` 命令响应
    Reply { id: u64, ok: bool, data: Value, error: Option<String> },
    /// `{"event":"<名>","payload":..}` 事件
    Event { name: String, payload: Value },
    /// `{"log":".."}` 日志
    Log(String),
    /// 无法识别的内容
    Malformed(String),
}

/// 解析一行 JSON Lines 消息。
pub fn parse_wire_line(line: &str) -> WireMessage {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return WireMessage::Malformed(line.to_string()),
    };
    let Some(obj) = v.as_object() else {
        return WireMessage::Malformed(line.to_string());
    };
    if let Some(id) = obj.get("reply").and_then(|x| x.as_u64()) {
        let ok = obj.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
        let data = obj.get("data").cloned().unwrap_or(Value::Null);
        let error = obj.get("error").and_then(|x| x.as_str()).map(String::from);
        return WireMessage::Reply { id, ok, data, error };
    }
    if let Some(name) = obj.get("event").and_then(|x| x.as_str()) {
        let payload = obj.get("payload").cloned().unwrap_or(Value::Null);
        return WireMessage::Event {
            name: name.to_string(),
            payload,
        };
    }
    if let Some(msg) = obj.get("log").and_then(|x| x.as_str()) {
        return WireMessage::Log(msg.to_string());
    }
    WireMessage::Malformed(line.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_frame_has_id_cmd_and_extra_fields() {
        let mut extra = serde_json::Map::new();
        extra.insert("pin".into(), json!(24));
        extra.insert("value".into(), json!(1));
        let v = cmd_json(7, "pin_write", extra);
        assert_eq!(v["id"], 7);
        assert_eq!(v["cmd"], "pin_write");
        assert_eq!(v["pin"], 24);
        assert_eq!(v["value"], 1);
    }

    #[test]
    fn reply_frame_round_trip() {
        let ok = reply_json(3, Some(json!({"pin": 24, "value": 1})));
        assert_eq!(
            parse_wire_line(&ok.to_string()),
            WireMessage::Reply {
                id: 3,
                ok: true,
                data: json!({"pin": 24, "value": 1}),
                error: None
            }
        );
        let err = err_json(4, "仿真未在运行");
        assert_eq!(
            parse_wire_line(&err.to_string()),
            WireMessage::Reply {
                id: 4,
                ok: false,
                data: Value::Null,
                error: Some("仿真未在运行".into())
            }
        );
    }

    #[test]
    fn event_frame_round_trip() {
        let ev = event_json("gpio-update", json!({"pin": 24, "gpio": 2, "value": 1, "dir": 1}));
        assert_eq!(
            parse_wire_line(&ev.to_string()),
            WireMessage::Event {
                name: "gpio-update".into(),
                payload: json!({"pin": 24, "gpio": 2, "value": 1, "dir": 1})
            }
        );
    }

    #[test]
    fn log_line_parses() {
        assert_eq!(
            parse_wire_line(r#"{"log":"DLL loaded"}"#),
            WireMessage::Log("DLL loaded".into())
        );
    }

    #[test]
    fn malformed_lines_are_reported() {
        assert_eq!(parse_wire_line("not json"), WireMessage::Malformed("not json".into()));
        assert_eq!(parse_wire_line("42"), WireMessage::Malformed("42".into()));
        assert_eq!(
            parse_wire_line(r#"{"unknown":1}"#),
            WireMessage::Malformed(r#"{"unknown":1}"#.into())
        );
    }

    #[test]
    fn cmd_frame_fields_are_serialized() {
        // 命令帧是主进程 → 子进程方向，parse_wire_line 只负责子进程 → 主进程；
        // 这里验证字段能被序列化并还原
        let v = cmd_json(9, "uart_send", {
            let mut m = serde_json::Map::new();
            m.insert("uart".into(), json!(0));
            m.insert("data".into(), json!([72, 105]));
            m
        });
        let round: Value = serde_json::from_str(&v.to_string()).expect("可再解析");
        assert_eq!(round["id"], 9);
        assert_eq!(round["cmd"], "uart_send");
        assert_eq!(round["uart"], 0);
        assert_eq!(round["data"].as_array().map(|a| a.len()), Some(2));
        assert_eq!(round, v, "序列化 → 反序列化应还原");
    }
}
