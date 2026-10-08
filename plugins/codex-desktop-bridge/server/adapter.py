"""JSON adapter: reuse bridge authorization/queue/controller; never write Desktop or bot state."""
from __future__ import annotations

import hashlib
import importlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import uuid


def text_content(content):
    return "\n".join(p if isinstance(p, str) else p.get("text", "") for p in content
                     if isinstance(p, (str, dict)))


def read_rollout(path):
    if not path:
        return []
    events = []
    with Path(path).open(encoding="utf-8") as stream:
        for line in stream:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                # A writer may not have finished the final JSONL line yet.
                if line.endswith("\n"):
                    raise
    return events


def timeline(events, limit=150, initial_prompt=""):
    items, turns = {}, {}
    turn_id = ""
    for index, event in enumerate(events):
        if event.get("type") != "event_msg":
            continue
        payload = event.get("payload", {})
        kind = payload.get("type")
        if kind == "task_started":
            turn_id = payload.get("turn_id", "")
            if turn_id:
                turns[turn_id] = "started"
        elif kind in {"task_complete", "turn_aborted"}:
            finished = payload.get("turn_id") or turn_id
            if finished:
                turns[finished] = "completed" if kind == "task_complete" else "canceled"
        elif kind == "item_completed":
            item = payload.get("item", {})
            item_id = str(item.get("id") or index)
            item_type = item.get("type")
            entry = None
            if (initial_prompt and item_type == "FunctionCallOutput"
                    and item.get("namespace") == "codex_app" and item.get("name") == "create_thread"):
                entry = {"type": "user_message", "id": item_id,
                         "text": re.sub(r"\n*<!-- codex-lark-job:[^>]+ -->", "", initial_prompt)}
                initial_prompt = ""
            elif item_type in {"UserMessage", "AgentMessage"}:
                text = text_content(item.get("content", []))
                text = re.sub(r"\n*<!-- codex-lark-job:[^>]+ -->", "", text)
                entry = {"type": "user_message" if item_type == "UserMessage" else "assistant_message",
                         "id": item_id, "text": text}
                if item_type == "UserMessage" and item.get("client_id"):
                    entry["clientMessageId"] = item["client_id"]
            elif item_type == "CommandExecution":
                status = "failed" if item.get("exit_code") else "completed"
                command = item.get("command", "")
                entry = {"type": "tool_call", "id": item_id, "callId": item_id,
                         "name": "shell", "status": status,
                         "error": item.get("stderr", "") if status == "failed" else None,
                         "detail": {"type": "shell", "command": " ".join(command) if isinstance(command, list) else command,
                                    "cwd": item.get("cwd", ""),
                                    "output": item.get("aggregated_output", "")[-12000:],
                                    "exitCode": item.get("exit_code")}}
            elif item_type == "McpToolCall":
                entry = {"type": "tool_call", "id": item_id, "callId": item_id,
                         "name": f"{item.get('server', '')}.{item.get('tool', '')}",
                         "status": "completed", "error": None,
                         "detail": {"type": "plain_text", "label": item.get("tool", "工具")}}
            if entry:
                items[item_id] = {"item": entry, "turnId": payload.get("turn_id") or turn_id,
                                  "timestamp": event.get("timestamp")}
        # Older Codex releases persisted message events rather than completed items.
        elif kind in {"user_message", "agent_message"}:
            item_id = f"legacy-{index}"
            items[item_id] = {"item": {"id": item_id, "type": kind.replace("agent", "assistant"),
                                      "text": payload.get("message", "")},
                              "turnId": turn_id, "timestamp": event.get("timestamp")}
    # ponytail: replay the latest 150 rows; add paging when long-history navigation is needed.
    entries = list(items.values())
    return {"items": entries[-limit:] if limit else entries, "turns": turns}


class Adapter:
    def __init__(self, options):
        sys.path.insert(0, str(Path(options["bridgeSource"]).expanduser().resolve()))
        self.bridge = importlib.import_module("bridge")
        self.config = self.bridge.BridgeConfig.load(Path(options["bridgeConfig"]).expanduser().resolve())
        self.catalog = self.bridge.CodexDesktopProjects(self.config.desktop_state_path)
        state_dir = Path(options["stateDirectory"]).expanduser()
        state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(state_dir / "requests.sqlite", timeout=10)
        self.db.execute("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT, data TEXT)")
        self.db.commit()

    def desktop_rows(self):
        with sqlite3.connect(f"{self.config.desktop_thread_db_path.as_uri()}?mode=ro", uri=True) as db:
            db.row_factory = sqlite3.Row
            return db.execute("SELECT id, cwd, title, archived, source, rollout_path FROM threads "
                              "WHERE archived=0 ORDER BY updated_at_ms DESC").fetchall()

    def authorized(self, row):
        return (row["id"] != self.config.controller_thread_id and not row["archived"]
                and row["source"] in {"cli", "vscode"}
                and self.bridge.authorized_thread_project(self.config, row["id"], row["cwd"], self.catalog))

    def thread(self, thread_id):
        for row in self.desktop_rows():
            authorized = self.authorized(row)
            if row["id"] == thread_id and authorized:
                return row, authorized[0]
        raise ValueError("该 Desktop 会话不存在、已归档或不在 bridge 授权范围内")

    def project(self, name):
        native = self.config.native_project_for_new(self.catalog, name)
        if not native:
            raise ValueError("项目或完整 roots 未通过当前 bridge 授权")
        return native

    def directory(self):
        projects = [{"name": name, "projectId": native.project_id, "cwd": self.config.projects[name]}
                    for name in sorted(self.config.projects)
                    if (native := self.config.native_project_for_new(self.catalog, name))]
        threads = []
        for row in self.desktop_rows():
            if authorized := self.authorized(row):
                title = row["title"]
                if not title:
                    record = self.bridge.read_desktop_thread_record(self.config.desktop_thread_db_path, row["id"], self.config.controller_thread_id)
                    title = record.first_user_message.split("\n", 1)[0][:120] if record else ""
                threads.append({"threadId": row["id"], "title": title, "cwd": row["cwd"],
                                "project": authorized[0]})
        return {"projects": projects, "threads": threads[:200]}

    def snapshot(self, thread_id):
        row, project = self.thread(thread_id)
        initial = self.bridge.read_delegated_prompt(Path(row["rollout_path"]), thread_id,
                                                   self.config.controller_thread_id) if row["rollout_path"] else ""
        return {"threadId": thread_id, "title": row["title"] or initial.split("\n", 1)[0][:120], "cwd": row["cwd"], "project": project,
                **timeline(read_rollout(row["rollout_path"]), initial_prompt=initial)}

    def save(self, request_id, data):
        with self.db:
            self.db.execute("UPDATE requests SET data=? WHERE id=?", (json.dumps(data), request_id))

    def claim(self, request_id, intent, data):
        fingerprint = hashlib.sha256(json.dumps(intent, sort_keys=True).encode()).hexdigest()
        with self.db:
            inserted = self.db.execute("INSERT OR IGNORE INTO requests VALUES (?,?,?)",
                                       (request_id, fingerprint, json.dumps(data))).rowcount
            row = self.db.execute("SELECT fingerprint,data FROM requests WHERE id=?", (request_id,)).fetchone()
        if row[0] != fingerprint:
            raise ValueError("同一消息 ID 不能用于不同内容")
        return inserted, json.loads(row[1])

    def queue(self, request_id, data, thread_id, cwd, prompt):
        try:
            result = subprocess.run(self.bridge.build_queue_command(self.config, thread_id=thread_id,
                                    prompt=prompt, cwd=cwd), cwd=cwd, text=True, capture_output=True,
                                    timeout=30, check=False)
            if result.returncode:
                raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Codex 排队失败")
        except Exception as exc:
            data.update(status="uncertain", error=f"排队结果不确定，不自动重发：{str(exc)[:1200]}")
            self.save(request_id, data)
            return data
        data["status"] = "queued"
        self.save(request_id, data)
        if sys.platform == "darwin":
            try:
                # Queueing does not load a cold Desktop thread; use the app's existing deep link.
                subprocess.run(["open", "-g", f"codex://threads/{thread_id}"], check=True,
                               capture_output=True, text=True, timeout=10)
            except Exception as exc:
                data["warning"] = f"请在 Codex Desktop 打开对话 {thread_id}；原消息已排队，不要重发：{str(exc)[:1200]}"
                self.save(request_id, data)
        return data

    def send(self, request):
        snapshot = self.snapshot(request["threadId"])
        self.bridge.BridgeService.validate_prompt(self, request["text"])
        data = {"status": "dispatching", "threadId": request["threadId"],
                "baselineTurns": list(snapshot["turns"]), "baselineItems": [x["item"]["id"] for x in snapshot["items"]]}
        inserted, data = self.claim(request["requestId"], request, data)
        return self.queue(request["requestId"], data, request["threadId"], snapshot["cwd"], request["text"]) if inserted else data

    def create(self, request):
        native = self.project(request["project"])
        self.bridge.BridgeService.validate_prompt(self, request["text"])
        ok, detail = self.bridge.diagnose_controller(self.config)
        if not ok:
            raise ValueError(f"Desktop controller 不可用：{detail}")
        job_id = uuid.uuid5(uuid.NAMESPACE_URL, request["requestId"]).hex
        data = {"status": "dispatching", "job_id": job_id, "project": native.name,
                "text": request["text"], "clientMessageId": request.get("clientMessageId", request["requestId"]),
                "codex_project_id": native.project_id, "controller": self.config.controller_thread_id,
                "task_prompt_hash": self.bridge.controller_task_prompt_hash(
                    self.bridge.controller_task_prompt(job_id, request["text"])),
                "created_after_ms": int(time.time() * 1000),
                "deadline": time.time() + self.config.controller_ack_timeout_seconds}
        inserted, data = self.claim(request["requestId"], request, data)
        if inserted:
            data = self.queue(request["requestId"], data, self.config.controller_thread_id,
                             self.config.controller_cwd, self.bridge.build_controller_request(
                                 job_id=job_id, native_project=native, cwd=self.config.projects[native.name],
                                 prompt=request["text"]))
        return data

    def creation(self, request_id):
        row = self.db.execute("SELECT data FROM requests WHERE id=?", (request_id,)).fetchone()
        if not row:
            raise ValueError("未知的创建请求")
        data = json.loads(row[0])
        self.project(data["project"])
        if data.get("threadId"):
            self.thread(data["threadId"])
            return data
        if data["controller"] != self.config.controller_thread_id:
            raise ValueError("controller 已改变，不能关联旧请求")
        with sqlite3.connect(f"{self.config.desktop_thread_db_path.as_uri()}?mode=ro", uri=True) as db:
            row = db.execute("SELECT rollout_path FROM threads WHERE id=?", (data["controller"],)).fetchone()
        receipt = None
        for entry in timeline(read_rollout(row[0] if row else ""), limit=None)["items"]:
            if entry["item"]["type"] == "assistant_message":
                result = self.bridge.parse_controller_result(entry["item"]["text"])
                if result and result.request_id == data["job_id"]:
                    receipt = result
        candidates = []
        if receipt:
            if receipt.project_id != data["codex_project_id"]:
                raise ValueError("controller 回执 Project 不匹配")
            if receipt.status != "created":
                data.update(status="failed", error=receipt.error or "controller 创建失败")
                self.save(request_id, data)
                return data
            candidates.append(receipt.thread_id)
        # A target can persist before the receipt; the exact first-message hash still verifies it.
        marker = f"<!-- codex-lark-job:{data['job_id']} -->"
        with sqlite3.connect(f"{self.config.desktop_thread_db_path.as_uri()}?mode=ro", uri=True) as db:
            candidates.extend(r[0] for r in db.execute("SELECT id FROM threads WHERE first_user_message LIKE ?", (f"%{marker}%",)))
        since = data.get("created_after_ms", int((data["deadline"] - self.config.controller_ack_timeout_seconds) * 1000))
        for thread_id in self.bridge.read_new_desktop_thread_ids(self.config.desktop_thread_db_path, since):
            record = self.bridge.read_desktop_thread_record(self.config.desktop_thread_db_path, thread_id, data["controller"])
            if record and marker in record.first_user_message:
                candidates.append(thread_id)
        for thread_id in dict.fromkeys(candidates):
            try:
                record = self.bridge.validate_controller_created_thread(self.config, data, thread_id)
            except self.bridge.ControllerTargetNotReady:
                continue
            data.update(status="created", threadId=record.thread_id)
            data.pop("error", None)
            self.save(request_id, data)
            return data
        if time.time() > data["deadline"]:
            data.update(status="uncertain", error="创建回执尚未确认；不会重放。可刷新恢复迟到任务。")
            self.save(request_id, data)
        return data

    def call(self, request):
        action = request["action"]
        if action == "directory":
            return self.directory()
        if action == "snapshot":
            return self.snapshot(request["threadId"])
        if action == "project":
            native = self.project(request["project"])
            return {"project": native.name, "cwd": self.config.projects[native.name]}
        if action == "send":
            return self.send(request)
        if action == "create":
            return self.create(request)
        if action == "creation":
            return self.creation(request["requestId"])
        raise ValueError("不支持的 bridge 操作")


if __name__ == "__main__":
    try:
        options = json.loads(sys.argv[1])
        print(json.dumps(Adapter(options).call(options["request"]), ensure_ascii=False))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
