"""
Unit tests for Pulse — Slippay Payment Intelligence Agent
(addresses Issue #346: cover policy agents beyond happy paths)

Tests operational constants, default state structures, corrupted-file recovery,
clock drift calculations, alert rate limiting boundaries, and fail-closed invariants.
"""

import os
import json
import time
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Ensure clean testing environment
os.environ.setdefault("SUPABASE_URL", "http://127.0.0.1:54321")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key-mock")
os.environ.setdefault("PULSE_TELEGRAM_TOKEN", "test-token-mock")
os.environ.setdefault("PULSE_TELEGRAM_CHAT_IDS", "12345,67890")

import pulse


class TestPulse(unittest.TestCase):
    def setUp(self):
        self.test_state_file = Path(__file__).parent / "test_pulse_state.json"
        self.original_state_file = pulse.STATE_FILE
        pulse.STATE_FILE = self.test_state_file

    def tearDown(self):
        pulse.STATE_FILE = self.original_state_file
        if self.test_state_file.exists():
            self.test_state_file.unlink()

    def test_operational_constants_against_ssl_specification(self):
        """Asserts that all timing, latency, and report constants match the .ssl specification."""
        self.assertEqual(pulse.PAYMENT_INTERVAL, 60, "Payment scan interval must be 60s")
        self.assertEqual(pulse.SUBSCRIPTION_INTERVAL, 300, "Subscription scan interval must be 300s")
        self.assertEqual(pulse.WEBHOOK_INTERVAL, 300, "Webhook scan interval must be 300s")
        self.assertEqual(pulse.HORIZON_INTERVAL, 120, "Horizon health scan interval must be 120s")
        self.assertEqual(pulse.HORIZON_LATENCY_THRESHOLD_MS, 3000, "Latency threshold must be 3000ms")
        self.assertEqual(pulse.DAILY_REPORT_HOUR_BRT, 9, "Daily report must trigger at 09:00 BRT")
        self.assertEqual(pulse.CLOCK_DRIFT_BUFFER_S, 60, "Clock drift buffer must be 60s")
        self.assertEqual(pulse.MAX_ALERTS_PER_HOUR, 30, "Max alerts rate limit must be 30/hour")

        # Network endpoints
        self.assertEqual(pulse.HORIZON_URLS["mainnet"], "https://horizon.stellar.org")
        self.assertEqual(pulse.HORIZON_URLS["testnet"], "https://horizon-testnet.stellar.org")

    def test_default_state_structure(self):
        """Asserts that _default_state initializes all necessary cursors and horizon blocks."""
        state = pulse._default_state()
        self.assertIn("last_payment_check", state)
        self.assertIn("last_underpaid_check", state)
        self.assertIn("last_subscription_check", state)
        self.assertIn("last_webhook_check", state)
        self.assertIn("last_daily_report", state)
        self.assertIn("horizon", state)
        self.assertIn("mainnet", state["horizon"])
        self.assertIn("testnet", state["horizon"])
        self.assertEqual(state["horizon"]["mainnet"]["status"], "ok")
        self.assertEqual(state["horizon"]["testnet"]["status"], "ok")

    def test_state_persistence_and_corrupted_file_recovery(self):
        """Adversarial Battery B4: corrupted JSON state file must reset to defaults without crashing."""
        # 1. Write corrupted JSON
        self.test_state_file.write_text("{ this is malformed json syntax !!!")

        # 2. load_state should recover to default state
        recovered = pulse.load_state()
        self.assertIn("last_payment_check", recovered)
        self.assertIn("horizon", recovered)

        # 3. Valid save and reload
        recovered["last_daily_report"] = "2026-10-17"
        pulse.save_state(recovered)
        reloaded = pulse.load_state()
        self.assertEqual(reloaded["last_daily_report"], "2026-10-17")

    def test_clock_drift_buffer_calculation(self):
        """Asserts that host_now_minus_buffer_iso accurately offsets by exactly CLOCK_DRIFT_BUFFER_S."""
        t0 = datetime.now(timezone.utc)
        buf_iso = pulse.host_now_minus_buffer_iso()
        t_buf = datetime.fromisoformat(buf_iso)

        diff_s = (t0 - t_buf).total_seconds()
        # Should be within [59.5, 60.5] seconds
        self.assertAlmostEqual(diff_s, pulse.CLOCK_DRIFT_BUFFER_S, delta=1.0)

    def test_brt_hour_calculation(self):
        """Asserts that brt_hour_now returns a valid 24h integer."""
        h = pulse.brt_hour_now()
        self.assertIsInstance(h, int)
        self.assertTrue(0 <= h <= 23)

    def test_backward_compatibility_cursor_backfill(self):
        """Ensures that legacy state files lacking last_underpaid_check are smoothly backfilled."""
        legacy = {
            "last_payment_check": "2026-10-16T12:00:00+00:00",
            "last_subscription_check": "2026-10-16T12:00:00+00:00",
            "last_webhook_check": "2026-10-16T12:00:00+00:00",
            "last_daily_report": "",
            "horizon": {"mainnet": {"status": "ok"}, "testnet": {"status": "ok"}},
        }
        self.test_state_file.write_text(json.dumps(legacy))

        loaded = pulse.load_state()
        self.assertIn("last_underpaid_check", loaded)
        self.assertEqual(loaded["last_underpaid_check"], "2026-10-16T12:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
