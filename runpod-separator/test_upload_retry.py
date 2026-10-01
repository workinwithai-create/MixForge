"""Upload retry behaviour. Runs without GPU deps: python3 runpod-separator/test_upload_retry.py"""
import sys
import tempfile
import types
import unittest
from pathlib import Path

fake_requests = types.ModuleType("requests")


class ConnectionError(Exception):
    pass


class Timeout(Exception):
    pass


class HTTPError(Exception):
    pass


fake_requests.ConnectionError = ConnectionError
fake_requests.Timeout = Timeout
sys.modules["requests"] = fake_requests
sys.modules["runpod"] = types.SimpleNamespace(serverless=types.SimpleNamespace(start=lambda *_: None))
sys.path.insert(0, str(Path(__file__).parent))
import handler  # noqa: E402


class Response:
    def __init__(self, status, text=""):
        self.status_code = status
        self.ok = 200 <= status < 300
        self.text = text

    def raise_for_status(self):
        if not self.ok:
            raise HTTPError(f"{self.status_code} Server Error")


def scripted(*outcomes):
    calls = []

    def put(url, data, headers, timeout):
        data.read()
        outcome = outcomes[len(calls)]
        calls.append(url)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    return put, calls


class UploadRetryTest(unittest.TestCase):
    def setUp(self):
        self.file = Path(tempfile.mkstemp(suffix=".wav")[1])
        self.file.write_bytes(b"RIFF" + b"\0" * 64)

    def run_upload(self, *outcomes):
        put, calls = scripted(*outcomes)
        fake_requests.put = put
        handler.upload("https://example/upload", self.file, sleep=lambda _: None)
        return calls

    def test_520_is_retried(self):
        self.assertEqual(len(self.run_upload(Response(520), Response(200))), 2)

    def test_connection_reset_is_retried(self):
        self.assertEqual(len(self.run_upload(ConnectionError("reset"), Response(200))), 2)

    def test_existing_object_after_retry_counts_as_uploaded(self):
        self.assertEqual(len(self.run_upload(Response(520), Response(400, '{"message":"The resource already exists"}'))), 2)

    def test_client_error_is_not_retried(self):
        with self.assertRaises(HTTPError):
            self.run_upload(Response(403))

    def test_gives_up_after_attempts(self):
        with self.assertRaises(HTTPError):
            self.run_upload(*[Response(520)] * handler.UPLOAD_ATTEMPTS)


if __name__ == "__main__":
    unittest.main()
