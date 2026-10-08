import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from xml.sax.saxutils import escape

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).with_name("adapter.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
source = Path(os.environ.get("CODEX_DESKTOP_BRIDGE_SOURCE", "~/.codex/discord-bridge")).expanduser()
sys.path.insert(0, str(source))
import bridge


class AdapterTests(unittest.TestCase):
    def setUp(self):
        platform = patch.object(adapter.sys, "platform", "linux")
        platform.start()
        self.addCleanup(platform.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        project = self.root / "project"
        project.mkdir()
        self.state = self.root / "desktop.json"
        self.state.write_text(json.dumps({"local-projects": {"p1": {"id": "p1", "name": "demo", "rootPaths": [str(project)]}},
                                         "thread-project-assignments": {"controller": {"projectKind": "local", "projectId": "p1"},
                                                                        "chat": {"projectKind": "local", "projectId": "p1"}}}))
        self.desktop = self.root / "desktop.sqlite"
        with sqlite3.connect(self.desktop) as db:
            db.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, archived INTEGER, source TEXT, "
                       "rollout_path TEXT, first_user_message TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)")
            for thread in ["controller", "chat"]:
                rollout = self.root / f"{thread}.jsonl"
                rollout.write_text("")
                db.execute("INSERT INTO threads VALUES (?,?,?,0,'vscode',?,'',1,1)",
                           (thread, str(project), thread, str(rollout)))
        config = self.root / "config.json"
        config.write_text(json.dumps({"codex_bin": "codex", "lark_cli_bin": "lark", "allowed_sender_ids": ["owner"],
                                     "notification_destination": {"chat_id": "unused"}, "projects": {"demo": str(project)},
                                     "project_roots": {"demo": [str(project)]}, "sandbox": "workspace-write",
                                     "controller_thread_id": "controller", "controller_project_id": "p1",
                                     "controller_cwd": str(project), "desktop_state_path": str(self.state),
                                     "desktop_thread_db_path": str(self.desktop), "runtime_dir": str(self.root / "bot-runtime")}))
        self.api = adapter.Adapter({"bridgeSource": str(source), "bridgeConfig": str(config), "stateDirectory": str(self.root / "mobile")})
        self.addCleanup(self.api.db.close)

    def test_only_authorized_interactive_roots_are_exposed(self):
        self.assertEqual([x["threadId"] for x in self.api.directory()["threads"]], ["chat"])
        with sqlite3.connect(self.desktop) as db:
            db.execute("UPDATE threads SET source=? WHERE id='chat'", ('{"subagent":{"thread_spawn":{"parent_thread_id":"controller"}}}',))
        self.assertEqual(self.api.directory()["threads"], [])
        with self.assertRaises(ValueError):
            self.api.snapshot("chat")

    def test_roots_drift_revokes_read_and_write(self):
        data = json.loads(self.state.read_text())
        data["local-projects"]["p1"]["rootPaths"].append(str(self.root / "extra"))
        self.state.write_text(json.dumps(data))
        self.assertEqual(self.api.directory()["projects"], [])
        with self.assertRaises(ValueError):
            self.api.send({"threadId": "chat", "text": "test", "requestId": "a"})

    def test_send_is_durable_idempotent_and_uses_existing_writer(self):
        request = {"threadId": "chat", "text": "test", "requestId": "a"}
        with patch.object(adapter.subprocess, "run") as run:
            run.return_value.returncode = 0
            self.assertEqual(self.api.send(request)["status"], "queued")
            self.assertEqual(self.api.send(request)["status"], "queued")
            self.assertEqual(run.call_count, 1)
            command = run.call_args.args[0]
            self.assertEqual(command[:4], ["codex", "queue", "--thread", "chat"])
        with self.assertRaises(ValueError):
            self.api.send({**request, "text": "different"})

    def test_queue_timeout_never_replays(self):
        request = {"threadId": "chat", "text": "test", "requestId": "a"}
        with patch.object(adapter.subprocess, "run", side_effect=TimeoutError("timeout")) as run:
            self.assertEqual(self.api.send(request)["status"], "uncertain")
            self.assertEqual(self.api.send(request)["status"], "uncertain")
            self.assertEqual(run.call_count, 1)

    def test_mac_queue_loads_the_existing_desktop_thread_once(self):
        request = {"threadId": "chat", "text": "test", "requestId": "wake-a"}
        with patch.object(adapter.sys, "platform", "darwin"), patch.object(adapter.subprocess, "run") as run:
            run.return_value.returncode = 0
            self.api.send(request)
            self.api.send(request)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args.args[0], ["open", "-g", "codex://threads/chat"])

    def test_load_failure_retains_the_queue_and_does_not_send_again(self):
        def dispatch(command, **kwargs):
            if command[0] == "open":
                raise OSError("Desktop link unavailable")
            return subprocess_result
        from types import SimpleNamespace
        subprocess_result = SimpleNamespace(returncode=0)
        request = {"threadId": "chat", "text": "test", "requestId": "wake-failure"}
        with patch.object(adapter.sys, "platform", "darwin"), patch.object(adapter.subprocess, "run", side_effect=dispatch) as run:
            result = self.api.send(request)
            self.assertEqual(result["status"], "queued")
            self.assertIn("Desktop link unavailable", result["warning"])
            self.assertEqual(self.api.send(request), result)
            self.assertEqual(run.call_count, 2)

    def test_creation_recovers_target_and_verifies_exact_prompt(self):
        request = {"project": "demo", "text": "hello", "requestId": "create-a"}
        with patch.object(adapter.subprocess, "run") as run:
            run.return_value.returncode = 0
            job = self.api.create(request)
            self.api.create(request)
            self.assertEqual(run.call_count, 1)
        prompt = bridge.controller_task_prompt(job["job_id"], "hello")
        with sqlite3.connect(self.desktop) as db:
            db.execute("INSERT INTO threads SELECT 'target',cwd,'new',0,'vscode',rollout_path,?,1,1 FROM threads WHERE id='chat'", (prompt,))
        data = json.loads(self.state.read_text())
        data["thread-project-assignments"]["target"] = {"projectKind": "local", "projectId": "p1"}
        self.state.write_text(json.dumps(data))
        self.assertEqual(self.api.creation("create-a")["threadId"], "target")
        with sqlite3.connect(self.desktop) as db:
            db.execute("UPDATE threads SET first_user_message=? WHERE id='target'", (prompt + " changed",))
        # Force re-association as after a missing receipt, retaining the original expected hash.
        job.pop("threadId", None)
        self.api.save("create-a", job)
        with self.assertRaisesRegex(ValueError, "修改了"):
            self.api.creation("create-a")

    def test_creation_recovers_native_delegation_and_replays_initial_input(self):
        with patch.object(adapter.subprocess, "run") as run:
            run.return_value.returncode = 0
            job = self.api.create({"project": "demo", "text": "hello", "requestId": "delegate-a"})
        prompt = bridge.controller_task_prompt(job["job_id"], "hello")
        output = f"<codex_delegation><source_thread_id>controller</source_thread_id><input>{escape(prompt)}</input></codex_delegation>"
        events = [{"type": "session_meta", "payload": {"id": "target"}},
                  {"type": "response_item", "payload": {"type": "function_call_output", "namespace": "codex_app", "name": "create_thread", "output": output}},
                  {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t1"}},
                  {"type": "event_msg", "payload": {"type": "item_completed", "turn_id": "t1", "item": {
                      "type": "FunctionCallOutput", "id": "input", "namespace": "codex_app", "name": "create_thread", "output": output}}},
                  {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "t1"}}]
        rollout = self.root / "target.jsonl"
        rollout.write_text("\n".join(json.dumps(e) for e in events) + "\n")
        with sqlite3.connect(self.desktop) as db:
            db.execute("INSERT INTO threads SELECT 'target',cwd,'new',0,'vscode',?,'',?,? FROM threads WHERE id='chat'",
                       (str(rollout), job["created_after_ms"] + 1, job["created_after_ms"] + 1))
        state = json.loads(self.state.read_text())
        state["thread-project-assignments"]["target"] = {"projectKind": "local", "projectId": "p1"}
        self.state.write_text(json.dumps(state))
        self.assertEqual(self.api.creation("delegate-a")["threadId"], "target")
        snapshot = self.api.snapshot("target")
        self.assertEqual(snapshot["items"][0]["item"]["text"], "hello")
        self.assertEqual(snapshot["items"][0]["turnId"], "t1")

    def test_timeline_handles_current_events_and_partial_last_line(self):
        rollout = self.root / "chat.jsonl"
        events = [{"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t1"}},
                  {"type": "event_msg", "payload": {"type": "item_completed", "turn_id": "t1", "item": {
                      "type": "UserMessage", "id": "u1", "content": [{"text": "hello\n\n<!-- codex-lark-job:a -->"}]}}},
                  {"type": "event_msg", "payload": {"type": "item_completed", "turn_id": "t1", "item": {
                      "type": "AgentMessage", "id": "a1", "content": ["world"]}}},
                  {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "t1"}}]
        rollout.write_text("\n".join(json.dumps(e) for e in events) + '\n{"type":')
        snapshot = self.api.snapshot("chat")
        self.assertEqual(snapshot["turns"], {"t1": "completed"})
        self.assertEqual([x["item"]["text"] for x in snapshot["items"]], ["hello", "world"])

    def test_controller_recovery_can_read_beyond_chat_history_limit(self):
        events = [{"type": "event_msg", "payload": {"type": "agent_message", "message": str(i)}}
                  for i in range(160)]
        self.assertEqual(len(adapter.timeline(events)["items"]), 150)
        self.assertEqual(adapter.timeline(events, limit=None)["items"][0]["item"]["text"], "0")


if __name__ == "__main__":
    unittest.main()
